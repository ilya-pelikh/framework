import express, { type Request } from "express"
import { access } from "node:fs/promises"
import { assertJson, escapeAttribute, serializePayload, type BrowserIsland, type Json } from "@islands/contracts"
import { RegistryStore } from "./registry.ts"
import { FragmentFetcher, type FetchLimits } from "./fetch.ts"
import { composeSlots } from "./compose.ts"
import { correlationId, correlationHeader, PipelineError, report, type Observability } from "./diagnostics.ts"
import { defaultAdmission, type AdmissionController } from "./admission.ts"
import type { ManifestCache } from "./manifest-cache.ts"
import type { ServiceCredentials } from "./boundary.ts"
export type { Diagnostic } from "./diagnostics.ts"

export interface Slot {
  name: string
  moduleId: string
  props: Json | ((request: Request) => Json)
  fallback: string
}
export interface HostOptions extends Observability {
  registryPath: string
  allowedOrigins: string[]
  routes: Record<string, Slot[]>
  bootstrapUrl: string
  requiredFiles?: string[]
  limits?: FetchLimits
  context?: (request: Request) => Record<string, Json>
  allowedContextKeys?: string[]
  shell?: (slots: Record<string, string>) => string
  admission?: AdmissionController
  manifestCache?: ManifestCache | false
  serviceCredentials?: ServiceCredentials
  signal?: AbortSignal
}
export function createHost(options: HostOptions) {
  const app = express()
  app.disable("x-powered-by")
  app.use((_req, res, next) => {
    if (options.signal?.aborted) res.status(503).json({ ok: false })
    else next()
  })
  const admission = options.admission ?? defaultAdmission
  const routes = Object.fromEntries(
    Object.entries(options.routes).map(([path, slots]) => {
      if (slots.length > admission.limits.maxSlots) throw new Error("Route exceeds slot limit")
      return [path, slots.map((slot) => Object.freeze({ ...slot }))]
    }),
  )
  const registry = new RegistryStore(options.registryPath, options.allowedOrigins)
  const fetcher = new FragmentFetcher(
    options.allowedOrigins,
    options.limits,
    admission,
    options.manifestCache,
    options.serviceCredentials,
  )
  const requests = new WeakMap<Request, { requestId: string; started: number }>()
  app.use((req, res, next) => {
    const requestId = correlationId()
    requests.set(req, { requestId, started: performance.now() })
    res.setHeader(correlationHeader, requestId)
    next()
  })
  const snapshot = (req: Request) => {
    const state = requests.get(req)!
    return registry
      .snapshot(() =>
        report(options, { requestId: state.requestId, role: "host" }, "registry", "protocol", state.started),
      )
      .catch(() => {
        throw new PipelineError("protocol", "registry")
      })
  }
  app.get("/healthz", (_req, res) => res.json({ ok: true }))
  app.get("/readyz", async (req, res) => {
    try {
      await snapshot(req)
      for (const path of options.requiredFiles ?? []) await access(path)
      res.json({ ok: true })
    } catch {
      res.status(503).json({ ok: false })
    }
  })
  app.get("/favicon.ico", (_req, res) => res.sendStatus(204))
  app.use(async (req, res, next) => {
    if (req.method !== "GET") {
      next()
      return
    }
    res.setHeader("Cache-Control", "no-store")
    const slots = routes[req.path]
    if (!Object.hasOwn(routes, req.path) || !slots) {
      res.status(404).type("html").send("<!doctype html><h1>Not found</h1>")
      return
    }
    const { requestId, started } = requests.get(req)!
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
    const reservations = new Set<() => void>()
    const releaseAll = () => {
      for (const release of reservations) release()
      reservations.clear()
    }
    const disconnect = () => {
      if (!res.writableEnded) controller.abort()
      releaseAll()
    }
    res.once("close", disconnect)
    res.once("finish", releaseAll)
    let pageStage: "request" | "composition" = "request"
    try {
      const selected = await snapshot(req)
      const rawContext = options.context?.(req) ?? {}
      const context: Record<string, Json> = {}
      for (const key of options.allowedContextKeys ?? []) {
        if (["cookie", "authorization", "cookies"].includes(key.toLowerCase())) continue
        if (Object.hasOwn(rawContext, key)) context[key] = rawContext[key]!
      }
      assertJson(context)
      const fragments = await Promise.all(
        slots.map(async (slot, index) => {
          const entry = selected[slot.moduleId]
          const slotStarted = performance.now()
          const identity = {
            requestId,
            role: "host" as const,
            moduleId: slot.moduleId,
            ...(entry ? { releaseId: entry.releaseId } : {}),
            slot: slot.name,
          }
          try {
            if (!entry) throw new PipelineError("identity", "registry")
            const props = typeof slot.props === "function" ? slot.props(req) : slot.props
            try {
              assertJson(props)
            } catch {
              throw new PipelineError("protocol", "request")
            }
            const result = await fetcher.render(
              entry,
              {
                protocolVersion: 1,
                moduleId: slot.moduleId,
                releaseId: entry.releaseId,
                instanceId: `r${requestId.replaceAll("-", "")}-${index}`,
                props,
                context,
              },
              signal,
              requestId,
              String(index),
            )
            if (signal.aborted || res.destroyed) result.release()
            else reservations.add(result.release)
            report(options, identity, "validation", "ok", slotStarted)
            return { slot, result }
          } catch (error) {
            const failure = error instanceof PipelineError ? error : new PipelineError("protocol", "request")
            report(options, identity, failure.stage, failure.category, slotStarted)
            return { slot, result: undefined }
          }
        }),
      )
      if (signal.aborted) {
        releaseAll()
        return
      }
      pageStage = "composition"
      const composition = composeSlots(
        fragments.map(({ slot, result }) => ({
          name: slot.name,
          html: result?.response.html ?? slot.fallback,
          fallback: slot.fallback,
          islands: result?.response.islands ?? [],
          failed: !result,
        })),
        options.shell,
      )
      const css = new Set<string>()
      const islands: BrowserIsland[] = []
      for (const [index, { slot, result }] of fragments.entries()) {
        if (composition.rejected.has(index)) {
          if (result)
            report(
              options,
              {
                requestId,
                role: "host",
                moduleId: slot.moduleId,
                releaseId: result.manifest.releaseId,
                slot: slot.name,
              },
              "composition",
              "html",
              started,
            )
          continue
        }
        if (!result) continue
        for (const island of result.response.islands) {
          const entry = result.manifest.islands[island.islandKey]!
          for (const url of entry.cssUrls) css.add(url)
          islands.push({
            ...island,
            moduleId: result.manifest.moduleId,
            releaseId: result.manifest.releaseId,
            clientEntryUrl: entry.clientEntryUrl,
          })
        }
      }
      const body = composition.body
      const links = [...css].map((url) => `<link rel="stylesheet" href="${escapeAttribute(url)}">`).join("")
      res
        .status(200)
        .type("html")
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Islands</title>${links}</head><body>${body}<script id="islands-payload" type="application/json">${serializePayload(islands)}</script><script type="module" src="${escapeAttribute(options.bootstrapUrl)}"></script></body></html>`,
        )
    } catch (error) {
      releaseAll()
      const failure =
        error instanceof PipelineError
          ? error
          : new PipelineError(pageStage === "composition" ? "html" : "protocol", pageStage)
      report(options, { requestId, role: "host" }, failure.stage, failure.category, started)
      if (!signal.aborted) res.status(500).type("html").send("<!doctype html><h1>Page unavailable</h1>")
    } finally {
      if (signal.aborted || res.destroyed) releaseAll()
    }
  })
  return app
}

import express, { type ErrorRequestHandler, type Request } from "express"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { serviceBoundary } from "./boundary.ts"
import { verifyPublication } from "@islands/contracts/integrity"
import { parseManifest, parseRenderRequest, parseRenderResponse, type Manifest } from "@islands/contracts"
import { validateFragment, type FragmentRenderer } from "./render.ts"
import {
  correlationHeader,
  correlationId,
  slotHeader,
  PipelineError,
  report,
  type ErrorCategory,
  type Stage,
  type Observability,
} from "./diagnostics.ts"

export interface ServiceRelease {
  manifest: Manifest
  assetsDirectory: string
  releaseDirectory: string
  render: FragmentRenderer
}
interface ReleaseState {
  release: ServiceRelease
  checked: number
  valid: boolean
  pending?: Promise<boolean>
}
export function createModuleService(
  options: Observability & {
    releases: ServiceRelease[]
    allowedHostOrigins: string[]
    invalidReleases?: string[]
    integrityCheckIntervalMs?: number
    integrityTimeoutMs?: number
    serviceTokens?: readonly string[]
  },
) {
  const app = express()
  app.disable("x-powered-by")
  if (options.serviceTokens !== undefined) app.use(serviceBoundary(options.serviceTokens))
  const releases = new Map<string, ReleaseState>()
  const requests = new WeakMap<Request, { requestId: string; started: number; slot?: string; releaseId?: string }>()
  app.use((req, res, next) => {
    const requestId = correlationId(req.get(correlationHeader))
    const slot = req.get(slotHeader)
    requests.set(req, {
      requestId,
      started: performance.now(),
      ...(slot && /^\d{1,3}$/.test(slot) ? { slot } : {}),
    })
    res.setHeader(correlationHeader, requestId)
    next()
  })
  const observe = (req: Request, stage: Stage, outcome: "ok" | ErrorCategory, releaseId?: string) => {
    const state = requests.get(req)!
    const selected = releaseId ?? state.releaseId
    const moduleId = selected ? releases.get(selected)?.release.manifest.moduleId : undefined
    report(
      options,
      {
        requestId: state.requestId,
        role: "service",
        ...(selected ? { releaseId: selected } : {}),
        ...(moduleId ? { moduleId } : {}),
        ...(state.slot ? { slot: state.slot } : {}),
      },
      stage,
      outcome,
      state.started,
    )
  }
  const interval = options.integrityCheckIntervalMs ?? 30000
  const timeout = options.integrityTimeoutMs ?? 10000
  for (const value of [interval, timeout])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid integrity limits")
  for (const release of options.releases) {
    parseManifest(release.manifest)
    if (releases.has(release.manifest.releaseId)) throw new Error("Duplicate release")
    releases.set(release.manifest.releaseId, {
      release,
      checked: -Infinity,
      valid: false,
    })
  }
  const invalid = new Set(options.invalidReleases ?? [])
  async function ready(releaseId: string): Promise<boolean> {
    if (invalid.has(releaseId)) return false
    const state = releases.get(releaseId)
    if (!state) return false
    if (state.pending) return state.pending
    if (performance.now() - state.checked < interval) return state.valid
    const { release } = state
    // Install the flight before validation can fail, including synchronous failures.
    state.pending = Promise.resolve().then(async () => {
      try {
        if (
          typeof release.render !== "function" ||
          resolve(release.assetsDirectory) !== resolve(release.releaseDirectory, "assets")
        )
          throw new Error("Invalid release configuration")
        const checked = await verifyPublication(release.releaseDirectory, release.manifest, timeout)
        if (!isDeepStrictEqual(checked.manifest, release.manifest)) throw new Error("Manifest configuration mismatch")
        state.valid = true
      } catch {
        state.valid = false
      } finally {
        state.checked = performance.now()
        delete state.pending
      }
      return state.valid
    })
    return state.pending
  }
  app.get("/healthz", (_req, res) => res.json({ ok: true }))
  const check = async (releaseId: string, req: Request) => {
    const ok = await ready(releaseId)
    observe(req, "integrity", ok ? "ok" : "integrity", releaseId)
    return ok
  }
  app.get("/readyz", async (req, res) => {
    const checks = await Promise.all([...releases.keys()].map((releaseId) => check(releaseId, req)))
    for (const releaseId of invalid) observe(req, "integrity", "integrity", releaseId)
    const ok = checks.length > 0 && invalid.size === 0 && checks.every(Boolean)
    res.status(ok ? 200 : 503).json({ ok })
  })
  app.get("/releases/:releaseId/readyz", async (req, res) => {
    const releaseId = req.params.releaseId
    if (!releases.has(releaseId) && !invalid.has(releaseId)) {
      res.status(404).json({ ok: false })
      return
    }
    const ok = await check(releaseId, req)
    res.status(ok ? 200 : 503).json({ ok })
  })
  for (const [releaseId, { release }] of releases) {
    const base = `/releases/${releaseId}`
    app.use(base, async (req, res, next) => {
      requests.get(req)!.releaseId = releaseId
      if (!(await check(releaseId, req))) {
        res.status(503).json({ error: "Release unavailable" })
        return
      }
      next()
    })
    app.get(`${base}/manifest.json`, (req, res) => {
      res.setHeader(
        "Cache-Control",
        `${options.serviceTokens === undefined ? "public" : "private"}, max-age=31536000, immutable`,
      )
      res.json(release.manifest)
      observe(req, "manifest", "ok")
    })
    app.use(
      `${base}/assets`,
      (req, res, next) => {
        const origin = req.get("origin")
        if (origin && options.allowedHostOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin)
        res.vary("Origin")
        next()
      },
      express.static(resolve(release.assetsDirectory), {
        immutable: true,
        maxAge: "1y",
        dotfiles: "deny",
        fallthrough: false,
      }),
    )
    app.post(`${base}/render`, express.json({ limit: "1mb" }), (req, res) => {
      res.setHeader("Cache-Control", "no-store")
      let input
      try {
        try {
          input = parseRenderRequest(req.body)
        } catch {
          throw new PipelineError("protocol", "request")
        }
        if (input.moduleId !== release.manifest.moduleId || input.releaseId !== releaseId)
          throw new PipelineError("identity", "request")
      } catch (error) {
        observe(req, "request", error instanceof PipelineError ? error.category : "protocol")
        res.status(400).json({ error: "Invalid render request" })
        return
      }
      try {
        let rawResponse
        try {
          rawResponse = release.render(input)
        } catch {
          throw new PipelineError("render", "render")
        }
        let response
        try {
          response = parseRenderResponse(rawResponse)
        } catch {
          throw new PipelineError("protocol", "validation")
        }
        if (response.moduleId !== input.moduleId || response.releaseId !== input.releaseId)
          throw new PipelineError("identity", "validation")
        try {
          validateFragment(response, release.manifest, input.instanceId)
        } catch {
          throw new PipelineError("html", "validation")
        }
        res.json(response)
        observe(req, "render", "ok")
      } catch (error) {
        const failure = error instanceof PipelineError ? error : new PipelineError("render", "render")
        observe(req, failure.stage, failure.category)
        res.status(500).json({ error: "Render failed" })
      }
    })
  }
  app.use("/releases/:releaseId", (req, res, next) => {
    if (invalid.has(req.params.releaseId)) {
      observe(req, "integrity", "integrity", req.params.releaseId)
      res.status(503).json({ error: "Release unavailable" })
      return
    }
    next()
  })
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    const status = error.status === 413 ? 413 : error.status === 404 ? 404 : error.status === 400 ? 400 : 500
    res.status(status).json({ error: "Request failed" })
    observe(req, "request", status === 413 ? "oversized" : status === 400 ? "protocol" : "http")
  }
  app.use(errors)
  return app
}

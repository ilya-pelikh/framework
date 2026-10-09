import {
  parseRenderResponse,
  type Manifest,
  type Registry,
  type RenderRequest,
  type RenderResponse,
} from "@islands/contracts"
import { validateFragment } from "./render.ts"
import { PipelineError, correlationHeader, correlationId, slotHeader, type Stage } from "./diagnostics.ts"
import { defaultAdmission, type AdmissionController } from "./admission.ts"
import { defaultManifestCache, validatedManifest, type ManifestCache } from "./manifest-cache.ts"
import type { ServiceCredentials } from "./boundary.ts"

export interface FetchLimits {
  timeoutMs?: number
  manifestBytes?: number
  renderBytes?: number
}
export class FragmentFetcher {
  constructor(
    readonly origins: readonly string[],
    readonly limits: FetchLimits = {},
    readonly admission: AdmissionController = defaultAdmission,
    readonly manifestCache: ManifestCache | false = defaultManifestCache,
    readonly credentials?: ServiceCredentials,
  ) {
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error("Invalid fetch limit")
  }
  allowed(address: string, origins = this.origins) {
    try {
      const parsed = new URL(address)
      if (
        !origins.includes(parsed.origin) ||
        parsed.username ||
        parsed.password ||
        !["http:", "https:"].includes(parsed.protocol)
      )
        throw new Error()
    } catch {
      throw new PipelineError("identity", "manifest")
    }
  }
  async json(
    address: string,
    maxBytes: number,
    signal: AbortSignal,
    body?: unknown,
    requestId?: string,
    slot?: string,
    origins = this.origins,
  ): Promise<unknown> {
    const stage = body === undefined ? "manifest" : "render"
    try {
      this.allowed(address, origins)
      const response = await fetch(address, {
        redirect: "error",
        signal,
        headers: {
          ...this.credentials?.headers(address),
          ...(requestId ? { [correlationHeader]: correlationId(requestId) } : {}),
          ...(slot && /^\d{1,3}$/.test(slot) ? { [slotHeader]: slot } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      })
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel()
        throw new PipelineError(response.ok ? "protocol" : "http", stage)
      }
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel()
        throw new PipelineError("oversized", stage)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new PipelineError("protocol", stage)
      let size = 0
      const chunks: Uint8Array[] = []
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > maxBytes) throw new PipelineError("oversized", stage)
          chunks.push(value)
        }
      } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
      } finally {
        reader.releaseLock()
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        throw new PipelineError("protocol", stage)
      }
    } catch (error) {
      if (signal.aborted)
        throw new PipelineError(
          signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "disconnect",
          stage,
        )
      if (error instanceof PipelineError) throw error
      throw new PipelineError("transport", stage)
    }
  }
  async render(
    entry: Registry[string],
    request: RenderRequest,
    disconnected: AbortSignal,
    requestId?: string,
    slot?: string,
  ): Promise<{
    manifest: Manifest
    response: RenderResponse
    release: () => void
  }> {
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error("Invalid fetch limit")
    const origins = Object.freeze([...this.origins])
    const deadline = AbortSignal.timeout(this.limits.timeoutMs ?? 1500)
    const signal = AbortSignal.any([disconnected, deadline])
    let stage: Stage = "admission"
    let release: (() => void) | undefined
    try {
      release = await this.admission.acquire(
        request.moduleId,
        (this.limits.manifestBytes ?? 64 * 1024) + (this.limits.renderBytes ?? 1024 * 1024),
        signal,
      )
      stage = "manifest"
      this.allowed(entry.manifestUrl, origins)
      if (
        new URL(entry.manifestUrl).pathname !== `/releases/${entry.releaseId}/manifest.json` ||
        request.releaseId !== entry.releaseId
      )
        throw new PipelineError("identity", stage)
      const identity = {
        moduleId: request.moduleId,
        releaseId: entry.releaseId,
        url: entry.manifestUrl,
        origins,
        maxBytes: this.limits.manifestBytes ?? 64 * 1024,
      }
      const loader = (upstream: AbortSignal, traceId: string) =>
        this.json(identity.url, identity.maxBytes, upstream, undefined, traceId, undefined, origins)
      const manifest = this.manifestCache
        ? await this.manifestCache.get(identity, signal, loader)
        : validatedManifest(await loader(signal, correlationId(requestId)), identity)
      stage = "render"
      const rawResponse = await this.json(
        manifest.renderUrl,
        this.limits.renderBytes ?? 1024 * 1024,
        signal,
        request,
        requestId,
        slot,
        origins,
      )
      let response: RenderResponse
      try {
        response = parseRenderResponse(rawResponse)
      } catch {
        throw new PipelineError("protocol", stage)
      }
      if (response.moduleId !== request.moduleId || response.releaseId !== entry.releaseId)
        throw new PipelineError("identity", stage)
      stage = "validation"
      try {
        validateFragment(response, manifest, request.instanceId)
      } catch {
        throw new PipelineError("html", stage)
      }
      signal.throwIfAborted()
      return { manifest, response, release }
    } catch (error) {
      release?.()
      if (disconnected.aborted) throw new PipelineError("disconnect", stage)
      if (deadline.aborted) throw new PipelineError("timeout", stage)
      if (error instanceof PipelineError) throw error
      throw new PipelineError("transport", stage)
    }
  }
}

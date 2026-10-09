import { parseManifest, type Manifest } from "@islands/contracts"
import { correlationId, PipelineError } from "./diagnostics.ts"

export interface ManifestIdentity {
  moduleId: string
  releaseId: string
  url: string
  origins: readonly string[]
  maxBytes: number
}
export interface ManifestCacheLimits {
  maxEntries?: number
  maxBytes?: number
  ttlMs?: number
  loadTimeoutMs?: number
}
export function validatedManifest(raw: unknown, identity: ManifestIdentity): Manifest {
  let parsed: Manifest
  try {
    parsed = parseManifest(raw)
  } catch {
    throw new PipelineError("protocol", "manifest")
  }
  if (parsed.moduleId !== identity.moduleId || parsed.releaseId !== identity.releaseId)
    throw new PipelineError("identity", "manifest")
  for (const url of [
    parsed.renderUrl,
    ...Object.values(parsed.islands).flatMap((island) => [island.clientEntryUrl, ...island.cssUrls]),
  ]) {
    if (!identity.origins.includes(new URL(url).origin)) throw new PipelineError("identity", "manifest")
  }
  const manifest: Manifest = {
    protocolVersion: 1,
    moduleId: parsed.moduleId,
    releaseId: parsed.releaseId,
    renderUrl: parsed.renderUrl,
    reactVersion: parsed.reactVersion,
    islands: Object.fromEntries(
      Object.entries(parsed.islands).map(([key, value]) => [
        key,
        { clientEntryUrl: value.clientEntryUrl, cssUrls: [...value.cssUrls] },
      ]),
    ),
  }
  for (const island of Object.values(manifest.islands)) {
    Object.freeze(island.cssUrls)
    Object.freeze(island)
  }
  Object.freeze(manifest.islands)
  return Object.freeze(manifest)
}
interface Flight {
  controller: AbortController
  consumers: number
  promise: Promise<Manifest>
}
export class ManifestCache {
  readonly limits: Readonly<Required<ManifestCacheLimits>>
  #entries = new Map<string, { manifest: Manifest; bytes: number; expires: number }>()
  #pending = new Map<string, Flight>()
  #bytes = 0
  constructor(limits: ManifestCacheLimits = {}) {
    this.limits = Object.freeze({
      maxEntries: 256,
      maxBytes: 16 * 1024 * 1024,
      ttlMs: 300000,
      loadTimeoutMs: 1500,
      ...limits,
    })
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
        throw new Error("Invalid manifest cache limit")
  }
  #remove(key: string) {
    const entry = this.#entries.get(key)
    if (entry) {
      this.#bytes -= entry.bytes
      this.#entries.delete(key)
    }
  }
  #expire() {
    for (const [key, entry] of this.#entries) if (entry.expires <= performance.now()) this.#remove(key)
  }
  snapshot() {
    this.#expire()
    return Object.freeze({
      entries: this.#entries.size,
      bytes: this.#bytes,
      pending: this.#pending.size,
    })
  }
  async get(
    identity: ManifestIdentity,
    signal: AbortSignal,
    loader: (signal: AbortSignal, requestId: string) => Promise<unknown>,
  ): Promise<Manifest> {
    identity = { ...identity, origins: [...identity.origins] }
    signal.throwIfAborted()
    this.#expire()
    const key = JSON.stringify([
      identity.moduleId,
      identity.releaseId,
      identity.url,
      [...identity.origins].sort(),
      identity.maxBytes,
    ])
    const cached = this.#entries.get(key)
    if (cached) {
      this.#entries.delete(key)
      this.#entries.set(key, cached)
      return cached.manifest
    }
    let flight = this.#pending.get(key)
    if (!flight) {
      const controller = new AbortController()
      const upstream = AbortSignal.any([controller.signal, AbortSignal.timeout(this.limits.loadTimeoutMs)])
      const current: Flight = {
        controller,
        consumers: 0,
        promise: Promise.resolve()
          .then(() => loader(upstream, correlationId()))
          .then((raw) => {
            upstream.throwIfAborted()
            const manifest = validatedManifest(raw, identity)
            const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(manifest))
            if (bytes <= this.limits.maxBytes) {
              this.#expire()
              while (this.#entries.size >= this.limits.maxEntries || this.#bytes + bytes > this.limits.maxBytes)
                this.#remove(this.#entries.keys().next().value!)
              this.#entries.set(key, {
                manifest,
                bytes,
                expires: performance.now() + this.limits.ttlMs,
              })
              this.#bytes += bytes
            }
            return manifest
          })
          .finally(() => {
            if (this.#pending.get(key) === current) this.#pending.delete(key)
          }),
      }
      flight = current
      this.#pending.set(key, current)
    }
    const current = flight
    current.consumers++
    return new Promise<Manifest>((done, reject) => {
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", abort)
        current.consumers--
        if (!current.consumers && this.#pending.get(key) === current) {
          this.#pending.delete(key)
          current.controller.abort()
        }
        action()
      }
      const abort = () => finish(() => reject(signal.reason))
      signal.addEventListener("abort", abort, { once: true })
      current.promise.then(
        (manifest) => finish(() => done(manifest)),
        (error) => finish(() => reject(error)),
      )
      if (signal.aborted) abort()
    })
  }
}
export const defaultManifestCache = new ManifestCache()

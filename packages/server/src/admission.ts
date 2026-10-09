import { PipelineError } from "./diagnostics.ts"

export interface AdmissionLimits {
  maxSlots?: number
  maxActive?: number
  maxPerModule?: number
  maxQueue?: number
  maxResponseBytes?: number
}
interface Waiter {
  moduleId: string
  bytes: number
  signal: AbortSignal
  done: (release: () => void) => void
  abort: () => void
}
export class AdmissionController {
  readonly limits: Readonly<Required<AdmissionLimits>>
  #active = 0
  #bytes = 0
  #modules = new Map<string, number>()
  #queue: Waiter[] = []
  constructor(limits: AdmissionLimits = {}) {
    this.limits = Object.freeze({
      maxSlots: 32,
      maxActive: 64,
      maxPerModule: 8,
      maxQueue: 0,
      maxResponseBytes: 64 * 1024 * 1024,
      ...limits,
    })
    for (const [key, value] of Object.entries(this.limits))
      if (!Number.isSafeInteger(value) || value < (key === "maxQueue" ? 0 : 1))
        throw new Error("Invalid admission limit")
  }
  snapshot() {
    return Object.freeze({
      active: this.#active,
      queued: this.#queue.length,
      reservedBytes: this.#bytes,
      modules: this.#modules.size,
    })
  }
  #available(moduleId: string, bytes: number) {
    return (
      this.#active < this.limits.maxActive &&
      (this.#modules.get(moduleId) ?? 0) < this.limits.maxPerModule &&
      this.#bytes + bytes <= this.limits.maxResponseBytes
    )
  }
  #reserve(moduleId: string, bytes: number) {
    this.#active++
    this.#bytes += bytes
    this.#modules.set(moduleId, (this.#modules.get(moduleId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active--
      this.#bytes -= bytes
      const count = this.#modules.get(moduleId)! - 1
      if (count) this.#modules.set(moduleId, count)
      else this.#modules.delete(moduleId)
      this.#drain()
    }
  }
  #drain() {
    for (const waiter of [...this.#queue]) {
      if (!this.#available(waiter.moduleId, waiter.bytes)) continue
      this.#queue.splice(this.#queue.indexOf(waiter), 1)
      waiter.signal.removeEventListener("abort", waiter.abort)
      waiter.done(this.#reserve(waiter.moduleId, waiter.bytes))
    }
  }
  async acquire(moduleId: string, bytes: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.limits.maxResponseBytes)
      throw new PipelineError("overload", "admission")
    if (this.#available(moduleId, bytes)) return this.#reserve(moduleId, bytes)
    if (this.#queue.length >= this.limits.maxQueue) throw new PipelineError("overload", "admission")
    return new Promise((done, reject) => {
      const waiter: Waiter = {
        moduleId,
        bytes,
        signal,
        done,
        abort: () => {
          this.#queue.splice(this.#queue.indexOf(waiter), 1)
          signal.removeEventListener("abort", waiter.abort)
          reject(signal.reason)
        },
      }
      this.#queue.push(waiter)
      signal.addEventListener("abort", waiter.abort, { once: true })
    })
  }
}
export const defaultAdmission = new AdmissionController()

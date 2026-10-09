import { randomUUID } from "node:crypto"

export type ErrorCategory =
  | "timeout"
  | "disconnect"
  | "transport"
  | "http"
  | "oversized"
  | "protocol"
  | "identity"
  | "html"
  | "overload"
  | "render"
  | "integrity"
export type Stage =
  "request" | "registry" | "admission" | "manifest" | "render" | "validation" | "composition" | "integrity"
export interface Diagnostic {
  requestId: string
  moduleId?: string
  releaseId?: string
  slot?: string
  role: "host" | "service"
  category: ErrorCategory
  stage: Stage
  durationMs: number
}
export interface Metric {
  name: "pipeline"
  value: 1
  durationMs: number
  labels: Readonly<{
    role: "host" | "service"
    stage: Stage
    outcome: "ok" | ErrorCategory
  }>
}
export interface Observability {
  onDiagnostic?: (event: Diagnostic) => void
  onMetric?: (metric: Metric) => void
}
export const correlationHeader = "x-islands-request-id"
export const slotHeader = "x-islands-slot"
export function correlationId(value?: string): string {
  return value && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
    ? value
    : randomUUID()
}
export class PipelineError extends Error {
  constructor(
    readonly category: ErrorCategory,
    readonly stage: Stage,
  ) {
    super(category === "oversized" ? "Response limit" : category)
  }
}
export function report(
  options: Observability,
  identity: Pick<Diagnostic, "requestId" | "role" | "moduleId" | "releaseId" | "slot">,
  stage: Stage,
  outcome: "ok" | ErrorCategory,
  started: number,
) {
  const durationMs = Math.max(0, Math.round((performance.now() - started) * 1000) / 1000)
  const labels = Object.freeze({ role: identity.role, stage, outcome })
  try {
    void Promise.resolve(options.onMetric?.(Object.freeze({ name: "pipeline", value: 1, durationMs, labels }))).catch(
      () => {},
    )
  } catch {}
  if (outcome === "ok") return
  const event: Diagnostic = {
    requestId: identity.requestId,
    role: identity.role,
    stage,
    category: outcome,
    durationMs,
  }
  for (const key of ["moduleId", "releaseId", "slot"] as const) {
    const value = identity[key]
    if (value && /^[A-Za-z0-9_-]{1,128}$/.test(value)) event[key] = value
  }
  try {
    void Promise.resolve(options.onDiagnostic?.(Object.freeze(event))).catch(() => {})
  } catch {}
}

export const scenarios = ["normal", "burst", "soak", "outage", "disconnect"] as const
export type Scenario = (typeof scenarios)[number]
export const budgetNames = [
  "latencyP95Ms",
  "latencyP99Ms",
  "rssBytes",
  "eventLoopP99Ms",
  "connections",
  "fallbackRate",
  "errorRate",
  "browserTransferBytes",
  "hydrationMs",
  "cls",
] as const
export type Budgets = Record<(typeof budgetNames)[number], number>
export interface QualificationProfile {
  schemaVersion: 1
  purpose: "target" | "local-smoke"
  environment: {
    name: string
    baseUrl: string
    assetOrigins: string[]
    deploymentProfileSha256: string
  }
  identity: { commit: string; artifacts: { name: string; sha256: string }[] }
  approval: { frozenAt: string; approvedBy: string; evidence: string }
  owners: {
    environment: string
    release: string
    security: string
    onCall: string
  }
  operations: {
    runbookRecord: string
    retentionMs: number
    pageLifetimeMs: number
    rollbackWindowMs: number
    propagationMs: number
    clockMarginMs: number
  }
  workload: Record<
    Scenario,
    {
      rps: number
      concurrency: number
      durationMs: number
      requestTimeoutMs: number
      disconnectAfterMs: number
      routes: {
        path: string
        weight: number
        slots: number
        payloadBytes: number
      }[]
    }
  >
  devices: {
    name: string
    viewport: { width: number; height: number }
    deviceScaleFactor: number
    cpuSlowdown: number
    mobile: boolean
  }[]
  networks: {
    name: string
    latencyMs: number
    downloadBytesPerSecond: number
    uploadBytesPerSecond: number
  }[]
  thresholds: Record<Scenario, Budgets>
}

type Schema = {
  type?: string
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  items?: Schema
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  pattern?: string
  enum?: readonly unknown[]
  const?: unknown
  $schema?: string
  title?: string
}
const text: Schema = { type: "string", minLength: 1, maxLength: 512 }
const positive: Schema = {
  type: "number",
  minimum: Number.MIN_VALUE,
  maximum: Number.MAX_SAFE_INTEGER,
}
const integer: Schema = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
}
const nonnegative: Schema = { ...integer, minimum: 0 }
const sha: Schema = { type: "string", pattern: "^[a-f0-9]{64}$" }
const object = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})
const array = (items: Schema, maxItems = 64): Schema => ({
  type: "array",
  items,
  minItems: 1,
  maxItems,
})
const budgets = object(
  Object.fromEntries(
    budgetNames.map((name) => [
      name,
      {
        type: "number",
        minimum: 0,
        maximum: ["fallbackRate", "errorRate", "cls"].includes(name) ? 1 : Number.MAX_SAFE_INTEGER,
      },
    ]),
  ),
)
const workload = object({
  rps: positive,
  concurrency: integer,
  durationMs: integer,
  requestTimeoutMs: integer,
  disconnectAfterMs: integer,
  routes: array(
    object({
      path: text,
      weight: integer,
      slots: integer,
      payloadBytes: nonnegative,
    }),
  ),
})
export const qualificationSchema: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Islands qualification profile v1",
  ...object({
    schemaVersion: { const: 1 },
    purpose: { enum: ["target", "local-smoke"] },
    environment: object({
      name: text,
      baseUrl: text,
      assetOrigins: array(text),
      deploymentProfileSha256: sha,
    }),
    identity: object({
      commit: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
      artifacts: array(object({ name: text, sha256: sha }), 1024),
    }),
    approval: object({ frozenAt: text, approvedBy: text, evidence: text }),
    owners: object({
      environment: text,
      release: text,
      security: text,
      onCall: text,
    }),
    operations: object({
      runbookRecord: text,
      retentionMs: integer,
      pageLifetimeMs: integer,
      rollbackWindowMs: integer,
      propagationMs: nonnegative,
      clockMarginMs: nonnegative,
    }),
    workload: object(Object.fromEntries(scenarios.map((name) => [name, workload]))),
    devices: array(
      object({
        name: text,
        viewport: object({ width: integer, height: integer }),
        deviceScaleFactor: positive,
        cpuSlowdown: { ...positive, minimum: 1 },
        mobile: { type: "boolean" },
      }),
    ),
    networks: array(
      object({
        name: text,
        latencyMs: nonnegative,
        downloadBytesPerSecond: positive,
        uploadBytesPerSecond: positive,
      }),
    ),
    thresholds: object(Object.fromEntries(scenarios.map((name) => [name, budgets]))),
  }),
}

function check(schema: Schema, value: unknown, path: string, errors: string[]): void {
  const fail = () => {
    errors.push(path)
  }
  if ("const" in schema && value !== schema.const) return fail()
  if (schema.enum && !schema.enum.includes(value)) return fail()
  if (!schema.type) return
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail()
    const record = value as Record<string, unknown>
    if (Object.keys(record).some((key) => !Object.hasOwn(schema.properties!, key))) fail()
    for (const [key, child] of Object.entries(schema.properties!)) check(child, record[key], `${path}.${key}`, errors)
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < schema.minItems! || value.length > schema.maxItems!) return fail()
    value.forEach((entry, index) => check(schema.items!, entry, `${path}[${index}]`, errors))
  } else if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? 512) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    )
      fail()
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail()
  } else if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (schema.type === "integer" && !Number.isSafeInteger(value)) ||
    value < schema.minimum! ||
    value > schema.maximum!
  )
    fail()
}

export function validateQualificationProfile(input: unknown): {
  valid: boolean
  status: "profile-valid" | "not-qualified"
  productionQualified: false
  errors: string[]
} {
  const errors: string[] = []
  check(qualificationSchema, input, "profile", errors)
  if (errors.length === 0) {
    const profile = input as QualificationProfile
    const url = (value: string, path: string, originOnly: boolean) => {
      try {
        const parsed = new URL(value)
        if (
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          !["http:", "https:"].includes(parsed.protocol) ||
          (profile.purpose === "target" && parsed.protocol !== "https:") ||
          (originOnly && parsed.origin !== value)
        )
          throw new Error()
      } catch {
        errors.push(path)
      }
    }
    url(profile.environment.baseUrl, "profile.environment.baseUrl", true)
    profile.environment.assetOrigins.forEach((value, index) =>
      url(value, `profile.environment.assetOrigins[${index}]`, true),
    )
    const unique = (values: string[], path: string) => {
      if (new Set(values).size !== values.length) errors.push(path)
    }
    unique(profile.environment.assetOrigins, "profile.environment.assetOrigins")
    unique(
      profile.identity.artifacts.map((value) => value.name),
      "profile.identity.artifacts",
    )
    unique(
      profile.devices.map((value) => value.name),
      "profile.devices",
    )
    unique(
      profile.networks.map((value) => value.name),
      "profile.networks",
    )
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(profile.approval.frozenAt) ||
      !Number.isFinite(Date.parse(profile.approval.frozenAt)) ||
      new Date(profile.approval.frozenAt).toISOString() !== profile.approval.frozenAt
    )
      errors.push("profile.approval.frozenAt")
    const op = profile.operations
    const minimumRetention = Math.max(op.pageLifetimeMs, op.rollbackWindowMs) + op.propagationMs + op.clockMarginMs
    if (!Number.isSafeInteger(minimumRetention) || op.retentionMs < minimumRetention)
      errors.push("profile.operations.retentionMs")
    for (const scenario of scenarios) {
      const load = profile.workload[scenario]
      if (load.disconnectAfterMs >= load.requestTimeoutMs) errors.push(`profile.workload.${scenario}.disconnectAfterMs`)
      if (
        (load.durationMs * load.rps) / 1000 < 1 ||
        !Number.isSafeInteger(Math.ceil((load.durationMs * load.rps) / 1000))
      )
        errors.push(`profile.workload.${scenario}.durationMs`)
      load.routes.forEach((route, index) => {
        if (
          !route.path.startsWith("/") ||
          route.path.startsWith("//") ||
          /[?#\\\s]/.test(route.path) ||
          new URL(route.path, profile.environment.baseUrl).origin !== profile.environment.baseUrl
        )
          errors.push(`profile.workload.${scenario}.routes[${index}].path`)
      })
      if (profile.thresholds[scenario].latencyP95Ms > profile.thresholds[scenario].latencyP99Ms)
        errors.push(`profile.thresholds.${scenario}.latencyP95Ms`)
    }
  }
  return {
    valid: errors.length === 0,
    status: errors.length ? "not-qualified" : "profile-valid",
    productionQualified: false,
    errors,
  }
}

export function parseQualificationProfile(input: unknown): QualificationProfile {
  const result = validateQualificationProfile(input)
  if (!result.valid) throw new Error(`Invalid qualification profile: ${result.errors.join(", ")}`)
  return structuredClone(input as QualificationProfile)
}

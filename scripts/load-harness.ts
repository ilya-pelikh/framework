import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import {
  parseQualificationProfile,
  validateQualificationProfile,
  scenarios,
  budgetNames,
  type Budgets,
  type QualificationProfile,
  type Scenario,
} from "./qualification.ts"

export interface ServerSample {
  rssBytes: number
  eventLoopP99Ms: number
  connections: number
}
export interface BrowserSample {
  browserTransferBytes: number
  hydrationMs: number
  cls: number
  errors: number
  browserVersion: string
}
export interface LoadAdapter {
  // Hooks implement environment-specific telemetry and reversible fault injection.
  // begin must confirm the profile's actual artifact identity and synthetic route mix.
  begin(
    profile: QualificationProfile,
    signal: AbortSignal,
  ): Promise<{
    identity: QualificationProfile["identity"]
    deploymentProfileSha256: string
    workloadVerified: boolean
    serverVersions: Record<string, string>
  }>
  enter(scenario: Scenario, signal: AbortSignal): Promise<void>
  restore(scenario: Scenario, signal: AbortSignal): Promise<void>
  sample(signal: AbortSignal): Promise<ServerSample>
  classify(status: number, body: string): { fallback: boolean; error: boolean }
  browser(
    scenario: Scenario,
    route: string,
    device: QualificationProfile["devices"][number],
    network: QualificationProfile["networks"][number],
    signal: AbortSignal,
  ): Promise<BrowserSample>
}
export interface ScenarioResult {
  scenario: Scenario
  scheduled: number
  started: number
  completed: number
  dropped: number
  disconnected: number
  fallbacks: number
  errors: number
  telemetrySamples: number
  durationMs: number
  measurements: Budgets
  violations: string[]
  browsers: {
    device: string
    network: string
    path: string
    result: BrowserSample
  }[]
}

const hookTimeoutMs = 30000
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs = hookTimeoutMs): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error("Harness hook deadline"))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
  }
}
const finite = (value: number) => Number.isFinite(value) && value >= 0
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex")

export function budgetViolations(measured: Budgets, limits: Budgets): string[] {
  return budgetNames.filter((name) => !finite(measured[name]) || measured[name] > limits[name])
}

async function responseText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.length
      if (bytes > 2 * 1024 * 1024) throw new Error("Harness response limit")
      chunks.push(part.value)
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function runScenario(
  profile: QualificationProfile,
  scenario: Scenario,
  adapter: LoadAdapter,
): Promise<ScenarioResult> {
  const load = profile.workload[scenario]
  const result: ScenarioResult = {
    scenario,
    scheduled: 0,
    started: 0,
    completed: 0,
    dropped: 0,
    disconnected: 0,
    fallbacks: 0,
    errors: 0,
    telemetrySamples: 0,
    durationMs: 0,
    measurements: Object.fromEntries(budgetNames.map((name) => [name, 0])) as Budgets,
    violations: [],
    browsers: [],
  }
  // 1 ms histogram uses bounded memory and reports conservative upper edges.
  const histogram = new Uint32Array(load.requestTimeoutMs + 1002)
  let totalLatency = 0
  let latencyOverflow = false
  const pending = new Set<Promise<void>>()
  const totalWeight = load.routes.reduce((sum, route) => sum + route.weight, 0)
  let routePosition = 0
  const request = async () => {
    let cursor = routePosition++ % totalWeight
    const route = load.routes.find((route) => {
      cursor -= route.weight
      return cursor < 0
    })!
    const controller = new AbortController()
    const start = performance.now()
    let disconnected = false
    const timer = setTimeout(() => controller.abort(), load.requestTimeoutMs)
    const disconnect =
      scenario === "disconnect"
        ? setTimeout(() => {
            disconnected = true
            controller.abort()
          }, load.disconnectAfterMs)
        : undefined
    try {
      const response = await fetch(new URL(route.path, profile.environment.baseUrl), {
        signal: controller.signal,
        redirect: "error",
        headers: { accept: "text/html" },
      })
      const classification = adapter.classify(response.status, await responseText(response))
      if (classification.fallback) result.fallbacks++
      if (classification.error) result.errors++
      result.completed++
    } catch {
      if (disconnected) result.disconnected++
      else result.errors++
    } finally {
      clearTimeout(timer)
      if (disconnect) clearTimeout(disconnect)
      const elapsed = Math.ceil(performance.now() - start)
      if (elapsed >= histogram.length) latencyOverflow = true
      histogram[Math.min(elapsed, histogram.length - 1)]!++
      totalLatency++
    }
  }
  const sample = async () => {
    const value = await bounded((signal) => adapter.sample(signal), 5000)
    if (
      !Object.values(value).every(finite) ||
      !["rssBytes", "eventLoopP99Ms", "connections"].every((key) => Object.hasOwn(value, key))
    )
      throw new Error("Invalid server telemetry")
    result.telemetrySamples++
    for (const key of ["rssBytes", "eventLoopP99Ms", "connections"] as const)
      result.measurements[key] = Math.max(result.measurements[key], value[key])
  }
  await sample()
  let sampling = true
  let sampleFailed = false
  const sampler = (async () => {
    while (sampling) {
      await delay(50)
      if (!sampling) break
      try {
        await sample()
      } catch {
        sampleFailed = true
        break
      }
    }
  })()
  const start = performance.now()
  const expected = Math.ceil((load.durationMs * load.rps) / 1000)
  try {
    while (performance.now() - start < load.durationMs) {
      const due = Math.min(expected, Math.floor(((performance.now() - start) * load.rps) / 1000) + 1)
      while (result.scheduled < due) {
        result.scheduled++
        if (pending.size >= load.concurrency) {
          result.dropped++
          continue
        }
        result.started++
        const running = request().finally(() => pending.delete(running))
        pending.add(running)
      }
      await delay(Math.min(10, 1000 / load.rps))
    }
    result.dropped += expected - result.scheduled
    result.scheduled = expected
    await Promise.all(pending)
  } finally {
    sampling = false
    await sampler
    await Promise.allSettled(pending)
  }
  result.durationMs = performance.now() - start
  await sample()
  const quantile = (p: number) => {
    const target = Math.ceil(totalLatency * p)
    let count = 0
    for (let i = 0; i < histogram.length; i++) {
      count += histogram[i]!
      if (count >= target) return i
    }
    return NaN
  }
  result.measurements.latencyP95Ms = quantile(0.95)
  result.measurements.latencyP99Ms = quantile(0.99)
  result.measurements.fallbackRate = result.started ? result.fallbacks / result.started : NaN
  result.measurements.errorRate = result.started ? result.errors / result.started : NaN
  for (const device of profile.devices)
    for (const network of profile.networks)
      for (const route of load.routes) {
        const value = await bounded((signal) => adapter.browser(scenario, route.path, device, network, signal))
        if (
          !["browserTransferBytes", "hydrationMs", "cls", "errors"].every((key) =>
            finite(value[key as keyof Omit<BrowserSample, "browserVersion">]),
          ) ||
          !value.browserVersion
        )
          throw new Error("Invalid browser telemetry")
        result.browsers.push({
          device: device.name,
          network: network.name,
          path: route.path,
          result: value,
        })
        for (const key of ["browserTransferBytes", "hydrationMs", "cls"] as const)
          result.measurements[key] = Math.max(result.measurements[key], value[key])
        if (value.errors) result.violations.push("browser-errors")
      }
  if (sampleFailed) result.violations.push("telemetry-unavailable")
  if (latencyOverflow) result.violations.push("latency-histogram-overflow")
  if (result.dropped) result.violations.push("load-generator-capacity")
  if (!result.started || !result.telemetrySamples) result.violations.push("missing-measurements")
  if (scenario === "disconnect" && !result.disconnected) result.violations.push("disconnect-not-observed")
  if (scenario === "outage" && !result.fallbacks) result.violations.push("outage-not-observed")
  result.violations.push(...budgetViolations(result.measurements, profile.thresholds[scenario]))
  result.violations = [...new Set(result.violations)]
  return result
}

export async function runLoadHarness(input: unknown, adapter: LoadAdapter) {
  let stage = "profile"
  const report = {
    schemaVersion: 1,
    kind: "qualification-load",
    status: "not-qualified",
    productionQualified: false,
    profileSha256: "",
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    serverVersions: {} as Record<string, string>,
    identity: null as QualificationProfile["identity"] | null,
    scenarios: [] as ScenarioResult[],
    failures: [] as string[],
    unverified: [
      "target-security-boundary",
      "cold-old-page-import",
      "accessibility-rehearsal",
      "rollout-rollback-publication",
      "R1-R8-acceptance",
      "owner-signoff",
    ],
  }
  try {
    report.profileSha256 = digest(input)
    const validation = validateQualificationProfile(input)
    if (!validation.valid) {
      report.failures.push(...validation.errors)
      return report
    }
    const profile = parseQualificationProfile(input)
    report.identity = profile.identity
    if (Date.parse(profile.approval.frozenAt) > Date.parse(report.startedAt))
      throw new Error("Approval must precede measurements")
    stage = "capacity"
    // Explicit operational capacity, never silently clamp an approved workload.
    for (const scenario of scenarios) {
      const load = profile.workload[scenario]
      if (
        load.concurrency > 4096 ||
        load.rps > 10000 ||
        load.durationMs > 86400000 ||
        load.requestTimeoutMs > 120000 ||
        (load.durationMs * load.rps) / 1000 > 10000000 ||
        load.routes.reduce((sum, route) => sum + route.weight, 0) > 1000000 ||
        load.routes.length * profile.devices.length * profile.networks.length > 128
      )
        throw new Error("Harness capacity exceeded")
    }
    stage = "identity"
    const confirmation = await bounded((signal) => adapter.begin(structuredClone(profile), signal))
    if (
      !confirmation.workloadVerified ||
      digest(confirmation.identity) !== digest(profile.identity) ||
      confirmation.deploymentProfileSha256 !== profile.environment.deploymentProfileSha256 ||
      !Object.keys(confirmation.serverVersions).length
    )
      throw new Error("Unverified target")
    report.serverVersions = confirmation.serverVersions
    for (const scenario of scenarios) {
      try {
        stage = `${scenario}:enter`
        await bounded((signal) => adapter.enter(scenario, signal))
        stage = `${scenario}:measurement`
        const result = await runScenario(profile, scenario, adapter)
        report.scenarios.push(result)
        report.failures.push(...result.violations.map((value) => `${scenario}:${value}`))
      } catch {
        report.failures.push(`${stage}:failed`)
        throw new Error("Scenario failed")
      } finally {
        // Called even after partial enter failure. Adapter must make restore idempotent.
        const previousStage = stage
        stage = `${scenario}:restore`
        await bounded((signal) => adapter.restore(scenario, signal))
        stage = previousStage
      }
    }
    if (profile.purpose === "local-smoke") report.unverified.push("local-fixture-only")
    if (report.failures.length === 0) report.status = "load-passed"
  } catch {
    if (!report.failures.length || stage.endsWith(":restore")) report.failures.push(`${stage}:failed-or-interrupted`)
  }
  return report
}

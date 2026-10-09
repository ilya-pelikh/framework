import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import {
  qualificationSchema,
  validateQualificationProfile,
  parseQualificationProfile,
  scenarios,
  budgetNames,
  type QualificationProfile,
} from "../scripts/qualification.ts"

function fixture(): QualificationProfile {
  return {
    schemaVersion: 1,
    purpose: "target",
    environment: {
      name: "unit-fixture",
      baseUrl: "https://host.example",
      assetOrigins: ["https://assets.example"],
      deploymentProfileSha256: "a".repeat(64),
    },
    identity: {
      commit: "b".repeat(40),
      artifacts: [{ name: "fixture", sha256: "c".repeat(64) }],
    },
    approval: {
      frozenAt: "2026-10-05T00:00:00.000Z",
      approvedBy: "fixture owner",
      evidence: "fixture approval",
    },
    owners: {
      environment: "fixture",
      release: "fixture",
      security: "fixture",
      onCall: "fixture",
    },
    operations: {
      runbookRecord: "fixture record",
      retentionMs: 1000,
      pageLifetimeMs: 500,
      rollbackWindowMs: 500,
      propagationMs: 100,
      clockMarginMs: 100,
    },
    workload: Object.fromEntries(
      scenarios.map((name) => [
        name,
        {
          rps: 10,
          concurrency: 2,
          durationMs: 1000,
          requestTimeoutMs: 1000,
          disconnectAfterMs: 10,
          routes: [{ path: "/", weight: 1, slots: 2, payloadBytes: 0 }],
        },
      ]),
    ) as QualificationProfile["workload"],
    devices: [
      {
        name: "fixture desktop",
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        cpuSlowdown: 1,
        mobile: false,
      },
    ],
    networks: [
      {
        name: "fixture",
        latencyMs: 0,
        downloadBytesPerSecond: 1000000,
        uploadBytesPerSecond: 1000000,
      },
    ],
    thresholds: Object.fromEntries(
      scenarios.map((name) => [name, Object.fromEntries(budgetNames.map((budget) => [budget, 1]))]),
    ) as QualificationProfile["thresholds"],
  }
}

test("qualification schema and CLI reject the unfilled target example without inventing budgets", async () => {
  assert.deepEqual(JSON.parse(await readFile("deployment/qualification.schema.json", "utf8")), qualificationSchema)
  const example = JSON.parse(await readFile("deployment/qualification.example.json", "utf8"))
  const before = structuredClone(example)
  const result = validateQualificationProfile(example)
  assert.equal(result.status, "not-qualified")
  assert.equal(result.productionQualified, false)
  assert.ok(result.errors.includes("profile.thresholds.soak.rssBytes"))
  assert.ok(result.errors.includes("profile.identity.commit"))
  assert.deepEqual(example, before)
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/validate-qualification.ts", "deployment/qualification.example.json"],
    { encoding: "utf8", timeout: 10000 },
  )
  assert.equal(child.status, 1)
  assert.equal(JSON.parse(child.stdout).status, "not-qualified")
})

test("complete qualification profiles validate structure but cannot confer production approval", () => {
  const input = fixture()
  assert.deepEqual(validateQualificationProfile(input), {
    valid: true,
    status: "profile-valid",
    productionQualified: false,
    errors: [],
  })
  const parsed = parseQualificationProfile(input)
  parsed.owners.environment = "changed"
  assert.equal(input.owners.environment, "fixture")
  for (const section of Object.keys(input)) {
    const missing = { ...input } as Record<string, unknown>
    delete missing[section]
    assert.equal(validateQualificationProfile(missing).status, "not-qualified", section)
  }
  for (const scenario of scenarios)
    for (const budget of budgetNames) {
      const missing = structuredClone(input)
      delete (missing.thresholds[scenario] as Partial<(typeof missing.thresholds)[typeof scenario]>)[budget]
      assert.equal(validateQualificationProfile(missing).valid, false, `${scenario}/${budget}`)
    }
})

test("qualification rejects invalid identity, network, retention and contradictory workloads", () => {
  const mutations: ((profile: QualificationProfile) => void)[] = [
    (p) => {
      p.identity.commit = "unknown"
    },
    (p) => {
      p.identity.artifacts[0]!.sha256 = "bad"
    },
    (p) => {
      p.environment.baseUrl = "http://host.example"
    },
    (p) => {
      p.environment.baseUrl = "https://secret@host.example"
    },
    (p) => {
      p.environment.assetOrigins.push(p.environment.assetOrigins[0]!)
    },
    (p) => {
      p.owners.onCall = " "
    },
    (p) => {
      p.operations.retentionMs = 599
    },
    (p) => {
      p.workload.soak.durationMs = 0
    },
    (p) => {
      p.workload.normal.routes[0]!.path = "//evil.example/"
    },
    (p) => {
      p.workload.normal.disconnectAfterMs = p.workload.normal.requestTimeoutMs
    },
    (p) => {
      p.thresholds.normal.latencyP95Ms = 2
    },
    (p) => {
      p.thresholds.normal.fallbackRate = 2
    },
    (p) => {
      p.thresholds.normal.rssBytes = NaN
    },
    (p) => {
      p.approval.frozenAt = "2026-02-30T00:00:00.000Z"
    },
    (p) => {
      ;(p.owners as any).SECRET = "must never echo"
    },
  ]
  for (const mutate of mutations) {
    const input = fixture()
    mutate(input)
    const result = validateQualificationProfile(input)
    assert.equal(result.valid, false)
    assert.equal(result.productionQualified, false)
    assert.doesNotMatch(JSON.stringify(result), /SECRET|must never echo/)
  }
})

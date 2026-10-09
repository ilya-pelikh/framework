import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runLoadHarness } from "../scripts/load-harness.ts"
import { scenarios } from "../scripts/qualification.ts"
import { loadFixture } from "./helpers/load-fixture.ts"

test(
  "load harness measures five scenarios and rejects a deliberately violated RSS budget",
  { timeout: 60000 },
  async (context) => {
    const fixture = await loadFixture()
    context.after(fixture.stop)
    await mkdir(".cache/load-harness", { recursive: true })
    const evidence = await mkdtemp(resolve(".cache/load-harness/smoke-"))
    const positive = await runLoadHarness(fixture.profile, fixture.adapter)
    await writeFile(resolve(evidence, "load-profile.json"), JSON.stringify(fixture.profile, null, 2))
    await writeFile(resolve(evidence, "load-positive.json"), JSON.stringify(positive, null, 2))
    assert.deepEqual(positive.failures, [])
    assert.equal(positive.status, "load-passed")
    assert.equal(positive.productionQualified, false)
    assert.deepEqual(
      positive.scenarios.map((value) => value.scenario),
      [...scenarios],
    )
    assert.ok(fixture.upstreamDisconnects() > 0)
    for (const result of positive.scenarios) {
      assert.ok(result.started > 0)
      assert.ok(result.telemetrySamples > 0)
      assert.ok(result.measurements.rssBytes > 0)
      assert.ok(result.measurements.browserTransferBytes > 0)
      assert.ok(result.measurements.hydrationMs > 0)
      assert.ok(result.browsers[0]!.result.browserVersion)
    }
    const negativeProfile = structuredClone(fixture.profile)
    for (const scenario of scenarios) negativeProfile.thresholds[scenario].rssBytes = 1
    const negative = await runLoadHarness(negativeProfile, fixture.adapter)
    await writeFile(resolve(evidence, "load-negative-profile.json"), JSON.stringify(negativeProfile, null, 2))
    await writeFile(resolve(evidence, "load-negative.json"), JSON.stringify(negative, null, 2))
    assert.equal(negative.status, "not-qualified")
    assert.equal(negative.productionQualified, false)
    assert.deepEqual(
      negative.failures,
      scenarios.map((scenario) => `${scenario}:rssBytes`),
    )
    let restored = 0
    const interrupted = await runLoadHarness(fixture.profile, {
      ...fixture.adapter,
      async enter() {
        throw new Error("SECRET raw failure")
      },
      async restore() {
        restored++
      },
    })
    assert.equal(restored, 1)
    assert.equal(interrupted.status, "not-qualified")
    assert.deepEqual(interrupted.failures, ["normal:enter:failed"])
    assert.doesNotMatch(JSON.stringify(interrupted), /SECRET/)
    const missingTelemetry = await runLoadHarness(fixture.profile, {
      ...fixture.adapter,
      async sample() {
        throw new Error("SECRET missing telemetry")
      },
      async restore() {
        restored++
      },
    })
    assert.equal(restored, 2)
    assert.equal(missingTelemetry.status, "not-qualified")
    assert.deepEqual(missingTelemetry.failures, ["normal:measurement:failed"])
    assert.doesNotMatch(JSON.stringify(missingTelemetry), /SECRET/)
    const wrongDeployment = structuredClone(fixture.profile)
    wrongDeployment.environment.deploymentProfileSha256 = "0".repeat(64)
    const mismatch = await runLoadHarness(wrongDeployment, fixture.adapter)
    assert.equal(mismatch.status, "not-qualified")
    assert.equal(mismatch.scenarios.length, 0)
    assert.deepEqual(mismatch.failures, ["identity:failed-or-interrupted"])
    console.log(`Load smoke evidence: ${evidence}`)
  },
)

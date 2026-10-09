import { test } from "node:test"
import assert from "node:assert/strict"
import { retirementEligibility, type RetentionPolicy, type RetirementState } from "../scripts/retention.ts"

const policy = {
  pageLifetimeMs: 1000,
  rollbackWindowMs: 2000,
  propagationMs: 100,
  clockSkewMs: 50,
  retentionMs: 2150,
}
const retired = {
  selected: false,
  rollbackPinned: false,
  lastDeselectedAt: 10000,
}

test("retention protects active and pinned releases regardless of age and uses strict expiry", () => {
  assert.deepEqual(retirementEligibility(policy, { ...retired, selected: true }, 100000), {
    eligible: false,
    reason: "selected",
  })
  assert.deepEqual(retirementEligibility(policy, { ...retired, rollbackPinned: true }, 100000), {
    eligible: false,
    reason: "rollback-pinned",
  })
  for (const now of [10000, 12149, 12150])
    assert.deepEqual(retirementEligibility(policy, retired, now), {
      eligible: false,
      reason: "retained",
    })
  assert.deepEqual(retirementEligibility(policy, retired, 12151), {
    eligible: true,
    eligibleAfter: 12150,
  })
  assert.equal(retirementEligibility(policy, { ...retired, lastDeselectedAt: 12000 }, 12151).eligible, false)
})

test("retention fails closed for missing history, missing policy, undersized windows and overflow", () => {
  for (const input of [
    null,
    {},
    { ...policy, retentionMs: 2149 },
    { ...policy, pageLifetimeMs: Infinity },
    { ...policy, clockSkewMs: -1 },
    { ...policy, propagationMs: 0.5 },
    { ...policy, rollbackWindowMs: 0 },
    { ...policy, pageLifetimeMs: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.deepEqual(retirementEligibility(input as RetentionPolicy, retired, 100000), {
      eligible: false,
      reason: "unknown",
    })
  }
  for (const input of [
    null,
    {},
    { ...retired, selected: undefined },
    { ...retired, lastDeselectedAt: null },
    { ...retired, lastDeselectedAt: 100001 },
    { ...retired, lastDeselectedAt: -1 },
    { ...retired, lastDeselectedAt: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.equal(retirementEligibility(policy, input as RetirementState, 100000).eligible, false)
  }
  assert.equal(
    retirementEligibility(
      policy,
      { ...retired, lastDeselectedAt: Number.MAX_SAFE_INTEGER - 1 },
      Number.MAX_SAFE_INTEGER,
    ).eligible,
    false,
  )
  assert.equal(retirementEligibility(policy, retired, NaN).eligible, false)
})

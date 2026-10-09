import { test } from "node:test"
import assert from "node:assert/strict"
import { budgetViolations, runLoadHarness, type LoadAdapter } from "../scripts/load-harness.ts"
import { budgetNames, type Budgets } from "../scripts/qualification.ts"

test("missing load profile cannot call an adapter or declare qualification", async () => {
  const adapter = new Proxy(
    {},
    {
      get() {
        throw new Error("Adapter must not execute")
      },
    },
  ) as LoadAdapter
  const result = await runLoadHarness({}, adapter)
  assert.equal(result.status, "not-qualified")
  assert.equal(result.productionQualified, false)
  assert.equal(result.scenarios.length, 0)
  assert.notEqual(result.failures.length, 0)
})

test("every measured budget is enforced including missing and nonfinite telemetry", () => {
  const limits = Object.fromEntries(budgetNames.map((name) => [name, 1])) as Budgets
  assert.deepEqual(budgetViolations(limits, limits), [])
  for (const name of budgetNames)
    for (const bad of [2, NaN, Infinity, -1, undefined]) {
      assert.deepEqual(budgetViolations({ ...limits, [name]: bad }, limits), [name])
    }
})

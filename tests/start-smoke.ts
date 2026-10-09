import { test } from "node:test"
import { spawn } from "node:child_process"
import assert from "node:assert/strict"
import { stopOwnedChild } from "../scripts/process-lifecycle.ts"
test("compiled launcher smoke", { timeout: 120000 }, async (testContext) => {
  const child = spawn(process.execPath, ["dist/start.mjs", "--demo"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  })
  testContext.after(() => stopOwnedChild(child, 15000, 2000, true))
  let output = ""
  let failed = false
  child.once("error", () => {
    failed = true
  })
  child.stdout!.on("data", (data) => {
    output += String(data)
  })
  child.stderr!.on("data", (data) => {
    output += String(data)
  })
  try {
    const deadline = Date.now() + 20000
    while (!output.includes("Ready:")) {
      if (Date.now() > deadline || child.exitCode !== null || failed)
        throw new Error("Production start timed out or failed")
      await new Promise((done) => setTimeout(done, 100))
    }
    assert.equal(
      (
        await fetch("http://localhost:4100", {
          signal: AbortSignal.timeout(3000),
        })
      ).status,
      200,
    )
  } finally {
    await stopOwnedChild(child, 15000, 2000, true)
  }
  for (const port of [4100, 4101, 4102])
    await assert.rejects(
      fetch(`http://localhost:${port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      }),
    )
  console.log("PASS: compiled production launcher readiness and process cleanup")
})

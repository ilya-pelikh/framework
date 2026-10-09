import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, access } from "node:fs/promises"
import { resolve } from "node:path"

test("clean build launches only the explicitly selected sample registry", { timeout: 45000 }, async () => {
  await mkdir(".cache", { recursive: true })
  const base = await mkdtemp(resolve(".cache/demo-start-"))
  const env = {
    ...process.env,
    ISLANDS_BUILD_ROOT: base,
    RELEASE_ID: "v1",
    SERVICE_ONLY: "0",
    REGISTRY_PATH: "",
  }
  const build = spawnSync(process.execPath, ["--import", "tsx", "scripts/build.ts"], {
    env,
    encoding: "utf8",
    timeout: 20000,
  })
  assert.equal(build.status, 0, build.stderr)
  await assert.rejects(access(resolve(base, "apps/host/dist/registry.json")), /ENOENT/)
  const child = spawn(process.execPath, [resolve(base, "dist/start.mjs"), "--demo"], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  })
  let output = ""
  let failure: Error | undefined
  child.on("error", (error) => {
    failure = error
  })
  child.stdout!.on("data", (data) => {
    output += String(data)
  })
  child.stderr!.on("data", (data) => {
    output += String(data)
  })
  try {
    const deadline = Date.now() + 15000
    while (!output.includes("Ready:")) {
      if (Date.now() > deadline || child.exitCode !== null || failure) throw new Error(output || "Demo did not start")
      await new Promise((done) => setTimeout(done, 50))
    }
    const response = await fetch("http://localhost:4100", {
      signal: AbortSignal.timeout(2000),
    })
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /Apple/)
    assert.match(html, /Quantity:/)
    assert.doesNotMatch(html, /Catalog unavailable|Cart unavailable/)
    await assert.rejects(access(resolve(base, "apps/host/dist/registry.json")), /ENOENT/)
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          reject(new Error("Demo shutdown timeout"))
        }, 10000)
        child.once("exit", () => {
          clearTimeout(timer)
          done()
        })
        if (child.connected) child.send("stop")
        else child.kill()
      })
  }
})

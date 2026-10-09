import { test } from "node:test"
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createServer } from "node:net"
import { browserSession } from "./helpers/browser-session.ts"
import assert from "node:assert/strict"
import { projectCopy } from "./helpers/project-copy.ts"

test("dev failure and recovery", { timeout: 120000 }, async (testContext) => {
  for (const port of [4100, 4101, 4102, 4103]) {
    const probe = createServer()
    await new Promise<void>((done, reject) => {
      probe.once("error", reject)
      probe.listen(port, done)
    })
    await new Promise<void>((done) => probe.close(() => done()))
  }
  const base = await projectCopy()
  const source = resolve(base, "apps/catalog/src/view.tsx")
  const original = await readFile(source, "utf8")
  const registry = resolve(base, "apps/host/dist/registry.json")
  await mkdir(resolve(base, "apps/host/dist"), { recursive: true })
  const sentinel = "operator-managed production registry\r\n"
  await writeFile(registry, sentinel)
  const session = await browserSession()
  testContext.after(session.stop)
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev.ts"], {
    cwd: base,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  })
  let output = ""
  let spawnFailure: Error | undefined
  child.on("error", (error) => {
    spawnFailure = error
  })
  child.stdout!.on("data", (data) => {
    output += String(data)
  })
  child.stderr!.on("data", (data) => {
    output += String(data)
  })
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 30000
    while (!predicate()) {
      if (Date.now() > deadline || child.exitCode !== null || spawnFailure)
        throw new Error(output || "Dev startup failed")
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error("Dev shutdown exceeded deadline"))
      }, 15000)
      child.once("exit", () => {
        clearTimeout(timer)
        done()
      })
      if (child.connected) child.send("stop")
      else child.kill()
    })
  }
  testContext.after(stop)
  try {
    await until(() => (output.match(/Dev ready:/g) ?? []).length === 1)
    const page = await session.context.newPage()
    page.setDefaultTimeout(10000)
    await page.goto("http://localhost:4100")
    await page.locator("section").first().locator("input:enabled").waitFor()
    const initialPayload = await page.locator("#islands-payload").textContent()
    await writeFile(source, `${original}\nexport const syntaxError = ;`)
    await until(() => output.includes("Build failed:"))
    assert.equal((output.match(/Dev ready:/g) ?? []).length, 1)
    const response = await fetch("http://localhost:4100", {
      signal: AbortSignal.timeout(2000),
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Apple/)
    assert.equal(await page.locator("#islands-payload").textContent(), initialPayload)
    await page.locator("section").first().locator("input").fill("apple")
    assert.equal(await page.locator("section").first().locator("li").count(), 1)
    await writeFile(source, original.replace("'Apple'", "'Apricot'"))
    await until(() => (output.match(/Dev ready:/g) ?? []).length >= 2)
    await page.getByText("Apricot", { exact: true }).first().waitFor()
    assert.equal(await page.getByText("Apricot", { exact: true }).count(), 3)
    await page.locator("section").first().locator("input:enabled").waitFor()
    assert.equal(await readFile(registry, "utf8"), sentinel)
    session.assertHealthy(page)
    console.log("PASS: isolated dev outputs, last-known-good on syntax failure, recovery and automatic reload")
  } finally {
    try {
      await stop()
    } finally {
      await session.stop()
    }
  }
  for (const port of [4100, 4101, 4102, 4103])
    await assert.rejects(
      fetch(`http://localhost:${port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      }),
    )
  console.log("PASS: dev child processes stopped; production registry unchanged")
})

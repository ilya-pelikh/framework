import { test } from "node:test"
import { cp, mkdtemp, mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import { browserSession } from "./helpers/browser-session.ts"
import { startApps } from "../scripts/start.ts"
test("source-free deployment and rollback", { timeout: 120000 }, async (testContext) => {
  const base = await mkdtemp(resolve(tmpdir(), "islands-deploy-"))
  for (const name of ["host", "catalog", "cart"]) {
    const target = resolve(base, `apps/${name}/dist`)
    await mkdir(target, { recursive: true })
    await cp(resolve(`apps/${name}/dist`), target, { recursive: true })
  }
  const registry = resolve(base, "apps/host/dist/registry.json")
  const baseline = {
    catalog: {
      releaseId: "v1",
      manifestUrl: "http://localhost:4101/releases/v1/manifest.json",
    },
    cart: {
      releaseId: "v1",
      manifestUrl: "http://localhost:4102/releases/v1/manifest.json",
    },
  }
  await writeFile(registry, JSON.stringify(baseline))
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(resolve(base, path)))
      .digest("hex")
  const hostHash = await hash("apps/host/dist/server.mjs")
  const cartHash = await hash("apps/cart/dist/server.mjs")
  const running = await startApps(base)
  testContext.after(running.stop)
  const session = await browserSession().catch(async (error) => {
    await running.stop()
    throw error
  })
  testContext.after(session.stop)
  try {
    const page = await session.context.newPage()
    const errors: string[] = []
    const requests: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("request", (request) => requests.push(request.url()))
    await page.addInitScript(() => {
      ;(window as any).requestIdleCallback = (callback: () => void) => {
        ;(window as any).releaseIdle = callback
        return 1
      }
      ;(window as any).cancelIdleCallback = () => {}
    })
    await page.goto("http://localhost:4100")
    await page.locator("section").first().locator("input:enabled").waitFor()
    assert.match(await page.locator("h2").first().innerText(), /v1/)
    async function switchTo(releaseId: string) {
      await writeFile(
        `${registry}.next`,
        JSON.stringify({
          ...baseline,
          catalog: {
            releaseId,
            manifestUrl: `http://localhost:4101/releases/${releaseId}/manifest.json`,
          },
        }),
      )
      await rename(`${registry}.next`, registry)
    }
    await switchTo("v2")
    const current = await session.context.newPage()
    await current.goto("http://localhost:4100")
    await current.locator("section").first().locator("input:enabled").waitFor()
    assert.match(await current.locator("h2").first().innerText(), /v2/)
    session.assertHealthy(current)
    await page.evaluate(() => (window as any).releaseIdle())
    await page.locator("section").nth(1).locator("input:enabled").waitFor()
    assert.match(await page.locator("h2").nth(1).innerText(), /v1/)
    assert.equal(requests.filter((url) => url.includes("/releases/v2/")).length, 0)
    await switchTo("v1")
    await current.reload()
    await current.locator("section").first().locator("input:enabled").waitFor()
    assert.match(await current.locator("h2").first().innerText(), /v1/)
    assert.equal(await hash("apps/host/dist/server.mjs"), hostHash)
    assert.equal(await hash("apps/cart/dist/server.mjs"), cartHash)
    assert.deepEqual(errors, [])
    session.assertHealthy(page)
    session.assertHealthy(current)
    console.log(
      `PASS: standalone staging with no source or node_modules; catalog v1 -> v2 -> v1; delayed v1 hydration; unchanged host/cart (${base})`,
    )
  } finally {
    try {
      await session.stop()
    } finally {
      await running.stop()
    }
  }
})

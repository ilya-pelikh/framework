import { test } from "node:test"
import { browserSession } from "./helpers/browser-session.ts"
import assert from "node:assert/strict"
import { startApps } from "../scripts/start.ts"
test("production browser acceptance", { timeout: 120000 }, async (testContext) => {
  const running = await startApps(process.env.ISLANDS_BUILD_ROOT ?? process.cwd(), false, { demo: true })
  testContext.after(running.stop)
  const session = await browserSession().catch(async (error) => {
    await running.stop()
    throw error
  })
  testContext.after(session.stop)
  try {
    const noJs = await session.newContext({ javaScriptEnabled: false })
    const staticPage = await noJs.newPage()
    await staticPage.goto("http://localhost:4100")
    assert.equal(await staticPage.getByText("Apple", { exact: true }).count(), 3)
    assert.equal(await staticPage.getByText("Quantity: 1", { exact: true }).count(), 1)
    assert.equal(await staticPage.locator("input:disabled").count(), 3)
    assert.equal(
      await staticPage
        .locator("section")
        .first()
        .evaluate((element) => getComputedStyle(element).borderTopColor),
      "rgb(22, 101, 52)",
    )
    await noJs.close()
    const page = await session.context.newPage()
    const errors: string[] = []
    const requests: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("request", (request) => requests.push(request.url()))
    await page.goto("http://localhost:4100")
    const first = page.locator("section").nth(0)
    const second = page.locator("section").nth(1)
    await first.locator("input:enabled").waitFor()
    await second.locator("input:enabled").waitFor()
    assert.equal(requests.filter((url) => url.includes(":4102/") && url.endsWith(".js")).length, 0)
    await first.locator("input").fill("apple")
    assert.equal(await first.locator("li").count(), 1)
    assert.equal(await second.locator("li").count(), 3)
    assert.equal(await page.locator("section").nth(2).locator("input:disabled").count(), 1)
    const ids = await page.locator("[id]").evaluateAll((elements) => elements.map((element) => element.id))
    assert.equal(new Set(ids).size, ids.length)
    await page.getByRole("button", { name: "Add one" }).scrollIntoViewIfNeeded()
    await page.locator("button:enabled").waitFor()
    await page.getByRole("button", { name: "Add one" }).click()
    await page.getByText("Quantity: 2", { exact: true }).waitFor()
    assert.ok(requests.some((url) => url.includes(":4102/") && url.endsWith(".js")))
    await page.evaluate(() => (window as any).islands.bootstrap())
    assert.equal(await first.locator("li").count(), 1)
    assert.equal(await page.locator('[data-hydrated="true"]').count(), 3)
    assert.deepEqual(errors, [])
    await page.evaluate(() => {
      const id = document.querySelector("[data-hydrated]")!.id
      ;(window as any).islands.dispose(id)
    })
    assert.equal(await page.locator("section").count(), 3)
    session.assertHealthy(page)
    await page.close()
    const failure = await session.context.newPage()
    await failure.route("**/static/js/catalog.*.js", (route) => route.abort())
    await failure.goto("http://localhost:4100")
    await failure.locator('[data-island-unavailable="true"]').first().waitFor()
    assert.equal(await failure.getByText("Apple", { exact: true }).count(), 3)
    await failure.getByRole("button", { name: "Add one" }).scrollIntoViewIfNeeded()
    await failure.locator("button:enabled").waitFor()
    await failure.close()
    const fallback = await session.context.newPage()
    await fallback.addInitScript(() => {
      Object.defineProperty(window, "IntersectionObserver", {
        value: undefined,
      })
      Object.defineProperty(window, "requestIdleCallback", {
        value: undefined,
      })
    })
    await fallback.goto("http://localhost:4100")
    await fallback.locator("button:enabled").waitFor()
    await fallback.locator("section").nth(1).locator("input:enabled").waitFor()
    assert.equal(await fallback.locator('[data-hydrated="true"]').count(), 3)
    session.assertHealthy(fallback)
    await fallback.close()
    const scheduled = await session.context.newPage()
    await scheduled.addInitScript(() => {
      ;(window as any).requestIdleCallback = (callback: () => void, options: unknown) => {
        ;(window as any).idle = callback
        ;(window as any).idleOptions = options
        return 1
      }
      ;(window as any).cancelIdleCallback = () => {}
    })
    await scheduled.goto("http://localhost:4100")
    await scheduled.locator("section").first().locator("input:enabled").waitFor()
    assert.equal(await scheduled.locator("section").nth(1).locator("input:disabled").count(), 1)
    assert.deepEqual(await scheduled.evaluate(() => (window as any).idleOptions), { timeout: 2000 })
    await scheduled.evaluate(() => (window as any).idle())
    await scheduled.locator("section").nth(1).locator("input:enabled").waitFor()
    session.assertHealthy(scheduled)
    await scheduled.close()
    const late = await session.context.newPage()
    let releaseImport!: () => void
    const importGate = new Promise<void>((done) => {
      releaseImport = done
    })
    await late.route("**/static/js/catalog.*.js", async (route) => {
      await importGate
      await route.continue()
    })
    await late.goto("http://localhost:4100", {
      waitUntil: "domcontentloaded",
    })
    await late.evaluate(() => {
      const element = document.querySelector("[data-island]")!
      ;(window as any).islands.dispose(element.id)
      element.remove()
    })
    releaseImport()
    await late.locator("section").first().locator("input:enabled").waitFor()
    assert.equal(await late.locator('[data-hydrated="true"]').count(), 1)
    session.assertHealthy(late)
    await late.close()
    const renderFailure = await session.context.newPage()
    const renderDiagnostics: string[] = []
    renderFailure.on("console", (message) => {
      if (message.type() === "error") renderDiagnostics.push(message.text())
    })
    await renderFailure.route("**/assets/bootstrap.js", async (route) => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        body: `const payload = document.getElementById('islands-payload'); const values = JSON.parse(payload.textContent); values[0].props.crash = true; payload.textContent = JSON.stringify(values);\n${await response.text()}`,
      })
    })
    await renderFailure.goto("http://localhost:4100")
    await renderFailure.locator("section").first().locator("input:enabled").waitFor()
    await renderFailure.locator("section").first().locator("input").fill("crash")
    await renderFailure.getByRole("alert").waitFor()
    await renderFailure.locator("section").first().locator("input:enabled").waitFor()
    assert.ok(renderDiagnostics.some((message) => message.includes("render")))
    await renderFailure.close()
    running.children[1]!.kill()
    await new Promise<void>((done) => running.children[1]!.once("exit", () => done()))
    const outage = await session.context.newPage()
    await outage.goto("http://localhost:4100")
    await outage.getByText("Catalog unavailable", { exact: true }).waitFor()
    await outage.getByRole("button", { name: "Add one" }).scrollIntoViewIfNeeded()
    await outage.locator("button:enabled").waitFor()
    await outage.getByRole("button", { name: "Add one" }).click()
    await outage.getByText("Quantity: 2", { exact: true }).waitFor()
    assert.equal((await fetch("http://localhost:4100/readyz")).status, 200)
    session.assertHealthy(outage)
    await outage.close()
    console.log(
      "PASS: production SSR, CSS, independent state, policies, IDs, repeated bootstrap, dispose and import failure",
    )
  } finally {
    try {
      await session.stop()
    } finally {
      await running.stop()
    }
  }
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { runtimeBrowser } from "./helpers/runtime-browser.ts"

test(
  "independent policy entries import only at their triggers, with no never or shell root",
  { timeout: 30000 },
  async (testContext) => {
    const fixture = await runtimeBrowser({ test: testContext })
    try {
      fixture.app.get("/releases/v1/assets/:policy.js", (_req, res) =>
        res.type("js").send("export function hydrate(element) { globalThis.roots.push(element.id); return () => {}; }"),
      )
      const page = await fixture.context.newPage()
      page.setDefaultTimeout(5000)
      const requests: string[] = []
      page.on("request", (request) => requests.push(request.url()))
      await page.goto(`${fixture.origin}/empty`)
      await page.waitForFunction(() => !!(window as any).runtime)
      await page.evaluate(() => {
        const state = window as any
        state.roots = []
        state.imports = []
        state.requestIdleCallback = (callback: () => void) => {
          state.runIdle = callback
          return 1
        }
        state.cancelIdleCallback = () => {}
        state.IntersectionObserver = class {
          constructor(callback: (entries: unknown[]) => void) {
            state.runVisible = () => callback([{ isIntersecting: true }])
          }
          observe() {}
          disconnect() {}
        }
        const main = document.createElement("main")
        main.id = "shell"
        document.body.append(main)
        state.descriptors = ["load", "visible", "idle", "never"].map((policy) => {
          const element = document.createElement("div")
          element.id = policy
          element.dataset.island = "counter"
          main.append(element)
          return {
            moduleId: "fixture",
            releaseId: "v1",
            id: policy,
            islandKey: "counter",
            identifierPrefix: `${policy}-`,
            props: {},
            policy,
            clientEntryUrl: `${location.origin}/releases/v1/assets/${policy}.js`,
          }
        })
        state.options = {
          importEntry: (url: string) => {
            state.imports.push(url)
            return import(url)
          },
        }
        state.runtime.bootstrap(state.descriptors, state.options)
      })
      await page.waitForFunction(() => (window as any).roots.length === 1)
      assert.deepEqual(await page.evaluate(() => (window as any).roots), ["load"])
      for (const policy of ["idle", "visible", "never"])
        assert.equal(
          requests.some((url) => url.endsWith(`/${policy}.js`)),
          false,
        )
      await page.evaluate(() => (window as any).runVisible())
      await page.waitForFunction(() => (window as any).roots.length === 2)
      assert.equal(
        requests.some((url) => url.endsWith("/idle.js")),
        false,
      )
      await page.evaluate(() => (window as any).runIdle())
      await page.waitForFunction(() => (window as any).roots.length === 3)
      await page.evaluate(() => {
        const state = window as any
        state.runVisible()
        state.runIdle()
        state.runtime.bootstrap(state.descriptors, state.options)
      })
      assert.deepEqual(await page.evaluate(() => (window as any).roots), ["load", "visible", "idle"])
      assert.equal(await page.evaluate(() => (window as any).imports.length), 3)
      assert.equal(
        requests.some((url) => url.endsWith("/never.js")),
        false,
      )
      assert.equal(await page.locator("#shell[data-hydrated]").count(), 0)
      fixture.assertHealthy(page)
    } finally {
      await fixture.stop()
    }
  },
)

test(
  "policy API fallbacks use immediate visible and finite idle timer with independent entries",
  { timeout: 30000 },
  async (testContext) => {
    const fixture = await runtimeBrowser({ test: testContext })
    try {
      fixture.app.get("/releases/v1/assets/:policy.js", (_req, res) =>
        res.type("js").send("export function hydrate(element) { globalThis.roots.push(element.id); return () => {}; }"),
      )
      const page = await fixture.context.newPage()
      page.setDefaultTimeout(5000)
      await page.goto(`${fixture.origin}/empty`)
      await page.waitForFunction(() => !!(window as any).runtime)
      await page.evaluate(() => {
        const state = window as any
        state.roots = []
        state.calls = {}
        state.started = performance.now()
        state.IntersectionObserver = undefined
        state.requestIdleCallback = undefined
        const descriptors = ["visible", "idle", "never"].map((policy) => {
          const element = document.createElement("div")
          element.id = policy
          element.dataset.island = "counter"
          document.body.append(element)
          return {
            moduleId: "fixture",
            releaseId: "v1",
            id: policy,
            islandKey: "counter",
            identifierPrefix: `${policy}-`,
            props: {},
            policy,
            clientEntryUrl: `${location.origin}/releases/v1/assets/${policy}.js`,
          }
        })
        state.runtime.bootstrap(descriptors, {
          importEntry: (url: string) => {
            state.calls[url.split("/").at(-1)!] = performance.now() - state.started
            return import(url)
          },
        })
      })
      await page.waitForFunction(() => (window as any).roots.length === 2)
      const result = await page.evaluate(() => ({
        roots: (window as any).roots,
        calls: (window as any).calls,
      }))
      assert.deepEqual(result.roots, ["visible", "idle"])
      assert.ok(result.calls["idle.js"] >= 190)
      assert.ok(result.calls["visible.js"] < result.calls["idle.js"])
      assert.equal(result.calls["never.js"], undefined)
      fixture.assertHealthy(page)
    } finally {
      await fixture.stop()
    }
  },
)

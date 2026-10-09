import { test } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { readFile, writeFile, rename } from "node:fs/promises"
import { resolve } from "node:path"
import { buildRelease } from "@islands/rsbuild"
import { createHost, createModuleService, loadPublishedReleases } from "@islands/server"
import { runtimeBrowser, listen, close } from "./helpers/runtime-browser.ts"

for (const blocked of ["none", "entry", "chunk"] as const) {
  test(`cold v1 import after v2 switch; negative control=${blocked}`, { timeout: 30000 }, async (testContext) => {
    const fixture = await runtimeBrowser({ test: testContext })
    const app = express()
    let service: ReturnType<typeof createModuleService> | undefined
    app.use((req, res, next) => {
      if (service) service(req, res, next)
      else res.sendStatus(503)
    })
    const remote = await listen(app)
    try {
      const outDir = resolve(fixture.directory, "releases-fixture")
      const build = (releaseId: string) =>
        buildRelease({
          root: process.cwd(),
          outDir,
          moduleId: "recommendations",
          releaseId,
          publicOrigin: remote.origin,
          serverEntry: "tests/fixtures/recommendations/cold-fragment.ts",
          islands: {
            neighbor: "tests/fixtures/recommendations/entry.ts",
            delayed: "tests/fixtures/recommendations/deferred-entry.ts",
          },
        })
      const reloadService = async () => {
        service = createModuleService({
          ...(await loadPublishedReleases(resolve(outDir, "releases"))),
          allowedHostOrigins: [fixture.origin],
        })
      }
      await build("v1")
      await reloadService()
      const manifest = JSON.parse(await readFile(resolve(outDir, "releases/v1/manifest.json"), "utf8"))
      const graph = JSON.parse(await readFile(resolve(outDir, "releases/v1/assets/manifest.json"), "utf8"))
      const entryUrl: string = manifest.islands.delayed.clientEntryUrl
      const chunkUrl: string | undefined = graph.entries.delayed.async?.js.find((url: string) =>
        url.includes("/async/"),
      )
      assert.ok(chunkUrl, "fixture must emit a separate delayed component chunk")
      const registryPath = resolve(fixture.directory, "registry.json")
      const switchTo = async (releaseId: string) => {
        await writeFile(
          `${registryPath}.next`,
          JSON.stringify({
            recommendations: {
              releaseId,
              manifestUrl: `${remote.origin}/releases/${releaseId}/manifest.json`,
            },
          }),
        )
        await rename(`${registryPath}.next`, registryPath)
      }
      await switchTo("v1")
      fixture.app.use(
        createHost({
          registryPath,
          allowedOrigins: [remote.origin],
          bootstrapUrl: "/bootstrap.js",
          routes: {
            "/": [
              {
                name: "main",
                moduleId: "recommendations",
                props: {},
                fallback: "<p>unavailable</p>",
              },
            ],
          },
        }),
      )
      const page = await fixture.context.newPage()
      page.setDefaultTimeout(5000)
      await page.addInitScript(() => {
        ;(window as any).requestIdleCallback = (callback: () => void) => {
          ;(window as any).releaseIdle = callback
          return 1
        }
        ;(window as any).cancelIdleCallback = () => {}
      })
      const requests: string[] = []
      const responses: string[] = []
      const errors: string[] = []
      page.on("request", (request) => requests.push(request.url()))
      page.on("response", (response) => {
        if (response.ok()) responses.push(response.url())
      })
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => {
        if (blocked === "none" && ["error", "warning"].includes(message.type())) errors.push(message.text())
      })
      await page.goto(fixture.origin)
      await page.getByRole("button", { name: "Neighbor" }).click()
      assert.equal(await page.getByRole("button", { name: "Neighbor" }).textContent(), "Choose 1")
      assert.equal(await page.getByRole("button", { name: "Deferred count 0" }).isDisabled(), true)
      for (const url of [entryUrl, chunkUrl])
        assert.equal(requests.filter((request) => request === url).length, 0, "no delayed network before switch")
      await build("v2")
      await reloadService()
      await switchTo("v2")
      const current = await fixture.context.newPage()
      current.setDefaultTimeout(5000)
      await current.goto(fixture.origin)
      assert.equal(await current.locator('[data-deferred="v2"]').count(), 1)
      await current.getByRole("button", { name: "Neighbor" }).click()
      await current.getByRole("button", { name: "Deferred count 0" }).click()
      fixture.assertHealthy(current)
      const boundary = requests.length
      if (blocked !== "none") await page.route(blocked === "entry" ? entryUrl : chunkUrl, (route) => route.abort())
      await page.evaluate(() => (window as any).releaseIdle())
      if (blocked === "none") {
        await page.getByRole("button", { name: "Deferred count 0" }).click()
        assert.equal(await page.getByRole("button", { name: "Deferred count 1" }).count(), 1)
        for (const url of [entryUrl, chunkUrl]) {
          assert.ok(requests.slice(boundary).includes(url))
          assert.ok(responses.includes(url))
        }
        assert.deepEqual(await page.evaluate(() => (window as any).diagnostics), [])
      } else {
        await page.locator("[data-island-unavailable]").waitFor()
        assert.equal(await page.locator('[data-deferred="v1"]').count(), 1)
        assert.equal(await page.getByRole("button", { name: "Deferred count 0" }).isDisabled(), true)
        assert.ok(requests.slice(boundary).includes(blocked === "entry" ? entryUrl : chunkUrl))
        assert.equal(
          await page.evaluate(
            () => (window as any).diagnostics.filter((item: any) => item.category === "import").length,
          ),
          1,
        )
      }
      await page.getByRole("button", { name: "Neighbor" }).click()
      assert.equal(await page.getByRole("button", { name: "Neighbor" }).textContent(), "Choose 2")
      assert.equal(
        requests.some((url) => url.includes("/releases/v2/")),
        false,
      )
      await switchTo("v1")
      await current.reload()
      assert.equal(await current.locator('[data-deferred="v1"]').count(), 1)
      await current.getByRole("button", { name: "Neighbor" }).click()
      await current.getByRole("button", { name: "Deferred count 0" }).click()
      fixture.assertHealthy(current)
      assert.deepEqual(errors, [])
    } finally {
      await close(remote.server)
      await fixture.stop()
    }
  })
}

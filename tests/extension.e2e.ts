import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import express from "express"
import { createHost, createModuleService, loadPublishedReleases } from "@islands/server"
import { buildRelease } from "@islands/rsbuild"
import { runtimeBrowser, listen, close } from "./helpers/runtime-browser.ts"

test(
  "third module independently builds and hydrates pinned React cross-origin without mismatch",
  { timeout: 30000 },
  async (testContext) => {
    const fixture = await runtimeBrowser({ test: testContext })
    const app = express()
    const remote = await listen(app)
    try {
      const outDir = resolve(fixture.directory, "recommendations")
      await buildRelease({
        root: process.cwd(),
        outDir,
        moduleId: "recommendations",
        releaseId: "v1",
        publicOrigin: remote.origin,
        serverEntry: "tests/fixtures/recommendations/fragment.ts",
        islands: { recommendation: "tests/fixtures/recommendations/entry.ts" },
      })
      const loaded = await loadPublishedReleases(resolve(outDir, "releases"))
      assert.equal(loaded.releases.length, 1)
      assert.deepEqual(loaded.invalidReleases, [])
      const manifest = loaded.releases[0]!.manifest
      assert.equal(manifest.reactVersion, "19.3.0")
      app.use(
        createModuleService({
          ...loaded,
          allowedHostOrigins: [fixture.origin],
        }),
      )
      const registryPath = resolve(fixture.directory, "registry.json")
      await writeFile(
        registryPath,
        JSON.stringify({
          recommendations: {
            releaseId: "v1",
            manifestUrl: `${remote.origin}/releases/v1/manifest.json`,
          },
        }),
      )
      const message = "</script><script>globalThis.payloadExecuted = true</script> & \u2028\u2029 Привет"
      fixture.app.use(
        createHost({
          registryPath,
          allowedOrigins: [remote.origin],
          bootstrapUrl: "/bootstrap.js",
          routes: {
            "/": [
              {
                name: "recommendation",
                moduleId: "recommendations",
                props: { message },
                fallback: "<p>unavailable</p>",
              },
            ],
          },
          shell: (slots) => `<main>${slots.recommendation}</main>`,
        }),
      )
      const page = await fixture.context.newPage()
      page.setDefaultTimeout(5000)
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (event) => {
        if (["error", "warning"].includes(event.type())) errors.push(event.text())
      })
      await page.route("**/releases/v1/assets/**/*.js", async (route) => {
        await new Promise((done) => setTimeout(done, 75))
        await route.continue()
      })
      await page.goto(fixture.origin, { waitUntil: "domcontentloaded" })
      assert.equal(await page.getByRole("button").isDisabled(), true)
      await page.getByRole("button").click()
      assert.equal(await page.getByRole("button").textContent(), "Choose 1")
      assert.equal(await page.locator("label").textContent(), message)
      assert.equal(await page.evaluate(() => (window as any).payloadExecuted), undefined)
      assert.equal(
        await page.locator("section").evaluate((element) => getComputedStyle(element).borderTopColor),
        "rgb(10, 20, 30)",
      )
      assert.deepEqual(await page.evaluate(() => (window as any).diagnostics), [])
      assert.deepEqual(errors, [])
      for (const [url, mime] of [
        [manifest.islands.recommendation!.clientEntryUrl, /javascript/],
        [manifest.islands.recommendation!.cssUrls[0]!, /css/],
      ] as const) {
        const response = await fetch(url, {
          headers: { Origin: fixture.origin },
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get("content-type")!, mime)
        assert.equal(response.headers.get("access-control-allow-origin"), fixture.origin)
      }
      await page.evaluate(() => {
        ;(window as any).runtime.dispose()
        ;(window as any).runtime.dispose()
      })
    } finally {
      await close(remote.server)
      await fixture.stop()
    }
  },
)

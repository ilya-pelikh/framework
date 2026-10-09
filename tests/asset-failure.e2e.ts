import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile, unlink } from "node:fs/promises"
import { resolve } from "node:path"
import express from "express"
import { buildRelease } from "@islands/rsbuild"
import { createHost, createModuleService, loadPublishedReleases } from "@islands/server"
import { runtimeBrowser, listen, close } from "./helpers/runtime-browser.ts"

for (const failure of ["missing-css", "missing-shared", "blocked-shared"] as const) {
  test(`asset failure is local in HTTP and browser: ${failure}`, { timeout: 45000 }, async (testContext) => {
    const fixture = await runtimeBrowser({ test: testContext })
    const remotes: Awaited<ReturnType<typeof listen>>[] = []
    try {
      const registry: Record<string, { releaseId: string; manifestUrl: string }> = {}
      let failedUrl = ""
      for (const moduleId of ["broken", "neighbor"]) {
        const app = express()
        const remote = await listen(app)
        remotes.push(remote)
        const outDir = resolve(fixture.directory, moduleId)
        await buildRelease({
          root: process.cwd(),
          outDir,
          moduleId,
          releaseId: "v1",
          publicOrigin: remote.origin,
          serverEntry: "tests/fixtures/recommendations/fragment.ts",
          islands: {
            recommendation: "tests/fixtures/recommendations/entry.ts",
          },
        })
        const loaded = await loadPublishedReleases(resolve(outDir, "releases"))
        assert.equal(loaded.releases.length, 1)
        app.use(
          createModuleService({
            ...loaded,
            allowedHostOrigins: [fixture.origin],
            integrityCheckIntervalMs: 1,
          }),
        )
        assert.equal((await fetch(`${remote.origin}/readyz`)).status, 200)
        registry[moduleId] = {
          releaseId: "v1",
          manifestUrl: `${remote.origin}/releases/v1/manifest.json`,
        }
        if (moduleId === "broken") {
          const graph = JSON.parse(await readFile(resolve(outDir, "releases/v1/assets/manifest.json"), "utf8"))
          failedUrl =
            failure === "missing-css"
              ? graph.entries.recommendation.initial.css[0]
              : graph.entries.recommendation.initial.js.find((url: string) => /\/lib-react\./.test(url))
          assert.ok(failedUrl, "fixture must emit the requested CSS/shared resource")
          if (failure !== "blocked-shared") {
            await unlink(resolve(outDir, "releases/v1/assets", new URL(failedUrl).pathname.split("/assets/")[1]!))
            await new Promise((done) => setTimeout(done, 5))
            for (const path of ["/readyz", "/releases/v1/readyz", "/releases/v1/manifest.json"]) {
              assert.equal((await fetch(`${remote.origin}${path}`)).status, 503, path)
            }
          }
        }
      }
      const registryPath = resolve(fixture.directory, "registry.json")
      await writeFile(registryPath, JSON.stringify(registry))
      const message = "</script><script>globalThis.payloadExecuted = true</script> \u2028\u2029 Привет"
      fixture.app.use(
        createHost({
          registryPath,
          allowedOrigins: remotes.map((remote) => remote.origin),
          bootstrapUrl: "/bootstrap.js",
          routes: {
            "/": ["broken", "neighbor"].map((moduleId) => ({
              name: moduleId,
              moduleId,
              props: {
                message: moduleId === "broken" ? message : "Neighbor",
              },
              fallback: `<p>${moduleId}-fallback</p>`,
            })),
          },
        }),
      )
      const page = await fixture.context.newPage()
      page.setDefaultTimeout(5000)
      const errors: string[] = []
      const failedRequests: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("requestfailed", (request) => failedRequests.push(request.url()))
      if (failure === "blocked-shared") await page.route(failedUrl, (route) => route.abort())
      assert.equal((await page.goto(fixture.origin))!.status(), 200)
      await page.getByRole("button", { name: "Neighbor", exact: true }).click()
      assert.equal(await page.getByRole("button", { name: "Neighbor", exact: true }).textContent(), "Choose 1")
      const payload = JSON.parse((await page.locator("#islands-payload").textContent())!)
      if (failure === "blocked-shared") {
        await page.locator("[data-island-unavailable]").waitFor()
        assert.ok(failedRequests.includes(failedUrl))
        assert.equal(payload.length, 2)
        assert.equal(await page.getByRole("button", { name: message, exact: true }).isDisabled(), true)
        assert.equal(await page.locator("label").first().textContent(), message)
        const diagnostics = await page.evaluate(() => (window as any).diagnostics)
        assert.equal(diagnostics.length, 1)
        assert.equal(diagnostics[0].category, "import")
        assert.equal(diagnostics[0].moduleId, "broken")
        assert.equal(JSON.stringify(diagnostics).includes(message), false)
      } else {
        assert.equal(await page.getByText("broken-fallback", { exact: true }).count(), 1)
        assert.equal(payload.length, 1)
        assert.equal(payload[0].moduleId, "neighbor")
        assert.deepEqual(await page.evaluate(() => (window as any).diagnostics), [])
      }
      assert.equal(await page.evaluate(() => (window as any).payloadExecuted), undefined)
      assert.deepEqual(errors, [])
    } finally {
      await Promise.all(remotes.map((remote) => close(remote.server)))
      await fixture.stop()
    }
  })
}

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createElement } from "react"
import { createModuleService, defineFragment, defineIsland } from "../packages/server/src/index.ts"
import { publishedRelease } from "./helpers/published-release.ts"
test("versioned service serves two releases, validates requests and checks readiness", async () => {
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/service-"))
  const releases = await Promise.all(
    ["v1", "v2"].map((releaseId) =>
      publishedRelease(
        directory,
        {
          protocolVersion: 1,
          moduleId: "fixture",
          releaseId,
          reactVersion: "19.3.0",
          renderUrl: `http://localhost/releases/${releaseId}/render`,
          islands: {
            counter: {
              clientEntryUrl: `http://localhost/releases/${releaseId}/assets/counter.js`,
              cssUrls: [`http://localhost/releases/${releaseId}/assets/counter.css`],
            },
          },
        },
        defineFragment((builder) =>
          builder.island(
            defineIsland("counter", () => createElement("span", {}, releaseId)),
            {},
          ),
        ),
        {
          "counter.js": "export const hydrate = () => {};",
          "counter.css": "button { color: blue; }",
        },
      ),
    ),
  )
  const server = createModuleService({
    releases,
    allowedHostOrigins: ["http://host.example"],
  }).listen(0)
  await new Promise<void>((done) => server.once("listening", done))
  const origin = `http://localhost:${(server.address() as any).port}`
  try {
    assert.equal((await fetch(`${origin}/readyz`)).status, 200)
    for (const releaseId of ["v1", "v2"]) {
      const response = await fetch(`${origin}/releases/${releaseId}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: 1,
          moduleId: "fixture",
          releaseId,
          instanceId: "slot",
          props: {},
          context: {},
        }),
      })
      assert.equal(response.status, 200)
      assert.match((await response.json()).html, new RegExp(releaseId))
      const manifest = await fetch(`${origin}/releases/${releaseId}/manifest.json`)
      assert.match(manifest.headers.get("cache-control")!, /immutable/)
      const asset = await fetch(`${origin}/releases/${releaseId}/assets/counter.js`, {
        headers: { origin: "http://host.example" },
      })
      assert.match(asset.headers.get("content-type")!, /javascript/)
      assert.equal(asset.headers.get("access-control-allow-origin"), "http://host.example")
      assert.match(asset.headers.get("cache-control")!, /immutable/)
    }
    assert.equal(
      (
        await fetch(`${origin}/releases/v1/render`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      400,
    )
    assert.equal((await fetch(`${origin}/releases/v3/manifest.json`)).status, 404)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})

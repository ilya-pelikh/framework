import { test } from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createHost, createModuleService, defineIsland, defineFragment } from "@islands/server"
import { publishedRelease } from "./helpers/published-release.ts"
test("extension guide integrates a third module through public API and configuration", async () => {
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/extension-"))
  await writeFile(resolve(directory, "entry.js"), "export const hydrate = () => () => {};")
  const island = defineIsland(
    "recommendation",
    ({ data }: { data: { message: string } }) => createElement("p", {}, data.message),
    "never",
  )
  const render = defineFragment((builder) => builder.island(island, { message: "Try a pear" }))
  // Bind first, then configure the service with its actual origin.
  const express = (await import("express")).default
  const app = express()
  const server = app.listen(0)
  await new Promise<void>((done) => server.once("listening", done))
  const origin = `http://localhost:${(server.address() as any).port}`
  const release = await publishedRelease(
    directory,
    {
      protocolVersion: 1,
      moduleId: "recommendations",
      releaseId: "v1",
      reactVersion: "19.3.0",
      renderUrl: `${origin}/releases/v1/render`,
      islands: {
        recommendation: {
          clientEntryUrl: `${origin}/releases/v1/assets/entry.js`,
          cssUrls: [],
        },
      },
    },
    render,
    { "entry.js": "export const hydrate = () => () => {};" },
  )
  app.use(
    createModuleService({
      allowedHostOrigins: ["http://localhost:4100"],
      releases: [release],
    }),
  )
  const registryPath = resolve(directory, "registry.json")
  await writeFile(
    registryPath,
    JSON.stringify({
      recommendations: {
        releaseId: "v1",
        manifestUrl: `${origin}/releases/v1/manifest.json`,
      },
    }),
  )
  const host = createHost({
    registryPath,
    allowedOrigins: [origin],
    bootstrapUrl: "/bootstrap.js",
    routes: {
      "/": [
        {
          name: "recommendation",
          moduleId: "recommendations",
          props: {},
          fallback: "unavailable",
        },
      ],
    },
  }).listen(0)
  await new Promise<void>((done) => host.once("listening", done))
  try {
    const response = await fetch(`http://localhost:${(host.address() as any).port}/`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Try a pear/)
  } finally {
    for (const process of [host, server]) {
      process.closeAllConnections()
      await new Promise<void>((done) => process.close(() => done()))
    }
  }
})

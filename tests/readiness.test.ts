import { test } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createModuleService, loadPublishedReleases, defineFragment } from "@islands/server"
import { publishedRelease } from "./helpers/published-release.ts"
import { listen, close } from "./helpers/runtime-browser.ts"

async function fixture() {
  await mkdir(".cache", { recursive: true })
  const root = await mkdtemp(resolve(".cache/readiness-"))
  const releases = await Promise.all(
    ["v1", "v2"].map((releaseId) =>
      publishedRelease(
        root,
        {
          protocolVersion: 1,
          moduleId: "fixture",
          releaseId,
          reactVersion: "19.3.0",
          renderUrl: `http://localhost/releases/${releaseId}/render`,
          islands: {
            counter: {
              clientEntryUrl: `http://localhost/releases/${releaseId}/assets/entry.js`,
              cssUrls: [],
            },
          },
        },
        defineFragment(() => "<p>valid release</p>"),
        {
          "entry.js": "export function hydrate() {}",
          "shared.js": "shared",
          "async.js": "async",
        },
      ),
    ),
  )
  return { root, releases }
}
test("loader isolates corrupt marked and unmarked releases while preserving valid endpoints", async () => {
  const { root, releases } = await fixture()
  await unlink(resolve(releases[1]!.assetsDirectory, "shared.js"))
  await mkdir(resolve(root, "unmarked"))
  await writeFile(resolve(root, "unmarked/server.mjs"), 'throw new Error("must not execute");')
  const diagnostics: unknown[] = []
  const loaded = await loadPublishedReleases(root, (event) => {
    diagnostics.push(event)
    throw new Error("sink")
  })
  assert.equal(loaded.releases.length, 1)
  assert.deepEqual(loaded.invalidReleases, ["v2"])
  assert.deepEqual(diagnostics, [
    { releaseId: "unmarked", category: "unpublished" },
    { releaseId: "v2", category: "integrity" },
  ])
  const server = await listen(createModuleService({ ...loaded, allowedHostOrigins: [] }))
  try {
    for (const [path, status] of [
      ["/healthz", 200],
      ["/readyz", 503],
      ["/releases/v1/readyz", 200],
      ["/releases/v2/readyz", 503],
      ["/releases/unmarked/readyz", 404],
      ["/releases/unknown/readyz", 404],
      ["/releases/v1/manifest.json", 200],
      ["/releases/v2/manifest.json", 503],
    ]) {
      assert.equal((await fetch(`${server.origin}${path}`)).status, status, String(path))
    }
    const response = await fetch(`${server.origin}/releases/v1/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: 1,
        moduleId: "fixture",
        releaseId: "v1",
        instanceId: "slot",
        props: {},
        context: {},
      }),
    })
    assert.equal(response.status, 200)
    assert.match((await response.json()).html, /valid release/)
  } finally {
    await close(server.server)
  }
})

test("expired integrity refresh rejects modified async chunks without disabling a neighbor", async () => {
  const { releases } = await fixture()
  const server = await listen(
    createModuleService({
      releases,
      allowedHostOrigins: [],
      integrityCheckIntervalMs: 20,
    }),
  )
  try {
    assert.equal((await fetch(`${server.origin}/readyz`)).status, 200)
    await writeFile(resolve(releases[1]!.assetsDirectory, "async.js"), "changed")
    await new Promise((done) => setTimeout(done, 30))
    const statuses = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${server.origin}/releases/v2/readyz`).then((response) => response.status),
      ),
    )
    assert.deepEqual(statuses, Array(10).fill(503))
    assert.equal((await fetch(`${server.origin}/releases/v2/assets/entry.js`)).status, 503)
    assert.equal((await fetch(`${server.origin}/releases/v1/manifest.json`)).status, 200)
    assert.equal((await fetch(`${server.origin}/readyz`)).status, 503)
  } finally {
    await close(server.server)
  }
})

test("empty published set and invalid renderer cannot become ready", async () => {
  const { releases } = await fixture()
  for (const configured of [[], [{ ...releases[0]!, render: undefined as any }]]) {
    const server = await listen(createModuleService({ releases: configured, allowedHostOrigins: [] }))
    try {
      assert.equal((await fetch(`${server.origin}/readyz`)).status, 503)
    } finally {
      await close(server.server)
    }
  }
  assert.throws(
    () =>
      createModuleService({
        releases,
        allowedHostOrigins: [],
        integrityCheckIntervalMs: Infinity,
      }),
    /limits/,
  )
})

test("synchronous admission failure expires and retries instead of retaining a settled flight", async () => {
  const { releases } = await fixture()
  const release = releases[0]!
  const assetsDirectory = release.assetsDirectory
  release.assetsDirectory = resolve(assetsDirectory, "wrong")
  const server = await listen(
    createModuleService({
      releases,
      allowedHostOrigins: [],
      integrityCheckIntervalMs: 20,
    }),
  )
  try {
    assert.equal((await fetch(`${server.origin}/releases/v1/readyz`)).status, 503)
    release.assetsDirectory = assetsDirectory
    await new Promise((done) => setTimeout(done, 30))
    assert.equal((await fetch(`${server.origin}/releases/v1/readyz`)).status, 200)
    assert.equal((await fetch(`${server.origin}/readyz`)).status, 200)
  } finally {
    await close(server.server)
  }
})

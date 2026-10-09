import { test } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { FragmentFetcher, ManifestCache, AdmissionController } from "@islands/server"
import { listen, close } from "./helpers/http-server.ts"
import type { RenderRequest } from "@islands/contracts"

async function fixture(cache = new ManifestCache(), timeoutMs = 1500) {
  const app = express()
  app.use(express.json())
  const remote = await listen(app)
  const counts = { manifests: 0, renders: 0, closed: 0 }
  let manifestDelay = 0
  let invalid: boolean | "identity" | "origin" = false
  app.get("/releases/:releaseId/manifest.json", (req, res) => {
    counts.manifests++
    const timer = setTimeout(
      () =>
        res.json(
          invalid === true
            ? {}
            : {
                protocolVersion: 1,
                moduleId: invalid === "identity" ? "other" : "fixture",
                releaseId: req.params.releaseId,
                reactVersion: "19.3.0",
                renderUrl: `${invalid === "origin" ? "https://forbidden.example" : remote.origin}/releases/${req.params.releaseId}/render`,
                islands: {},
                props: "must-not-be-cached",
                html: "must-not-be-cached",
              },
        ),
      manifestDelay,
    )
    res.once("close", () => {
      clearTimeout(timer)
      if (!res.writableEnded) counts.closed++
    })
  })
  app.post("/releases/:releaseId/render", (req, res) => {
    counts.renders++
    res.json({
      protocolVersion: 1,
      moduleId: "fixture",
      releaseId: req.params.releaseId,
      html: `<p>${req.body.props.value}</p>`,
      islands: [],
    })
  })
  const origins = [remote.origin]
  const admission = new AdmissionController()
  const fetcher = new FragmentFetcher(origins, { timeoutMs }, admission, cache)
  const render = async (releaseId = "v1", signal = new AbortController().signal, value = "one", suffix = "") => {
    const request: RenderRequest = {
      protocolVersion: 1,
      moduleId: "fixture",
      releaseId,
      instanceId: "main",
      props: { value },
      context: {},
    }
    const result = await fetcher.render(
      {
        releaseId,
        manifestUrl: `${remote.origin}/releases/${releaseId}/manifest.json${suffix}`,
      },
      request,
      signal,
    )
    result.release()
    return result
  }
  return {
    ...remote,
    counts,
    cache,
    render,
    admission,
    origins,
    fetcher,
    delay: (value: number) => {
      manifestDelay = value
    },
    invalid: (value: typeof invalid) => {
      invalid = value
    },
  }
}
async function until(predicate: () => boolean) {
  const expires = performance.now() + 1500
  while (!predicate()) {
    assert.ok(performance.now() < expires, "network effect deadline")
    await new Promise((done) => setTimeout(done, 5))
  }
}

test("manifest cache isolates release/URL/allowlist, freezes known fields and never caches render data", async () => {
  const remote = await fixture()
  try {
    const first = await remote.render()
    const second = await remote.render("v1", undefined, "two")
    assert.equal(remote.counts.manifests, 1)
    assert.equal(remote.counts.renders, 2)
    assert.equal(first.response.html, "<p>one</p>")
    assert.equal(second.response.html, "<p>two</p>")
    assert.equal("props" in first.manifest, false)
    assert.equal("html" in first.manifest, false)
    assert.throws(() => {
      first.manifest.releaseId = "changed"
    })
    assert.throws(() => {
      first.manifest.islands.other = { clientEntryUrl: "bad", cssUrls: [] }
    })
    await remote.render("v2")
    await remote.render("v1")
    assert.equal(remote.counts.manifests, 2)
    await remote.render("v1", undefined, "one", "?generation=next")
    assert.equal(remote.counts.manifests, 3)
    remote.origins.push("https://new-allowlist.example")
    await remote.render()
    assert.equal(remote.counts.manifests, 4)
    remote.origins.splice(0, 1)
    await assert.rejects(remote.render(), { category: "identity" })
    assert.equal(remote.admission.snapshot().active, 0)
  } finally {
    await close(remote.server)
  }
})

test("cache enforces LRU count, bytes, TTL and does not retain failed or oversized entries", async () => {
  const remote = await fixture(new ManifestCache({ maxEntries: 2, maxBytes: 2000, ttlMs: 500 }))
  try {
    await remote.render("v1")
    await remote.render("v2")
    await remote.render("v1")
    await remote.render("v3")
    assert.equal(remote.cache.snapshot().entries, 2)
    await remote.render("v2")
    assert.equal(remote.counts.manifests, 4)
    assert.ok(remote.cache.snapshot().bytes <= 2000)
    await new Promise((done) => setTimeout(done, 520))
    assert.equal(remote.cache.snapshot().entries, 0)
    remote.invalid(true)
    await assert.rejects(remote.render("v4"), { category: "protocol" })
    remote.invalid(false)
    await remote.render("v4")
    assert.equal(remote.counts.manifests, 6)
    for (const invalid of ["identity", "origin"] as const) {
      remote.invalid(invalid)
      await assert.rejects(remote.render("v5"), { category: "identity" })
      assert.equal(remote.cache.snapshot().entries, 1)
    }
    remote.invalid(false)
    await remote.render("v5")
    assert.equal(remote.counts.manifests, 9)
  } finally {
    await close(remote.server)
  }
  const tiny = await fixture(new ManifestCache({ maxBytes: 1 }))
  try {
    await tiny.render()
    await tiny.render()
    assert.equal(tiny.cache.snapshot().entries, 0)
    assert.equal(tiny.counts.manifests, 2)
  } finally {
    await close(tiny.server)
  }
  const byteBounded = await fixture(new ManifestCache({ maxBytes: 500 }))
  try {
    await byteBounded.render("v1")
    await byteBounded.render("v2")
    assert.equal(byteBounded.cache.snapshot().entries, 1)
    await byteBounded.render("v1")
    assert.equal(byteBounded.counts.manifests, 3)
    assert.ok(byteBounded.cache.snapshot().bytes <= 500)
  } finally {
    await close(byteBounded.server)
  }
})

test("single-flight survives first consumer cancellation and aborts after the last, with fresh retry", async () => {
  const remote = await fixture()
  remote.delay(120)
  try {
    const first = new AbortController()
    const second = new AbortController()
    const rejected = assert.rejects(remote.render("v1", first.signal), {
      category: "disconnect",
    })
    const surviving = remote.render("v1", second.signal, "survivor")
    await until(() => remote.counts.manifests === 1)
    first.abort()
    await rejected
    assert.equal((await surviving).response.html, "<p>survivor</p>")
    assert.equal(remote.counts.manifests, 1)
    assert.equal(remote.counts.renders, 1)
    assert.equal(remote.counts.closed, 0)
    const alone = new AbortController()
    const canceled = assert.rejects(remote.render("v2", alone.signal), {
      category: "disconnect",
    })
    await until(() => remote.counts.manifests === 2)
    alone.abort()
    await canceled
    await until(() => remote.counts.closed === 1)
    assert.equal(remote.cache.snapshot().pending, 0)
    await remote.render("v2")
    assert.equal(remote.counts.manifests, 3)
    assert.equal(remote.admission.snapshot().active, 0)
  } finally {
    await close(remote.server)
  }
})

test("consumer deadline is independent of the shared manifest deadline", async () => {
  const remote = await fixture(new ManifestCache({ loadTimeoutMs: 500 }), 80)
  remote.delay(160)
  try {
    const expired = assert.rejects(remote.render(), {
      category: "timeout",
      stage: "manifest",
    })
    const other = new FragmentFetcher(remote.origins, { timeoutMs: 600 }, remote.admission, remote.cache)
    const surviving = other.render(
      {
        releaseId: "v1",
        manifestUrl: `${remote.origin}/releases/v1/manifest.json`,
      },
      {
        protocolVersion: 1,
        moduleId: "fixture",
        releaseId: "v1",
        instanceId: "main",
        props: { value: "survivor" },
        context: {},
      },
      new AbortController().signal,
    )
    await expired
    const result = await surviving
    result.release()
    assert.equal(result.response.html, "<p>survivor</p>")
    assert.equal(remote.counts.manifests, 1)
    assert.equal(remote.counts.closed, 0)
  } finally {
    await close(remote.server)
  }
  const bounded = await fixture(new ManifestCache({ loadTimeoutMs: 30 }), 1000)
  bounded.delay(200)
  try {
    await assert.rejects(bounded.render(), {
      category: "timeout",
      stage: "manifest",
    })
    assert.equal(bounded.admission.snapshot().active, 0)
  } finally {
    await close(bounded.server)
  }
})

test("cache and fetch configurations reject non-finite and nonpositive limits", () => {
  for (const value of [0, -1, Infinity, NaN, 0.5, 2147483648]) {
    assert.throws(() => new ManifestCache({ ttlMs: value }))
    assert.throws(() => new FragmentFetcher([], { timeoutMs: value }))
  }
})

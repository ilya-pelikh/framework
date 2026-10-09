import { test } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import http from "node:http"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { FragmentFetcher, createHost } from "@islands/server"
import { listen, close } from "./helpers/runtime-browser.ts"

test("redirects never reach a real disallowed origin", async () => {
  let hits = 0
  const forbidden = express()
  forbidden.use((_req, res) => {
    hits++
    res.json({})
  })
  const target = await listen(forbidden)
  const upstream = express()
  upstream.use((_req, res) => res.redirect(`${target.origin}/private`))
  const remote = await listen(upstream)
  try {
    const fetcher = new FragmentFetcher([remote.origin])
    await assert.rejects(fetcher.json(`${remote.origin}/manifest`, 1024, AbortSignal.timeout(2000)))
    assert.equal(hits, 0)
  } finally {
    await close(remote.server)
    await close(target.server)
  }
})

test("chunked overflow cancels upstream before its body finishes, without Content-Length", async () => {
  const app = express()
  let chunks = 0
  let disconnected = false
  let completed = false
  let contentLength = false
  app.get("/stream", (_req, res) => {
    res.type("json")
    res.flushHeaders()
    contentLength = res.hasHeader("Content-Length")
    const timer = setInterval(() => {
      chunks++
      res.write("x".repeat(128))
      if (chunks === 100) {
        completed = true
        res.end()
      }
    }, 5)
    res.once("close", () => {
      clearInterval(timer)
      disconnected = !res.writableEnded
    })
  })
  const remote = await listen(app)
  try {
    await assert.rejects(
      new FragmentFetcher([remote.origin]).json(`${remote.origin}/stream`, 256, AbortSignal.timeout(2000)),
      /Response limit/,
    )
    const deadline = Date.now() + 1000
    while (!disconnected && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5))
    assert.equal(contentLength, false)
    assert.equal(disconnected, true)
    assert.equal(completed, false)
    assert.ok(chunks < 100)
  } finally {
    await close(remote.server)
  }
})

test("manifest and slow render body share one deadline and close the upstream response", async () => {
  const app = express()
  app.use(express.json())
  const remote = await listen(app)
  let closed = false
  let completed = false
  app.get("/releases/v1/manifest.json", (_req, res) => {
    const timer = setTimeout(
      () =>
        res.json({
          protocolVersion: 1,
          moduleId: "fixture",
          releaseId: "v1",
          reactVersion: "19.3.0",
          renderUrl: `${remote.origin}/releases/v1/render`,
          islands: {},
        }),
      200,
    )
    res.once("close", () => clearTimeout(timer))
  })
  app.post("/releases/v1/render", (_req, res) => {
    res.type("json")
    res.write("{")
    const timer = setTimeout(() => {
      completed = true
      res.end('"protocolVersion":1,"moduleId":"fixture","releaseId":"v1","html":"<p>late</p>","islands":[]}')
    }, 200)
    res.once("close", () => {
      clearTimeout(timer)
      closed = !res.writableEnded
    })
  })
  try {
    const fetcher = new FragmentFetcher([remote.origin], { timeoutMs: 300 })
    await assert.rejects(
      fetcher.render(
        {
          releaseId: "v1",
          manifestUrl: `${remote.origin}/releases/v1/manifest.json`,
        },
        {
          protocolVersion: 1,
          moduleId: "fixture",
          releaseId: "v1",
          instanceId: "slot",
          props: {},
          context: {},
        },
        new AbortController().signal,
      ),
    )
    const deadline = Date.now() + 1000
    while (!closed && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5))
    assert.equal(closed, true)
    assert.equal(completed, false)
  } finally {
    await close(remote.server)
  }
})

test("disconnecting a host client closes its in-progress remote render body", async () => {
  const app = express()
  app.use(express.json())
  const remote = await listen(app)
  let started!: () => void
  const rendering = new Promise<void>((done) => {
    started = done
  })
  let closed!: () => void
  const disconnected = new Promise<void>((done) => {
    closed = done
  })
  app.get("/releases/v1/manifest.json", (_req, res) =>
    res.json({
      protocolVersion: 1,
      moduleId: "fixture",
      releaseId: "v1",
      reactVersion: "19.3.0",
      renderUrl: `${remote.origin}/releases/v1/render`,
      islands: {},
    }),
  )
  app.post("/releases/v1/render", (_req, res) => {
    res.type("json")
    res.write("{")
    started()
    res.once("close", () => {
      if (!res.writableEnded) closed()
    })
  })
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/disconnect-"))
  const registryPath = resolve(directory, "registry.json")
  await writeFile(
    registryPath,
    JSON.stringify({
      fixture: {
        releaseId: "v1",
        manifestUrl: `${remote.origin}/releases/v1/manifest.json`,
      },
    }),
  )
  const host = await listen(
    createHost({
      registryPath,
      allowedOrigins: [remote.origin],
      bootstrapUrl: "/bootstrap.js",
      limits: { timeoutMs: 5000 },
      routes: {
        "/": [
          {
            name: "main",
            moduleId: "fixture",
            props: {},
            fallback: "<p>fallback</p>",
          },
        ],
      },
    }),
  )
  const request = http.get(host.origin)
  request.on("error", () => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_done, reject) => {
      timer = setTimeout(() => reject(new Error("Upstream did not close")), 2000)
    })
    await Promise.race([rendering, timeout])
    request.destroy()
    await Promise.race([disconnected, timeout])
  } finally {
    clearTimeout(timer)
    request.destroy()
    await close(host.server)
    await close(remote.server)
  }
})

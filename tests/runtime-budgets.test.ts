import { test } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { AdmissionController, FragmentFetcher, createHost, type Diagnostic, type Metric } from "@islands/server"
import { listen, close } from "./helpers/http-server.ts"

test(
  "HTTP burst/disconnect/error stays within process budgets and preserves neighbor quota",
  { timeout: 10000 },
  async () => {
    const app = express()
    app.use(express.json())
    const remote = await listen(app)
    let started!: () => void
    const rendering = new Promise<void>((done) => {
      started = done
    })
    let closed = false
    let mode = "hold"
    let renderCalls = 0
    app.get("/releases/v1/manifest.json", (req, res) =>
      res.json({
        protocolVersion: 1,
        moduleId: req.query.module,
        releaseId: "v1",
        reactVersion: "19.3.0",
        renderUrl: `${remote.origin}/releases/v1/render?module=${req.query.module}`,
        islands: {},
      }),
    )
    app.post("/releases/v1/render", (req, res) => {
      renderCalls++
      if (req.query.module === "busy" && mode === "hold") {
        res.type("json").write("{")
        res.once("close", () => {
          closed = true
        })
        started()
        return
      }
      if (mode === "error") {
        res.sendStatus(500)
        return
      }
      res.json({
        protocolVersion: 1,
        moduleId: req.query.module,
        releaseId: "v1",
        html: "<p>working</p>",
        islands: [],
      })
    })
    await mkdir(".cache", { recursive: true })
    const directory = await mkdtemp(resolve(".cache/budget-smoke-"))
    const registryPath = resolve(directory, "registry.json")
    await writeFile(
      registryPath,
      JSON.stringify(
        Object.fromEntries(
          ["busy", "neighbor"].map((moduleId) => [
            moduleId,
            {
              releaseId: "v1",
              manifestUrl: `${remote.origin}/releases/v1/manifest.json?module=${moduleId}`,
            },
          ]),
        ),
      ),
    )
    const pool = new AdmissionController({
      maxActive: 2,
      maxPerModule: 1,
      maxResponseBytes: 6144,
    })
    const events: Diagnostic[] = []
    const metrics: Metric[] = []
    const host = await listen(
      createHost({
        registryPath,
        allowedOrigins: [remote.origin],
        bootstrapUrl: "/bootstrap.js",
        admission: pool,
        limits: { timeoutMs: 3000, manifestBytes: 1024, renderBytes: 2048 },
        routes: Object.fromEntries(
          ["busy", "neighbor"].map((moduleId) => [
            `/${moduleId}`,
            [
              {
                name: "main",
                moduleId,
                props: {},
                fallback: "<p>fallback</p>",
              },
            ],
          ]),
        ),
        onDiagnostic: (event) => events.push(event),
        onMetric: (metric) => metrics.push(metric),
      }),
    )
    const controller = new AbortController()
    const pending = assert.rejects(fetch(`${host.origin}/busy`, { signal: controller.signal }))
    const waitFor = async (predicate: () => boolean) => {
      const expires = performance.now() + 1500
      while (!predicate()) {
        assert.ok(performance.now() < expires)
        await new Promise((done) => setTimeout(done, 5))
      }
    }
    try {
      await rendering
      const before = performance.now()
      const burst = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const response = await fetch(`${host.origin}/busy`)
          assert.equal(response.status, 200)
          return response.text()
        }),
      )
      assert.ok(burst.every((html) => html.includes("fallback")))
      assert.ok(performance.now() - before < 1500)
      assert.equal(renderCalls, 1)
      assert.equal(events.filter((event) => event.category === "overload").length, 20)
      assert.deepEqual(pool.snapshot(), {
        active: 1,
        queued: 0,
        reservedBytes: 3072,
        modules: 1,
      })
      assert.match(await (await fetch(`${host.origin}/neighbor`)).text(), /working/)
      controller.abort()
      await pending
      await waitFor(() => closed && pool.snapshot().active === 0)
      mode = "error"
      assert.match(await (await fetch(`${host.origin}/busy`)).text(), /fallback/)
      await waitFor(() => pool.snapshot().active === 0)
      mode = "ok"
      assert.match(await (await fetch(`${host.origin}/busy`)).text(), /working/)
      await waitFor(() => pool.snapshot().active === 0)
      assert.equal(pool.snapshot().reservedBytes, 0)
      assert.ok(events.some((event) => event.category === "disconnect"))
      assert.ok(events.some((event) => event.category === "http" && event.stage === "render"))
      const evidence = resolve(directory, "evidence.json")
      await writeFile(
        evidence,
        JSON.stringify(
          {
            schemaVersion: 1,
            kind: "local-resource-smoke",
            productionQualified: false,
            node: process.version,
            platform: process.platform,
            limits: pool.limits,
            burst: 20,
            overloaded: 20,
            after: pool.snapshot(),
            events,
            metrics,
          },
          null,
          2,
        ),
      )
      console.log(`PASS: local diagnostic/load evidence: ${evidence}`)
    } finally {
      controller.abort()
      await close(host.server)
      await close(remote.server)
      await pending
    }
  },
)

test("admission wait consumes the slot deadline and successful results hold reservations until released", async () => {
  const app = express()
  const remote = await listen(app)
  let hits = 0
  app.get("/releases/v1/manifest.json", (_req, res) => {
    hits++
    res.json({
      protocolVersion: 1,
      moduleId: "fixture",
      releaseId: "v1",
      reactVersion: "19.3.0",
      renderUrl: `${remote.origin}/releases/v1/render`,
      islands: {},
    })
  })
  app.post("/releases/v1/render", (_req, res) =>
    res.json({
      protocolVersion: 1,
      moduleId: "fixture",
      releaseId: "v1",
      html: "<p>ready</p>",
      islands: [],
    }),
  )
  const pool = new AdmissionController({ maxActive: 1, maxQueue: 1 })
  const held = await pool.acquire("held", 1, new AbortController().signal)
  const fetcher = new FragmentFetcher([remote.origin], { timeoutMs: 50 }, pool)
  const entry = {
    releaseId: "v1",
    manifestUrl: `${remote.origin}/releases/v1/manifest.json`,
  }
  const input = {
    protocolVersion: 1 as const,
    moduleId: "fixture",
    releaseId: "v1",
    instanceId: "main",
    props: {},
    context: {},
  }
  try {
    await assert.rejects(fetcher.render(entry, input, new AbortController().signal), {
      category: "timeout",
      stage: "admission",
    })
    assert.equal(hits, 0)
    assert.equal(pool.snapshot().queued, 0)
    held()
    const result = await fetcher.render(entry, input, new AbortController().signal)
    assert.equal(pool.snapshot().active, 1)
    assert.equal(pool.snapshot().reservedBytes, 1114112)
    result.release()
    result.release()
    assert.equal(pool.snapshot().reservedBytes, 0)
  } finally {
    held()
    await close(remote.server)
  }
})

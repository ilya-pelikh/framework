import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile, unlink } from "node:fs/promises"
import { resolve } from "node:path"
import express from "express"
import {
  createHost,
  createModuleService,
  AdmissionController,
  correlationHeader,
  correlationId,
  type Diagnostic,
  type Metric,
} from "@islands/server"
import { listen, close } from "./helpers/http-server.ts"
import { publishedRelease } from "./helpers/published-release.ts"

test("host reports bounded categories/stages and identity without raw errors, props, credentials or query", async () => {
  const remote = await listen(express())
  let mode = "ok"
  const app = express()
  app.use(express.json())
  remote.server.removeAllListeners("request")
  remote.server.on("request", app)
  app.get("/releases/v1/manifest.json", (_req, res) => {
    if (mode === "timeout") return
    if (mode === "transport") {
      res.destroy()
      return
    }
    if (mode === "http") {
      res.status(503).send("SECRET-status")
      return
    }
    if (mode === "oversized") {
      res.json({ data: "x".repeat(2048) })
      return
    }
    if (mode === "protocol") {
      res.type("json").send("{SECRET-malformed")
      return
    }
    res.json({
      protocolVersion: 1,
      moduleId: mode === "identity" ? "other" : "fixture",
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
      html: mode === "html" ? "<script>SECRET-script</script>" : "<p>ok</p>",
      islands: [],
    }),
  )
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/diagnostics-"))
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
  const events: Diagnostic[] = []
  const metrics: Metric[] = []
  const pool = new AdmissionController({ maxActive: 1 })
  const host = await listen(
    createHost({
      registryPath,
      allowedOrigins: [remote.origin],
      bootstrapUrl: "/bootstrap.js",
      manifestCache: false,
      admission: pool,
      limits: { timeoutMs: 100, manifestBytes: 1024, renderBytes: 1024 },
      routes: {
        "/": [
          {
            name: "main",
            moduleId: "fixture",
            props: { secret: "SECRET-props" },
            fallback: "<p>fallback</p>",
          },
        ],
      },
      onDiagnostic: async (event) => {
        events.push(event)
        throw new Error("SECRET-sink")
      },
      onMetric: async (metric) => {
        metrics.push(metric)
        throw new Error("SECRET-metric")
      },
    }),
  )
  try {
    for (mode of ["timeout", "transport", "http", "oversized", "protocol", "identity", "html", "overload"]) {
      const release = mode === "overload" ? await pool.acquire("busy", 1, new AbortController().signal) : undefined
      const response = await fetch(`${host.origin}/?SECRET-query`, {
        headers: {
          Authorization: "SECRET-credentials",
          Cookie: "SECRET-cookie",
          [correlationHeader]: "SECRET-forged",
        },
      })
      release?.()
      assert.equal(response.status, 200)
      assert.match(await response.text(), /fallback/)
      const event = events.at(-1)!
      assert.equal(event.category, mode)
      assert.equal(event.stage, mode === "html" ? "validation" : mode === "overload" ? "admission" : "manifest")
      assert.equal(event.requestId, response.headers.get(correlationHeader))
      assert.equal(event.moduleId, "fixture")
      assert.equal(event.releaseId, "v1")
      assert.equal(event.slot, "main")
      assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0)
      assert.equal(pool.snapshot().active, 0)
    }
    assert.doesNotMatch(JSON.stringify({ events, metrics }), /SECRET|props|cookie|Authorization|stack|message/)
    for (const metric of metrics) assert.deepEqual(Object.keys(metric.labels).sort(), ["outcome", "role", "stage"])
  } finally {
    await close(host.server)
    await close(remote.server)
  }
})

test("concurrent host/service correlation isolates bodies and service diagnostics/metrics even when sinks throw", async () => {
  const remoteApp = express()
  const remote = await listen(remoteApp)
  const headers: Record<string, string | string[] | undefined>[] = []
  remoteApp.use((req, _res, next) => {
    if (req.method === "POST") headers.push({ ...req.headers })
    next()
  })
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/correlation-"))
  const events: Diagnostic[] = []
  const metrics: Metric[] = []
  const inputs: any[] = []
  let mode = "ok"
  const manifest = {
    protocolVersion: 1 as const,
    moduleId: "fixture",
    releaseId: "v1",
    reactVersion: "19.3.0",
    renderUrl: `${remote.origin}/releases/v1/render`,
    islands: {},
  }
  const release = await publishedRelease(
    resolve(directory, "releases"),
    manifest,
    (input) => {
      inputs.push(input)
      if (mode === "render") throw new Error("SECRET-renderer")
      return {
        protocolVersion: 1,
        moduleId: mode === "identity" ? "other" : "fixture",
        releaseId: "v1",
        html: mode === "html" ? "<script>SECRET-script</script>" : `<p>${(input.props as any).value}</p>`,
        islands: [],
      }
    },
    { "shared.js": "export const value = 1;" },
  )
  remoteApp.use(
    createModuleService({
      releases: [release],
      allowedHostOrigins: [],
      integrityCheckIntervalMs: 1,
      onDiagnostic: (event) => {
        events.push(event)
        throw new Error("SECRET-sink")
      },
      onMetric: (metric) => {
        metrics.push(metric)
        throw new Error("SECRET-metric")
      },
    }),
  )
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
      routes: {
        "/": [
          {
            name: "main",
            moduleId: "fixture",
            props: (req) => ({ value: String(req.query.value) }),
            fallback: "<p>fallback</p>",
          },
        ],
      },
    }),
  )
  try {
    const responses = await Promise.all(
      ["alpha", "beta"].map((value) =>
        fetch(`${host.origin}/?value=${value}`, {
          headers: { Authorization: "SECRET", Cookie: "SECRET" },
        }),
      ),
    )
    const ids = responses.map((response) => response.headers.get(correlationHeader))
    assert.notEqual(ids[0], ids[1])
    for (const [index, response] of responses.entries()) {
      assert.match(await response.text(), new RegExp(index === 0 ? "alpha" : "beta"))
      const header = headers.find((item) => item[correlationHeader] === ids[index])!
      assert.ok(header)
      assert.equal(header.authorization, undefined)
      assert.equal(header.cookie, undefined)
      assert.equal(header["x-islands-slot"], "0")
      assert.ok(
        inputs.some(
          (input) =>
            input.instanceId.startsWith(`r${ids[index]!.replaceAll("-", "")}-`) &&
            input.props.value === (index === 0 ? "alpha" : "beta"),
        ),
      )
    }
    for (mode of ["render", "identity", "html"]) {
      await (await fetch(host.origin)).text()
      const event = events.at(-1)!
      assert.equal(event.category, mode)
      assert.equal(event.role, "service")
      assert.equal(event.moduleId, "fixture")
      assert.equal(event.releaseId, "v1")
      assert.equal(event.slot, "0")
    }
    const invalid = await fetch(manifest.renderUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [correlationHeader]: "SECRET-header",
        "x-islands-slot": "SECRET-slot",
      },
      body: '{"SECRET":true}',
    })
    assert.equal(invalid.status, 400)
    assert.equal(correlationId(invalid.headers.get(correlationHeader)!), invalid.headers.get(correlationHeader))
    assert.equal(events.at(-1)!.category, "protocol")
    assert.equal(events.at(-1)!.slot, undefined)
    await unlink(resolve(release.assetsDirectory, "shared.js"))
    await new Promise((done) => setTimeout(done, 5))
    assert.equal((await fetch(`${remote.origin}/releases/v1/readyz`)).status, 503)
    assert.equal(events.at(-1)!.category, "integrity")
    assert.doesNotMatch(JSON.stringify({ events, metrics }), /SECRET|alpha|beta|props|authorization|cookie/)
    for (const metric of metrics) assert.deepEqual(Object.keys(metric.labels).sort(), ["outcome", "role", "stage"])
    assert.ok(metrics.some((metric) => metric.labels.stage === "render" && metric.labels.outcome === "ok"))
  } finally {
    await close(host.server)
    await close(remote.server)
  }
})

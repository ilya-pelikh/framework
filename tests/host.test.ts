import { test } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { mkdtemp, mkdir, writeFile, rename } from "node:fs/promises"
import { resolve } from "node:path"
import http from "node:http"
import { createHost, type Diagnostic } from "../packages/server/src/host.ts"

test("host composes SSR, isolates failures, pins releases, bounds fetches and isolates credentials", async () => {
  const remote = express()
  remote.use(express.json())
  let origin = ""
  let mode = "ok"
  let blockedHits = 0
  let renders = 0
  const received: any[] = []
  const diagnostics: Diagnostic[] = []
  let onManifest: (() => Promise<void>) | undefined
  remote.get("/releases/:release/manifest.json", async (req, res) => {
    if (onManifest) {
      const action = onManifest
      onManifest = undefined
      await action()
    }
    if (mode === "timeout") {
      await new Promise((done) => setTimeout(done, 300))
    }
    if (mode === "redirect") {
      res.redirect("http://127.0.0.1:1/blocked")
      return
    }
    if (mode === "manifest-large") {
      res.json({ data: "x".repeat(70000) })
      return
    }
    if (mode === "status") {
      res.sendStatus(503)
      return
    }
    const releaseId = req.params.release
    res.json({
      protocolVersion: mode === "version" ? 2 : 1,
      moduleId: "fixture",
      releaseId: mode === "release" ? "wrong" : releaseId,
      reactVersion: "19.3.0",
      renderUrl: mode === "origin" ? "http://127.0.0.1:1/releases/v1/render" : `${origin}/releases/${releaseId}/render`,
      islands: {},
    })
  })
  remote.post("/releases/:release/render", (req, res) => {
    renders++
    received.push({ headers: req.headers, body: req.body })
    if (mode === "render-large") {
      res.json({ data: "x".repeat(1050000) })
      return
    }
    if (mode === "render-invalid") {
      res.json({})
      return
    }
    res.json({
      protocolVersion: 1,
      moduleId: "fixture",
      releaseId: req.params.release,
      html: `<p>${req.body.props.value ?? "initial"} ${req.params.release}</p>`,
      islands: [],
    })
  })
  remote.get("/blocked", (_req, res) => {
    blockedHits++
    res.sendStatus(500)
  })
  const service = remote.listen(0)
  await new Promise<void>((done) => service.once("listening", done))
  origin = `http://localhost:${(service.address() as any).port}`
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/host-"))
  const registryPath = resolve(directory, "registry.json")
  async function switchTo(releaseId: string) {
    await writeFile(
      `${registryPath}.next`,
      JSON.stringify({
        fixture: {
          releaseId,
          manifestUrl: `${origin}/releases/${releaseId}/manifest.json`,
        },
      }),
    )
    await rename(`${registryPath}.next`, registryPath)
  }
  const options = {
    registryPath,
    allowedOrigins: [origin],
    bootstrapUrl: "/bootstrap.js",
    limits: { timeoutMs: 1500 },
    routes: {
      "/": [
        {
          name: "main",
          moduleId: "fixture",
          props: (req: any) => ({
            value: String(req.query.value ?? "initial"),
          }),
          fallback: "<p>fallback</p>",
        },
        {
          name: "neighbor",
          moduleId: "missing",
          props: {},
          fallback: "<p>neighbor</p>",
        },
      ],
      "/broken": [],
    },
    context: () => ({
      locale: "en",
      authorization: "SECRET",
      private: "SECRET",
    }),
    allowedContextKeys: ["locale", "authorization"],
    onDiagnostic: (item: Diagnostic) => diagnostics.push(item),
    shell: (slots: Record<string, string>) => {
      if (!slots.main) throw new Error("secret stack")
      return `<main>${slots.main}${slots.neighbor}</main>`
    },
  }
  const host = createHost({ ...options, manifestCache: false }).listen(0)
  await new Promise<void>((done) => host.once("listening", done))
  const hostOrigin = `http://localhost:${(host.address() as any).port}`
  try {
    assert.equal((await fetch(`${hostOrigin}/readyz`)).status, 503)
    await switchTo("v1")
    assert.equal((await fetch(`${hostOrigin}/readyz`)).status, 200)
    assert.equal((await fetch(`${hostOrigin}/unknown`)).status, 404)
    const broken = await fetch(`${hostOrigin}/broken`)
    assert.equal(broken.status, 500)
    assert.doesNotMatch(await broken.text(), /secret/)
    const response = await fetch(hostOrigin)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.match(await response.text(), /initial v1/)
    const pages = await Promise.all(
      ["alpha", "beta"].map((value) =>
        fetch(`${hostOrigin}/?value=${value}`, {
          headers: { cookie: "SECRET", authorization: "SECRET" },
        }).then((r) => r.text()),
      ),
    )
    assert.match(pages[0]!, /alpha v1/)
    assert.doesNotMatch(pages[0]!, /beta/)
    assert.match(pages[1]!, /beta v1/)
    for (const request of received) {
      assert.equal(request.headers.cookie, undefined)
      assert.equal(request.headers.authorization, undefined)
      assert.deepEqual(request.body.context, { locale: "en" })
    }
    onManifest = () => switchTo("v2")
    assert.match(await (await fetch(hostOrigin)).text(), /initial v1/)
    assert.match(await (await fetch(hostOrigin)).text(), /initial v2/)
    await switchTo("v1")
    assert.match(await (await fetch(hostOrigin)).text(), /initial v1/)
    for (const failure of [
      "timeout",
      "redirect",
      "manifest-large",
      "status",
      "version",
      "release",
      "origin",
      "render-large",
      "render-invalid",
    ]) {
      mode = failure
      options.limits.timeoutMs = failure === "timeout" ? 100 : 1500
      const before = renders
      const response = await fetch(hostOrigin)
      const html = await response.text()
      assert.equal(response.status, 200, failure)
      assert.match(html, /fallback/, failure)
      assert.match(html, /neighbor/, failure)
      if (!failure.startsWith("render-")) assert.equal(renders, before, failure)
    }
    assert.equal(blockedHits, 0)
    assert.equal((await fetch(`${hostOrigin}/readyz`)).status, 200)
    assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET|alpha|beta/)
    mode = "timeout"
    await new Promise<void>((done) => {
      const request = http.get(hostOrigin)
      request.on("error", () => done())
      setTimeout(() => request.destroy(), 20)
    })
    await new Promise((done) => setTimeout(done, 30))
    assert.ok(diagnostics.some((item) => item.category === "disconnect"))
  } finally {
    for (const server of [host, service]) {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }
})

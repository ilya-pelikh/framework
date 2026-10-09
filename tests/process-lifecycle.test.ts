import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createServer, connect } from "node:net"
import { once } from "node:events"
import express from "express"
import { startApps } from "../scripts/start.ts"
import { createHost, createHttpServer } from "@islands/server"
import { listen, close } from "./helpers/http-server.ts"
import { deadline } from "./helpers/browser-session.ts"

async function freePorts() {
  const probes = [createServer(), createServer(), createServer()]
  try {
    await Promise.all(probes.map((probe) => new Promise<void>((done) => probe.listen(0, done))))
    return probes.map((probe) => (probe.address() as { port: number }).port) as [number, number, number]
  } finally {
    await Promise.all(probes.map((probe) => new Promise<void>((done) => probe.close(() => done()))))
  }
}

for (const mode of ["hung", "exit", "ready"] as const) {
  test(
    `orchestrator bounds ${mode} startup/shutdown and leaves unrelated processes alone`,
    { timeout: 10000 },
    async () => {
      await mkdir(".cache", { recursive: true })
      const base = await mkdtemp(resolve(".cache/lifecycle-"))
      const ports = await freePorts()
      const unrelated = await listen(express().get("/healthz", (_req, res) => res.sendStatus(200)))
      for (const app of ["host", "catalog", "cart"]) {
        const directory = resolve(base, `apps/${app}/dist`)
        await mkdir(directory, { recursive: true })
        const source =
          mode === "exit" && app === "host"
            ? "process.exit(9);"
            : `import { createServer } from 'node:http'; process.on('SIGTERM', () => {}); process.on('message', () => {}); createServer((_req, res) => { ${mode === "ready" ? 'res.end("ok");' : ""} }).listen(Number(process.env.PORT));`
        await writeFile(resolve(directory, "server.mjs"), source)
      }
      const options = {
        ports,
        startupTimeoutMs: 700,
        probeTimeoutMs: 100,
        shutdownGraceMs: 100,
        shutdownForceMs: 1000,
      }
      const started = performance.now()
      try {
        if (mode === "ready") {
          const running = await startApps(base, false, options)
          assert.equal(
            (
              await fetch(`http://localhost:${ports[0]}/`, {
                signal: AbortSignal.timeout(1000),
              })
            ).status,
            200,
          )
          await Promise.all([running.stop(), running.stop()])
        } else await assert.rejects(startApps(base, false, options), /Startup deadline|App exited/)
        assert.ok(performance.now() - started < 4000)
        for (const port of ports) {
          const probe = createServer()
          await new Promise<void>((done, reject) => {
            probe.once("error", reject)
            probe.listen(port, done)
          })
          await new Promise<void>((done) => probe.close(() => done()))
        }
        assert.equal(
          (
            await fetch(`${unrelated.origin}/healthz`, {
              signal: AbortSignal.timeout(1000),
            })
          ).status,
          200,
        )
      } finally {
        await close(unrelated.server)
      }
    },
  )
}

test("HTTP header/body/socket work and long-request shutdown have finite limits", { timeout: 10000 }, async () => {
  let drains = 0
  let received!: () => void
  let requestStarted = new Promise<void>((done) => {
    received = done
  })
  const running = createHttpServer((_req, _res) => received(), {
    requestTimeoutMs: 300,
    headersTimeoutMs: 100,
    socketTimeoutMs: 300,
    keepAliveTimeoutMs: 100,
    maxHeaderBytes: 256,
    maxRequestsPerSocket: 2,
    shutdownGraceMs: 100,
    onDrain: () => {
      drains++
    },
  })
  running.server.listen(0)
  await once(running.server, "listening")
  const port = (running.server.address() as { port: number }).port
  try {
    for (const bytes of [
      "GET / HTTP/1.1\r\nHost: localhost\r\nX-Slow:",
      "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx",
      `GET / HTTP/1.1\r\nHost: localhost\r\nX-Large: ${"x".repeat(300)}\r\n\r\n`,
    ]) {
      const socket = connect(port)
      socket.on("error", () => {})
      socket.resume()
      const closed = new Promise<void>((done) => socket.once("close", () => done()))
      socket.write(bytes)
      await deadline(closed, 1500)
    }
    requestStarted = new Promise<void>((done) => {
      received = done
    })
    const socket = connect(port)
    socket.on("error", () => {})
    socket.resume()
    const closed = new Promise<void>((done) => socket.once("close", () => done()))
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
    await deadline(requestStarted, 1000)
    const started = performance.now()
    await Promise.all([running.stop(), running.stop(), deadline(closed, 1000)])
    assert.equal(drains, 1)
    assert.ok(performance.now() - started < 1000)
  } finally {
    await running.stop()
  }
})

test("host drain cancels an active upstream body and refuses further admission", { timeout: 10000 }, async () => {
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/drain-"))
  const app = express()
  const remote = await listen(app)
  let bodyStarted!: () => void
  let bodyClosed!: () => void
  const started = new Promise<void>((done) => {
    bodyStarted = done
  })
  const closed = new Promise<void>((done) => {
    bodyClosed = done
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
    res.type("json").write("{")
    res.once("close", bodyClosed)
    bodyStarted()
  })
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
  const controller = new AbortController()
  const host = await listen(
    createHost({
      signal: controller.signal,
      registryPath,
      allowedOrigins: [remote.origin],
      bootstrapUrl: "/bootstrap.js",
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
  const response = fetch(host.origin, {
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined)
  try {
    await deadline(started, 1000)
    controller.abort()
    await deadline(closed, 1000)
    assert.equal((await fetch(host.origin, { signal: AbortSignal.timeout(1000) })).status, 503)
  } finally {
    await close(host.server)
    await close(remote.server)
    await response
  }
})

test("lifecycle configurations reject zero, infinite and inconsistent limits", async () => {
  for (const value of [0, -1, Infinity, NaN, 0.5]) {
    assert.throws(() => createHttpServer(() => {}, { headersTimeoutMs: value }))
    await assert.rejects(startApps(".", false, { startupTimeoutMs: value }))
  }
  assert.throws(() =>
    createHttpServer(() => {}, {
      headersTimeoutMs: 1000,
      requestTimeoutMs: 500,
    }),
  )
  await assert.rejects(startApps(".", false, { ports: [1, 1, 2] }))
})

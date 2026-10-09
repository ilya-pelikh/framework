import { test } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { productionHeaders } from "@islands/server"
import { listen, close } from "./helpers/http-server.ts"

test("production policy rejects noncanonical origins and header/CSP injection", () => {
  for (const origin of [
    "http://module.example",
    "https://*.example",
    "https://module.example/",
    "https://user@module.example",
    "https://module.example:443",
    "https://module.example;unsafe-inline",
    "https://module.example\r\nX-Test: yes",
    "https://MODULE.example",
    "https://module.example 'unsafe-inline'",
  ]) {
    assert.throws(() => productionHeaders([origin]))
  }
  assert.throws(() => productionHeaders(Array(65).fill("https://module.example")))
  assert.doesNotThrow(() => productionHeaders(["https://[::1]:4443"]))
})

test("production headers cover success and error responses with an immutable allowlist", async () => {
  const origins = ["https://module.example"]
  const app = express()
  app.use(productionHeaders(origins))
  origins.push("https://evil.example")
  app.get("/", (_req, res) => res.send("ok"))
  app.get("/private", (_req, res) => res.sendStatus(401))
  const remote = await listen(app)
  try {
    for (const [path, status] of [
      ["/", 200],
      ["/private", 401],
      ["/missing", 404],
    ] as const) {
      const response = await fetch(remote.origin + path)
      assert.equal(response.status, status)
      assert.equal(response.headers.get("x-content-type-options"), "nosniff")
      assert.equal(response.headers.get("referrer-policy"), "no-referrer")
      assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000")
      assert.equal(response.headers.get("x-powered-by"), null)
      const policy = response.headers.get("content-security-policy")!
      if (status === 404) assert.equal(policy, "default-src 'none'")
      else {
        assert.match(policy, /script-src 'self' https:\/\/module.example;/)
        assert.match(policy, /frame-ancestors 'none'/)
      }
      assert.doesNotMatch(policy, /unsafe-|evil|\*/)
      await response.arrayBuffer()
    }
  } finally {
    await close(remote.server)
  }
})

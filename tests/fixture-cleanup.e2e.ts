import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createServer } from "node:net"
import express from "express"
import { runtimeBrowser, listen, close } from "./helpers/runtime-browser.ts"
import { failureArtifacts } from "./helpers/failure-artifacts.ts"

for (const failure of ["launch", "setup", "hung-setup"] as const) {
  test(
    `failed fixture ${failure} frees only owned ports and saves bounded secret-free artifacts`,
    { timeout: 30000 },
    async () => {
      const unrelated = await listen(express().get("/healthz", (_req, res) => res.sendStatus(200)))
      const artifacts = await failureArtifacts()
      let origin = ""
      const secret = "DO-NOT-RECORD-credentials-props-query-error"
      try {
        const started = performance.now()
        await assert.rejects(
          runtimeBrowser({
            onListening: (value) => {
              origin = value
            },
            session: {
              artifacts,
              timeoutMs: failure === "hung-setup" ? 1500 : 5000,
              ...(failure === "launch"
                ? {
                    launch: {
                      executablePath: resolve(".cache/nonexistent-browser"),
                    },
                  }
                : {}),
              setup: async (context) => {
                if (failure === "hung-setup") await new Promise(() => {})
                const page = await context.newPage()
                await context.setExtraHTTPHeaders({ Authorization: secret })
                await page.goto(`${origin}/empty?token=${secret}`)
                await page.evaluate((value) => {
                  console.error(value)
                  setTimeout(() => {
                    throw new Error(value)
                  })
                }, secret)
                await page.waitForTimeout(50)
                throw new Error(secret)
              },
            },
          }),
        )
        assert.ok(performance.now() - started < 22000)
        assert.ok(origin)
        const probe = createServer()
        await new Promise<void>((done, reject) => {
          probe.once("error", reject)
          probe.listen(Number(new URL(origin).port), done)
        })
        await new Promise<void>((done) => probe.close(() => done()))
        assert.equal(
          (
            await fetch(`${unrelated.origin}/healthz`, {
              signal: AbortSignal.timeout(1000),
            })
          ).status,
          200,
        )
        for (const file of ["trace.json", "console.json", "network.json"]) {
          const contents = await readFile(resolve(artifacts.directory, file), "utf8")
          assert.equal(contents.includes(secret), false)
          assert.equal(contents.includes("Authorization"), false)
          assert.equal(contents.includes(origin), false)
          assert.ok(contents.length < 1024 * 1024)
          const parsed = JSON.parse(contents)
          if (failure === "setup") assert.ok((parsed.events ?? parsed.traceEvents).length > 0, file)
        }
        const trace = JSON.parse(await readFile(resolve(artifacts.directory, "trace.json"), "utf8"))
        assert.ok(trace.traceEvents.some((event: any) => event.name === "failed"))
        assert.ok(trace.traceEvents.some((event: any) => event.name === "closed"))
      } finally {
        await close(unrelated.server)
      }
    },
  )
}

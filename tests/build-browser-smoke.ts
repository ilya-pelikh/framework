import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import express from "express"
import { browserSession } from "./helpers/browser-session.ts"
import { close } from "./helpers/http-server.ts"

test("independent cross-origin browser build", { timeout: 120000 }, async (testContext) => {
  const directory = resolve(".cache/build-smoke/releases/fixture-v1")
  const manifest = JSON.parse(await readFile(resolve(directory, "assets/manifest.json"), "utf8"))
  const { render } = await import(pathToFileURL(resolve(directory, "server/server.mjs")).href)
  const assets = express()
  assets.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:4310")
    next()
  })
  assets.use("/releases/fixture-v1/assets", express.static(resolve(directory, "assets")))
  const host = express()
  host.get("/favicon.ico", (_req, res) => res.sendStatus(204))
  host.get("/", (_req, res) =>
    res.send(
      `<!doctype html><html><head>${manifest.entries.counter.initial.css.map((url: string) => `<link rel="stylesheet" href="${url}">`).join("")}</head><body><div id="counter">${render()}</div></body></html>`,
    ),
  )
  const servers = [assets.listen(4311), host.listen(4310)]
  testContext.after(() => Promise.all(servers.map(close)))
  try {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((done, reject) => {
            server.once("listening", done)
            server.once("error", reject)
          }),
      ),
    )
    const session = await browserSession()
    testContext.after(session.stop)
    try {
      const page = await session.context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text())
      })
      await page.goto("http://localhost:4310")
      const entry = manifest.entries.counter.initial.js.find((url: string) => /\/counter\./.test(url))
      await page.evaluate(async (url: string) => {
        const entry = await import(url)
        entry.hydrate(document.getElementById("counter"))
      }, entry)
      await page.getByRole("button").click()
      await page.getByRole("button", { name: "Count 2" }).waitFor()
      assert.equal(
        await page.getByRole("button").evaluate((element) => getComputedStyle(element).color),
        "rgb(12, 34, 56)",
      )
      assert.deepEqual(errors, [])
      session.assertHealthy(page)
      console.log("PASS: Node SSR, cross-origin ESM/chunks, CSS and interactive hydration")
    } finally {
      await session.stop()
    }
  } finally {
    await Promise.all(servers.map(close))
  }
})

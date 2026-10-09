import { test } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createHost } from "../packages/server/src/host.ts"
import { runtimeBrowser, listen, close } from "./helpers/runtime-browser.ts"

test(
  "HTTP composition rejects invalid slots and preserves a cross-origin interactive neighbor",
  { timeout: 30000 },
  async (testContext) => {
    const fixture = await runtimeBrowser({ test: testContext })
    const remote = express()
    remote.use(express.json())
    const service = await listen(remote)
    let mode = "ok"
    let shellCalls = 0
    const errors: string[] = []
    try {
      remote.get("/releases/v1/manifest.json", (_req, res) =>
        res.json({
          protocolVersion: 1,
          moduleId: "fixture",
          releaseId: "v1",
          reactVersion: "19.3.0",
          renderUrl: `${service.origin}/releases/v1/render`,
          islands: {
            button: {
              clientEntryUrl: `${service.origin}/releases/v1/assets/button.js`,
              cssUrls: [],
            },
          },
        }),
      )
      remote.get("/releases/v1/assets/button.js", (_req, res) => {
        res.setHeader("Access-Control-Allow-Origin", fixture.origin)
        res
          .type("js")
          .send(
            'export function hydrate(element) { const button = element.querySelector("button"); button.disabled = false; button.onclick = () => button.textContent = "clicked"; return () => button.onclick = null; }',
          )
      })
      remote.post("/releases/v1/render", (req, res) => {
        const id = `${req.body.instanceId}-button`
        let html = `<div id="${id}" data-island="button"><button disabled>${req.body.props.name}</button></div>`
        if (req.body.props.name === "first") {
          if (mode === "reserved") html += '<div id="islands-payload">[]</div>'
          if (mode === "marker") html += "<!--islands-slot:forged-->"
          if (mode === "template") html = `<template>${html}</template>`
          if (mode === "nested") html = `<div data-island="button" id="outer">${html}</div>`
          if (mode === "shell") html += '<span id="shell-owned"></span>'
        }
        if (mode === "collision") html += '<span id="shared-id"></span>'
        res.json({
          protocolVersion: 1,
          moduleId: "fixture",
          releaseId: "v1",
          html,
          islands: [
            {
              id,
              islandKey: "button",
              identifierPrefix: `${id}-`,
              props: {},
              policy: "load",
            },
          ],
        })
      })
      const registryPath = resolve(fixture.directory, "registry.json")
      await writeFile(
        registryPath,
        JSON.stringify({
          fixture: {
            releaseId: "v1",
            manifestUrl: `${service.origin}/releases/v1/manifest.json`,
          },
        }),
      )
      fixture.app.use(
        createHost({
          registryPath,
          allowedOrigins: [service.origin],
          bootstrapUrl: "/bootstrap.js",
          routes: {
            "/": ["first", "second"].map((name) => ({
              name,
              moduleId: "fixture",
              props: { name },
              fallback: `<p>${name}-fallback</p>`,
            })),
          },
          shell: (slots) => {
            shellCalls++
            if (mode === "omitted") return slots.first!
            if (mode === "duplicated") return `${slots.first}${slots.first}${slots.second}`
            return `<main>${slots.second}${slots.first}</main><footer id="shell-owned">shell</footer>`
          },
        }),
      )
      const page = await fixture.context.newPage()
      page.on("pageerror", (error) => errors.push(error.message))
      for (mode of ["reserved", "marker", "template", "nested", "shell", "collision", "ok"]) {
        const before = shellCalls
        const response = await page.goto(fixture.origin)
        assert.equal(response!.status(), 200, mode)
        assert.equal(shellCalls, before + 1, mode)
        const rejected = mode === "collision" ? "second" : mode === "ok" ? undefined : "first"
        if (rejected) assert.equal(await page.getByText(`${rejected}-fallback`, { exact: true }).count(), 1, mode)
        const neighbor = mode === "collision" ? "first" : "second"
        const button = page.getByRole("button", {
          name: neighbor,
          exact: true,
        })
        await button.click()
        assert.equal(await page.getByRole("button", { name: "clicked", exact: true }).count(), 1, mode)
        assert.equal(await page.locator("#islands-payload").count(), 1, mode)
        const payload = JSON.parse((await page.locator("#islands-payload").textContent())!)
        assert.equal(payload.length, mode === "ok" ? 2 : 1, mode)
        fixture.assertHealthy(page)
      }
      for (mode of ["omitted", "duplicated"]) {
        const before = shellCalls
        const response = await fetch(fixture.origin)
        assert.equal(response.status, 500, mode)
        assert.equal(shellCalls, before + 1, mode)
        assert.equal(await response.text(), "<!doctype html><h1>Page unavailable</h1>")
      }
      assert.deepEqual(errors, [])
    } finally {
      await close(service.server)
      await fixture.stop()
    }
  },
)

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdtemp, mkdir, cp, readFile, writeFile, rename, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { createRsbuild } from "@rsbuild/core"
import { sha256 } from "@islands/contracts/integrity"
import { buildAttestor } from "../scripts/build-attestor.ts"
import { legacyFixture } from "./helpers/legacy-release.ts"

function messageFrom(child: ChildProcess) {
  return new Promise<any>((done, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.off("message", receive)
      child.off("exit", exit)
      child.off("error", error)
    }
    const receive = (message: unknown) => {
      cleanup()
      done(message)
    }
    const exit = () => {
      cleanup()
      reject(new Error("Staging child exited"))
    }
    const error = () => {
      cleanup()
      reject(new Error("Staging child launch failed"))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("Staging child deadline"))
    }, 10000)
    child.once("message", receive)
    child.once("exit", exit)
    child.once("error", error)
  })
}

test(
  "trusted offline migration then v1/v2/rollback runs with Node-only artifacts outside source tree",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "islands-migration-"))
    const tools = resolve(root, "tools")
    const attestor = await buildAttestor(tools)
    const builder = await createRsbuild({
      config: {
        source: {
          entry: { rehearsal: resolve("tests/fixtures/migration-runner.ts") },
        },
        output: {
          target: "node",
          module: true,
          autoExternal: false,
          cleanDistPath: false,
          distPath: { root: tools },
          filename: { js: "[name].mjs" },
        },
        tools: {
          htmlPlugin: false,
          rspack: { module: { parser: { javascript: { importMeta: false } } } },
        },
      },
    })
    const build = await builder.build()
    await build.close()
    const runner = resolve(tools, "rehearsal.mjs")
    const originalRunner = sha256(await readFile(runner))
    const child = spawn(process.execPath, [runner], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    })
    child.stdout?.resume()
    child.stderr?.resume()
    const exited = new Promise<void>((done) => child.once("exit", () => done()))
    try {
      const { host, remote } = await messageFrom(child)
      const request = (url: string, options: RequestInit = {}) =>
        fetch(url, { ...options, signal: AbortSignal.timeout(5000) })
      assert.equal((await request(`${remote}/readyz`)).status, 503)
      assert.equal((await request(`${host}/readyz`)).status, 503)
      const snapshots = []
      await mkdir(resolve(root, "offline/releases"), { recursive: true })
      for (const releaseId of ["v1", "v2"]) {
        const renderer = `export function render(input) { return { protocolVersion: 1, moduleId: input.moduleId, releaseId: input.releaseId, html: "<p>${releaseId}</p>", islands: [] }; }`
        const snapshot = await legacyFixture(renderer, resolve(root, "trusted-ci"), remote, releaseId)
        snapshots.push(snapshot)
        const target = resolve(root, `offline/releases/${releaseId}`)
        await cp(snapshot.directory, target, {
          recursive: true,
          errorOnExist: true,
          force: false,
        })
        const result = spawnSync(
          process.execPath,
          [
            attestor,
            "--directory",
            target,
            "--inventory",
            snapshot.evidence,
            "--sha256",
            snapshot.digest,
            "--module-id",
            "fixture",
            "--release-id",
            releaseId,
          ],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 15000,
            windowsHide: true,
            env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
          },
        )
        assert.equal(result.status, 0, result.stderr)
        assert.equal(JSON.parse(result.stdout).expectedInventorySha256, snapshot.digest)
        for (const [path, bytes] of Object.entries(snapshot.original))
          assert.equal(sha256(await readFile(resolve(target, path))), sha256(bytes))
      }
      await rename(resolve(root, "offline"), resolve(root, "live"))
      const loaded = messageFrom(child)
      child.send("reload")
      assert.equal(await loaded, "loaded")
      assert.equal((await request(`${remote}/healthz`)).status, 200)
      assert.equal((await request(`${remote}/readyz`)).status, 200)
      for (const releaseId of ["v1", "v2"]) {
        assert.equal((await request(`${remote}/releases/${releaseId}/readyz`)).status, 200)
        assert.equal((await request(`${remote}/releases/${releaseId}/manifest.json`)).status, 200)
        const rendered = await request(`${remote}/releases/${releaseId}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocolVersion: 1,
            moduleId: "fixture",
            releaseId,
            instanceId: "main",
            props: {},
            context: {},
          }),
        })
        assert.equal(rendered.status, 200)
        assert.equal((await rendered.json()).html, `<p>${releaseId}</p>`)
        for (const asset of ["counter.js", "lazy.js"]) {
          const response = await request(`${remote}/releases/${releaseId}/assets/${asset}`, {
            headers: { Origin: host },
          })
          assert.equal(response.status, 200)
          assert.match(response.headers.get("content-type")!, /javascript/)
          assert.equal(response.headers.get("access-control-allow-origin"), host)
        }
      }
      for (const releaseId of ["v1", "v2", "v1"]) {
        await writeFile(
          resolve(root, "registry.next.json"),
          JSON.stringify({
            fixture: {
              releaseId,
              manifestUrl: `${remote}/releases/${releaseId}/manifest.json`,
            },
          }),
        )
        await rename(resolve(root, "registry.next.json"), resolve(root, "registry.json"))
        assert.equal((await request(`${host}/readyz`)).status, 200)
        const page = await request(host)
        assert.equal(page.status, 200)
        assert.match(await page.text(), new RegExp(`<p>${releaseId}</p>`))
      }
      for (const snapshot of snapshots)
        for (const [path, bytes] of Object.entries(snapshot.original)) {
          assert.equal(
            sha256(await readFile(resolve(root, "live/releases", snapshot.identity.releaseId, path))),
            sha256(bytes),
          )
        }
      assert.equal(sha256(await readFile(runner)), originalRunner)
      const paths = await readdir(root, { recursive: true })
      assert.equal(
        paths.some((path) => /(^|[/\\])(node_modules|src)([/\\]|$)|\.(tsx?|map)$/.test(path)),
        false,
      )
      await writeFile(
        resolve(root, "evidence.json"),
        JSON.stringify(
          {
            result: "passed",
            node: process.version,
            platform: process.platform,
            runnerSha256: originalRunner,
            inventories: snapshots.map((snapshot) => ({
              ...snapshot.identity,
              sha256: snapshot.digest,
            })),
            sequence: ["offline-attestation", "promotion", "v1", "v2", "v1"],
          },
          null,
          2,
        ),
      )
      console.log(`PASS: source-free migration/rollback evidence: ${root}`)
    } finally {
      if (child.connected) child.disconnect()
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
      try {
        await exited
      } finally {
        clearTimeout(timer)
      }
    }
  },
)

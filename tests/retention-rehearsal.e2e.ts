import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { access, mkdtemp, readFile, writeFile, rename, readdir, lstat, realpath, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, relative, sep } from "node:path"
import { createHash } from "node:crypto"
import { createRsbuild } from "@rsbuild/core"
import { buildRelease } from "@islands/rsbuild"
import { browserSession } from "./helpers/browser-session.ts"
import { stopOwnedChild } from "../scripts/process-lifecycle.ts"
import { retirementEligibility } from "../scripts/retention.ts"

function nextMessage(child: ChildProcess) {
  return new Promise<any>((done, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.off("message", received)
      child.off("error", failed)
      child.off("exit", failed)
    }
    const received = (message: unknown) => {
      cleanup()
      done(message)
    }
    const failed = () => {
      cleanup()
      reject(new Error("Rehearsal child failed"))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("Rehearsal child deadline"))
    }, 10000)
    child.once("message", received)
    child.once("error", failed)
    child.once("exit", failed)
  })
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  async function walk(current: string) {
    for (const name of (await readdir(current)).sort()) {
      const path = resolve(current, name)
      const stat = await lstat(path)
      assert.equal(stat.isSymbolicLink(), false)
      if (stat.isDirectory()) await walk(path)
      else {
        assert.ok(stat.isFile())
        files[relative(directory, path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
      }
    }
  }
  await walk(directory)
  return files
}

test(
  "source-free retention rehearsal preserves cold v1 assets and rolls back without rebuilding host/cart",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "islands-retention-"))
    const builder = await createRsbuild({
      config: {
        environments: {
          server: {
            source: {
              entry: { server: resolve("tests/fixtures/retention-runner.ts") },
            },
            output: {
              target: "node",
              module: true,
              autoExternal: false,
              cleanDistPath: false,
              distPath: { root },
              filename: { js: "[name].mjs" },
            },
          },
          browser: {
            source: {
              entry: { bootstrap: resolve("apps/host/src/bootstrap.ts") },
            },
            output: {
              target: "web",
              module: true,
              distPath: { root: resolve(root, "assets"), js: "" },
              filename: { js: "[name].js" },
            },
            tools: { htmlPlugin: false },
          },
        },
      },
    })
    const built = await builder.build()
    await built.close()
    await assert.rejects(access(resolve(root, "node_modules")))
    await assert.rejects(access(resolve(root, "src")))
    const binaryHash = createHash("sha256")
      .update(await readFile(resolve(root, "server.mjs")))
      .digest("hex")
    const browserBefore = await snapshot(resolve(root, "assets"))
    const child = spawn(process.execPath, [resolve(root, "server.mjs")], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    })
    let session: Awaited<ReturnType<typeof browserSession>> | undefined
    try {
      const origins = (await nextMessage(child)) as {
        host: string
        catalog: string
        cart: string
      }
      const command = async (action: string, module: string) => {
        const answer = nextMessage(child)
        child.send({ action, module })
        assert.equal(await answer, "ok")
      }
      const request = (url: string) => fetch(url, { signal: AbortSignal.timeout(5000) })
      const probe = async (origin: string, path: string, status: number) => {
        const response = await request(origin + path)
        assert.equal(response.status, status)
        await response.arrayBuffer()
      }
      const catalogRoot = resolve(root, "catalog")
      const buildCatalog = (releaseId: string) =>
        buildRelease({
          root: process.cwd(),
          outDir: catalogRoot,
          moduleId: "catalog",
          releaseId,
          publicOrigin: origins.catalog,
          serverEntry: "tests/fixtures/recommendations/cold-fragment.ts",
          islands: {
            neighbor: "tests/fixtures/recommendations/entry.ts",
            delayed: "tests/fixtures/recommendations/deferred-entry.ts",
          },
        })
      await buildCatalog("v0")
      await buildCatalog("v1")
      await buildRelease({
        root: process.cwd(),
        outDir: resolve(root, "cart"),
        moduleId: "cart",
        releaseId: "v1",
        publicOrigin: origins.cart,
        serverEntry: "apps/cart/src/fragment.ts",
        islands: { cart: "apps/cart/src/entry.tsx" },
      })
      await command("reload", "catalog")
      await command("reload", "cart")
      const cartBefore = await snapshot(resolve(root, "cart/releases"))
      const v1Before = await snapshot(resolve(root, "catalog/releases/v1"))
      const registry = resolve(root, "registry.json")
      const switchTo = async (releaseId: string) => {
        await writeFile(
          `${registry}.next`,
          JSON.stringify({
            catalog: {
              releaseId,
              manifestUrl: `${origins.catalog}/releases/${releaseId}/manifest.json`,
            },
            cart: {
              releaseId: "v1",
              manifestUrl: `${origins.cart}/releases/v1/manifest.json`,
            },
          }),
        )
        await rename(`${registry}.next`, registry)
      }
      await probe(origins.host, "/readyz", 503)
      await switchTo("v1")
      for (const origin of Object.values(origins)) {
        await probe(origin, "/healthz", 200)
        await probe(origin, "/readyz", 200)
      }
      await probe(origins.catalog, "/releases/v1/readyz", 200)
      await probe(origins.catalog, "/releases/missing/readyz", 404)
      session = await browserSession()
      await session.context.addInitScript({
        content: "globalThis.__name = value => value;",
      })
      const page = await session.context.newPage()
      await page.addInitScript({
        content:
          "globalThis.requestIdleCallback = callback => { globalThis.releaseIdle = callback; return 1; }; globalThis.cancelIdleCallback = () => {};",
      })
      const requests: string[] = []
      const successes: string[] = []
      page.on("request", (request) => requests.push(request.url()))
      page.on("response", (response) => {
        if (response.ok()) successes.push(response.url())
      })
      const manifest = JSON.parse(await readFile(resolve(root, "catalog/releases/v1/manifest.json"), "utf8"))
      const graph = JSON.parse(await readFile(resolve(root, "catalog/releases/v1/assets/manifest.json"), "utf8"))
      const entry: string = manifest.islands.delayed.clientEntryUrl
      const chunk: string = graph.entries.delayed.async.js.find((url: string) => url.includes("/async/"))
      assert.ok(chunk)
      const first = await page.goto(origins.host)
      assert.equal(first!.headers()["cache-control"], "no-store")
      await page.getByRole("button", { name: "Neighbor" }).click()
      await page.getByRole("button", { name: "Add one" }).click()
      assert.ok(await page.getByRole("button", { name: "Deferred count 0" }).isDisabled())
      for (const url of [entry, chunk]) assert.equal(requests.includes(url), false)
      await buildCatalog("v2")
      await command("reload", "catalog")
      for (const releaseId of ["v1", "v2"]) await probe(origins.catalog, `/releases/${releaseId}/readyz`, 200)
      await switchTo("v2")
      const current = await session.context.newPage()
      await current.goto(origins.host)
      assert.equal(await current.locator('[data-deferred="v2"]').count(), 1)
      await current.getByRole("button", { name: "Deferred count 0" }).click()
      session.assertHealthy(current)
      const policy = {
        pageLifetimeMs: 500,
        rollbackWindowMs: 1000,
        propagationMs: 100,
        clockSkewMs: 10,
        retentionMs: 1110,
      }
      const now = 100000
      const decisions = {
        v0: retirementEligibility(
          policy,
          {
            selected: false,
            rollbackPinned: false,
            lastDeselectedAt: now - 1111,
          },
          now,
        ),
        v1: retirementEligibility(policy, { selected: false, rollbackPinned: false, lastDeselectedAt: now }, now),
        v2: retirementEligibility(policy, { selected: true, rollbackPinned: false, lastDeselectedAt: null }, now),
      }
      assert.equal(decisions.v0.eligible, true)
      assert.equal(decisions.v1.eligible, false)
      assert.equal(decisions.v2.eligible, false)
      const registryBefore = await readFile(registry, "utf8")
      await command("drain", "catalog")
      await assert.rejects(request(origins.catalog + "/readyz"))
      await probe(origins.host, "/readyz", 200)
      await probe(origins.cart, "/readyz", 200)
      const allowedRoot = await realpath(root)
      const retired = await realpath(resolve(root, "catalog/releases/v0"))
      assert.ok(retired.startsWith(allowedRoot + sep))
      assert.equal(retired, resolve(allowedRoot, "catalog/releases/v0"))
      await snapshot(retired)
      await mkdir(resolve(root, "quarantine"))
      const quarantine = resolve(await realpath(resolve(root, "quarantine")), "v0")
      assert.ok(quarantine.startsWith(allowedRoot + sep))
      assert.equal(await readFile(registry, "utf8"), registryBefore)
      assert.ok(decisions.v0.eligible)
      await rename(retired, quarantine)
      await command("reload", "catalog")
      await probe(origins.catalog, "/readyz", 200)
      await probe(origins.catalog, "/releases/v0/readyz", 404)
      for (const releaseId of ["v1", "v2"]) await probe(origins.catalog, `/releases/${releaseId}/readyz`, 200)
      assert.equal(await realpath(quarantine), resolve(allowedRoot, "quarantine/v0"))
      await rm(quarantine, { recursive: true })
      await assert.rejects(access(quarantine))
      const boundary = requests.length
      await page.evaluate(() => (globalThis as any).releaseIdle())
      await page.getByRole("button", { name: "Deferred count 0" }).click()
      assert.equal(await page.getByRole("button", { name: "Deferred count 1" }).count(), 1)
      for (const url of [entry, chunk]) {
        assert.ok(requests.slice(boundary).includes(url))
        assert.ok(successes.includes(url))
      }
      assert.equal(
        requests.some((url) => url.includes("/releases/v2/")),
        false,
      )
      await page.getByRole("button", { name: "Add one" }).click()
      await page.getByText("Quantity: 3", { exact: true }).waitFor()
      await switchTo("v1")
      await current.reload()
      assert.equal(await current.locator('[data-deferred="v1"]').count(), 1)
      await current.getByRole("button", { name: "Deferred count 0" }).click()
      await current.getByRole("button", { name: "Add one" }).click()
      session.assertHealthy(page)
      session.assertHealthy(current)
      assert.deepEqual(await snapshot(resolve(root, "catalog/releases/v1")), v1Before)
      assert.deepEqual(await snapshot(resolve(root, "cart/releases")), cartBefore)
      assert.deepEqual(await snapshot(resolve(root, "assets")), browserBefore)
      assert.equal(
        createHash("sha256")
          .update(await readFile(resolve(root, "server.mjs")))
          .digest("hex"),
        binaryHash,
      )
      await writeFile(
        resolve(root, "rehearsal.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            purpose: "local-rehearsal",
            productionQualified: false,
            node: process.version,
            platform: process.platform,
            chromium: session.browser.version(),
            policy,
            clock: "synthetic",
            decisions,
            checks: [
              "probes",
              "module-drain",
              "protected-release-retained",
              "expired-release-cleaned",
              "cold-v1-entry-and-chunk",
              "rollback",
              "unchanged-host-cart",
            ],
            binarySha256: binaryHash,
            hostAssets: browserBefore,
            cartFiles: cartBefore,
            protectedFiles: v1Before,
          },
          null,
          2,
        ),
      )
      console.log(`PASS: source-free retention/cleanup/cold import/rollback rehearsal (${root})`)
    } finally {
      try {
        await session?.stop()
      } finally {
        await stopOwnedChild(child, 3000, 2000, true)
      }
    }
  },
)

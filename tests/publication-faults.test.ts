import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, access } from "node:fs/promises"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { buildRelease } from "@islands/rsbuild"
import { verifyPublication, sha256 } from "@islands/contracts/integrity"
import { createModuleService, loadPublishedReleases } from "@islands/server"
import { listen, close } from "./helpers/runtime-browser.ts"

test(
  "crashes and missing outputs never publish partial releases or mutate the working release",
  { timeout: 60000 },
  async () => {
    await mkdir(".cache", { recursive: true })
    const outDir = await mkdtemp(resolve(".cache/publication-faults-"))
    const config = {
      root: process.cwd(),
      outDir,
      moduleId: "recommendations",
      releaseId: "v1",
      publicOrigin: "http://localhost:4311",
      serverEntry: "tests/fixtures/recommendations/fragment.ts",
      islands: { recommendation: "tests/fixtures/recommendations/entry.ts" },
    }
    const valid = await buildRelease(config)
    const before = await verifyPublication(valid)
    const metadataHash = sha256(await readFile(resolve(valid, "integrity.json")))
    const faults = [
      "crash-reserved",
      "crash-built",
      "crash-manifest",
      "crash-verified",
      "crash-marked",
      "missing-entry",
      "missing-css",
      "missing-shared",
      "missing-async",
      "missing-server-chunk",
      "invalid-render",
      "hung-render",
    ]
    for (const fault of faults) {
      const releaseId = fault
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "tests/publication-fault-cli.ts", JSON.stringify({ ...config, releaseId }), fault],
        { encoding: "utf8", timeout: 15000 },
      )
      assert.notEqual(result.status, 0, fault)
      assert.equal(result.error, undefined, fault)
      assert.doesNotMatch(result.stderr, /Fixture has no/, fault)
      if (fault.startsWith("crash-")) assert.equal(result.status, 99, `${fault}: ${result.stderr}`)
      await assert.rejects(access(resolve(outDir, "releases", releaseId)), /ENOENT/, fault)
      assert.deepEqual((await verifyPublication(valid)).inventory, before.inventory, fault)
      assert.equal(sha256(await readFile(resolve(valid, "integrity.json"))), metadataHash, fault)
      const loaded = await loadPublishedReleases(resolve(outDir, "releases"))
      assert.deepEqual(loaded.invalidReleases, [], fault)
      assert.deepEqual(
        loaded.releases.map((release) => release.manifest.releaseId),
        ["v1"],
        fault,
      )
      const server = await listen(createModuleService({ ...loaded, allowedHostOrigins: [] }))
      try {
        assert.equal((await fetch(`${server.origin}/releases/v1/readyz`)).status, 200, fault)
      } finally {
        await close(server.server)
      }
      await assert.rejects(buildRelease({ ...config, releaseId }), /EEXIST/, fault)
    }
  },
)

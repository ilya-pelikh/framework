import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

test(
  "repeated host build emits a separate sample without changing deployment registry",
  { timeout: 30000 },
  async () => {
    await mkdir(".cache", { recursive: true })
    const base = await mkdtemp(resolve(".cache/registry-build-"))
    const host = resolve(base, "apps/host/dist")
    await mkdir(host, { recursive: true })
    const original = Buffer.from('{ "deployment": "operator-managed-v7" }\r\n')
    const registry = resolve(host, "registry.json")
    await writeFile(registry, original)
    for (const releaseId of ["v1", "v2"]) {
      const build = spawnSync(process.execPath, ["--import", "tsx", "scripts/build.ts", "host"], {
        env: {
          ...process.env,
          ISLANDS_BUILD_ROOT: base,
          RELEASE_ID: releaseId,
        },
        encoding: "utf8",
        timeout: 14000,
      })
      assert.equal(build.status, 0, build.stderr)
      assert.deepEqual(await readFile(registry), original)
      const sample = JSON.parse(await readFile(resolve(host, "registry.sample.json"), "utf8"))
      assert.equal(sample.catalog.releaseId, releaseId)
      assert.equal(sample.cart.releaseId, releaseId)
    }
  },
)

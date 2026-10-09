import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile, readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { buildRelease, type ReleaseBuildOptions } from "../packages/rsbuild/src/index.ts"
import { verifyPublication } from "@islands/contracts/integrity"

async function options(): Promise<ReleaseBuildOptions> {
  await mkdir(".cache", { recursive: true })
  return {
    root: process.cwd(),
    outDir: await mkdtemp(resolve(".cache/publication-")),
    moduleId: "recommendations",
    releaseId: "v1",
    publicOrigin: "http://localhost:4311",
    serverEntry: "tests/fixtures/recommendations/fragment.ts",
    islands: { recommendation: "tests/fixtures/recommendations/entry.ts" },
  }
}
test(
  "exclusive reservation permits one writer and publishes a complete immutable release",
  { timeout: 30000 },
  async () => {
    const config = await options()
    const attempts = await Promise.allSettled([
      buildRelease(config),
      buildRelease({ ...config, publicOrigin: "http://localhost:4312" }),
    ])
    const successes = attempts.filter((result) => result.status === "fulfilled")
    assert.equal(successes.length, 1)
    const directory = (successes[0] as PromiseFulfilledResult<string>).value
    const publication = await verifyPublication(directory, config)
    assert.equal(publication.manifest.moduleId, config.moduleId)
    const before = await readFile(resolve(directory, "integrity.json"))
    await assert.rejects(buildRelease(config), /EEXIST/)
    assert.deepEqual(await readFile(resolve(directory, "integrity.json")), before)
    assert.deepEqual(await readdir(resolve(config.outDir!, ".staging")), [])
  },
)

test("failed render validation never publishes and burns the reserved release ID", { timeout: 30000 }, async () => {
  const config = await options()
  const invalid = resolve(config.outDir!, "invalid.ts")
  await writeFile(invalid, "export const render = null;")
  await assert.rejects(buildRelease({ ...config, serverEntry: invalid }), /Renderer validation failed/)
  await assert.rejects(readdir(resolve(config.outDir!, "releases/v1")), /ENOENT/)
  assert.equal((await readdir(resolve(config.outDir!, ".staging"))).length, 1)
  await assert.rejects(buildRelease(config), /EEXIST/)
  await assert.rejects(buildRelease({ ...config, moduleId: "different", releaseId: "v2" }), /another module/)
})

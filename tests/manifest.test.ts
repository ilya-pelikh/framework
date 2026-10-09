import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { generateReleaseManifest } from "../packages/rsbuild/src/index.ts"
import { spawnSync } from "node:child_process"

async function fixture(missing?: "entry" | "css") {
  await mkdir(".cache", { recursive: true })
  const outDir = await mkdtemp(resolve(".cache/manifest-"))
  const root = resolve(outDir, "releases/v1")
  await mkdir(resolve(root, "assets"), { recursive: true })
  await mkdir(resolve(root, "server"), { recursive: true })
  const prefix = "http://localhost:4311/releases/v1/assets/"
  for (const file of ["counter.js", "counter.css"]) {
    if ((missing === "entry" && file.endsWith(".js")) || (missing === "css" && file.endsWith(".css"))) continue
    await writeFile(resolve(root, "assets", file), "fixture")
  }
  await writeFile(resolve(root, "server/server.mjs"), "export {};")
  await writeFile(
    resolve(root, "assets/manifest.json"),
    JSON.stringify({
      allFiles: [`${prefix}counter.js`, `${prefix}counter.css`],
      entries: {
        counter: {
          initial: {
            js: [`${prefix}counter.js`],
            css: [`${prefix}counter.css`],
          },
        },
      },
    }),
  )
  return {
    root: process.cwd(),
    outDir,
    moduleId: "fixture",
    releaseId: "v1",
    publicOrigin: "http://localhost:4311",
    serverEntry: "unused",
    islands: { counter: "unused" },
  }
}
test("manifest uses emitted assets and cannot overwrite an existing release", async () => {
  const options = await fixture()
  const manifest = await generateReleaseManifest(options)
  assert.equal(manifest.releaseId, "v1")
  assert.match(manifest.islands.counter!.clientEntryUrl, /counter.js$/)
  await assert.rejects(generateReleaseManifest(options), /EEXIST/)
})
for (const missing of ["entry", "css"] as const) {
  test(`missing ${missing} rejects release generation`, async () => {
    const options = await fixture(missing)
    await assert.rejects(generateReleaseManifest(options), /ENOENT/)
    const result = spawnSync(process.execPath, ["--import", "tsx", "tests/manifest-cli.ts", JSON.stringify(options)], {
      encoding: "utf8",
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ENOENT/)
  })
}

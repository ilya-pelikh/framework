import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFile, readFile, unlink, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { attestLegacyRelease, sha256, verifyPublication } from "@islands/contracts/integrity"
import { loadPublishedReleases } from "@islands/server"
import { buildAttestor } from "../scripts/build-attestor.ts"
import { legacyFixture } from "./helpers/legacy-release.ts"

test("offline attestation preserves every original byte and enables only explicitly attested releases", async () => {
  const fixture = await legacyFixture()
  const unmarked = await loadPublishedReleases(resolve(fixture.root, "releases"))
  assert.equal(unmarked.releases.length, 0)
  assert.equal(unmarked.invalidReleases.length, 0)
  await attestLegacyRelease(fixture.directory, fixture.bytes, fixture.digest, fixture.identity)
  for (const [path, bytes] of Object.entries(fixture.original))
    assert.deepEqual(await readFile(resolve(fixture.directory, path)), Buffer.from(bytes), path)
  const checked = await verifyPublication(fixture.directory, fixture.identity)
  assert.equal(checked.inventory.files.length, Object.keys(fixture.original).length + 2)
  assert.equal(
    JSON.parse(await readFile(resolve(fixture.directory, "attestation.json"), "utf8")).expectedInventorySha256,
    fixture.digest,
  )
  assert.deepEqual(
    JSON.parse(await readFile(resolve(fixture.directory, "server/emitted-manifest.json"), "utf8")).allFiles,
    ["/server.mjs", "/lazy.mjs"],
  )
  assert.equal((await loadPublishedReleases(resolve(fixture.root, "releases"))).releases.length, 1)
  await assert.rejects(attestLegacyRelease(fixture.directory, fixture.bytes, fixture.digest, fixture.identity))
  assert.equal((await verifyPublication(fixture.directory)).manifest.releaseId, "v1")
})
test("migration refuses missing chunks, extra files, changed bytes and wrong evidence without metadata writes", async () => {
  for (const mode of ["server-chunk", "browser-chunk", "changed", "extra", "digest", "identity", "path"]) {
    const fixture = await legacyFixture()
    if (mode === "server-chunk") await unlink(resolve(fixture.directory, "server/lazy.mjs"))
    if (mode === "browser-chunk") await unlink(resolve(fixture.directory, "assets/lazy.js"))
    if (mode === "changed") await writeFile(resolve(fixture.directory, "assets/counter.js"), "changed")
    if (mode === "extra") await writeFile(resolve(fixture.directory, "unexpected.js"), "extra")
    if (mode === "path") fixture.expected.files[0]!.path = "../outside"
    const bytes = mode === "path" ? Buffer.from(JSON.stringify(fixture.expected)) : fixture.bytes
    await assert.rejects(
      attestLegacyRelease(
        fixture.directory,
        bytes,
        mode === "digest" ? "0".repeat(64) : sha256(bytes),
        mode === "identity" ? { ...fixture.identity, moduleId: "other" } : fixture.identity,
      ),
      mode,
    )
    for (const file of ["integrity.json", "published.json", "attestation.json", "server/emitted-manifest.json"])
      await assert.rejects(readFile(resolve(fixture.directory, file)), /ENOENT/, `${mode}: ${file}`)
    await assert.rejects(readdir(resolve(fixture.root, ".attestations")), /ENOENT/, mode)
  }
})
test("attestation bounds renderer validation and detects its modification of original files", async () => {
  for (const renderer of [
    "export const render = null;",
    "while (true) {}",
    'import { writeFileSync } from "node:fs"; writeFileSync(new URL("../assets/counter.js", import.meta.url), "changed"); export function render() {}',
  ]) {
    const fixture = await legacyFixture(renderer)
    await assert.rejects(attestLegacyRelease(fixture.directory, fixture.bytes, fixture.digest, fixture.identity, 200))
    await assert.rejects(readFile(resolve(fixture.directory, "published.json")), /ENOENT/)
  }
})
test("concurrent offline attestations admit exactly one writer", async () => {
  const fixture = await legacyFixture()
  const results = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      attestLegacyRelease(fixture.directory, fixture.bytes, fixture.digest, fixture.identity),
    ),
  )
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  await verifyPublication(fixture.directory)
})
test("attestation CLI requires independently supplied inventory and pinned digest", async () => {
  const fixture = await legacyFixture()
  const base = [
    "--import",
    "tsx",
    "scripts/attest-release.ts",
    "--directory",
    fixture.directory,
    "--module-id",
    "fixture",
    "--release-id",
    "v1",
  ]
  const missing = spawnSync(process.execPath, base, {
    encoding: "utf8",
    timeout: 15000,
  })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /attestation-failed/)
  const wrong = spawnSync(process.execPath, [...base, "--inventory", fixture.evidence, "--sha256", "0".repeat(64)], {
    encoding: "utf8",
    timeout: 15000,
  })
  assert.equal(wrong.status, 1)
  const success = spawnSync(process.execPath, [...base, "--inventory", fixture.evidence, "--sha256", fixture.digest], {
    encoding: "utf8",
    timeout: 15000,
  })
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(success.stdout).expectedInventorySha256, fixture.digest)
})

test("standalone attestor runs in a source-free deployment with Node only", { timeout: 30000 }, async () => {
  const fixture = await legacyFixture(undefined, tmpdir())
  const entry = await buildAttestor(resolve(fixture.root, "tools"))
  const result = spawnSync(
    process.execPath,
    [
      entry,
      "--directory",
      fixture.directory,
      "--inventory",
      fixture.evidence,
      "--sha256",
      fixture.digest,
      "--module-id",
      "fixture",
      "--release-id",
      "v1",
    ],
    {
      cwd: fixture.directory,
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  for (const [path, bytes] of Object.entries(fixture.original))
    assert.equal(await readFile(resolve(fixture.directory, path), "utf8"), bytes)
  await verifyPublication(fixture.directory)
})

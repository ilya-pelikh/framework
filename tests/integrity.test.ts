import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile, readFile, unlink, symlink } from "node:fs/promises"
import { resolve } from "node:path"
import {
  createInventory,
  writePublication,
  verifyPublication,
  parseInventory,
  parsePublication,
  checkRenderer,
  sha256,
} from "@islands/contracts/integrity"

const identity = { moduleId: "fixture", releaseId: "v1" }
async function releaseFixture() {
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/integrity-"))
  await mkdir(resolve(directory, "assets"))
  await mkdir(resolve(directory, "server"))
  const prefix = "http://localhost:4311/releases/v1/assets/"
  const outputs = ["entry.js", "style.css", "shared.js", "async.js", "media.svg"]
  for (const name of outputs) await writeFile(resolve(directory, "assets", name), name)
  await writeFile(resolve(directory, "server/server.mjs"), "export function render() {}")
  await writeFile(
    resolve(directory, "server/emitted-manifest.json"),
    JSON.stringify({ allFiles: ["/server.mjs", "/async.mjs"] }),
  )
  await writeFile(resolve(directory, "server/async.mjs"), "export const value = 1;")
  await writeFile(
    resolve(directory, "manifest.json"),
    JSON.stringify({
      ...identity,
      protocolVersion: 1,
      reactVersion: "19.3.0",
      renderUrl: "http://localhost:4311/releases/v1/render",
      islands: {
        counter: {
          clientEntryUrl: `${prefix}entry.js`,
          cssUrls: [`${prefix}style.css`],
        },
      },
    }),
  )
  await writeFile(
    resolve(directory, "assets/manifest.json"),
    JSON.stringify({
      allFiles: outputs.map((name) => `${prefix}${name}`),
      entries: {},
    }),
  )
  return directory
}

test("inventory and publication attest all files and reject schema/identity/path/digest mismatches", async () => {
  const directory = await releaseFixture()
  const inventory = await createInventory(directory, identity)
  assert.equal(inventory.files.length, 10)
  for (const path of [
    "../escape",
    "/absolute",
    "C:/drive",
    "assets\\escape",
    "assets/%2e%2e/a",
    "assets/../x",
    "assets/a.",
    "assets//x",
  ]) {
    assert.throws(
      () =>
        parseInventory({
          ...inventory,
          files: [{ ...inventory.files[0], path }, ...inventory.files.slice(1)],
        }),
      /path/,
    )
  }
  assert.throws(() => parseInventory(inventory, { ...identity, releaseId: "v2" }), /identity/)
  assert.throws(() => parsePublication({ schemaVersion: 2, ...identity }), /schema/)
  await checkRenderer(directory)
  await writePublication(directory, inventory)
  assert.equal((await verifyPublication(directory, identity)).manifest.releaseId, "v1")
  await assert.rejects(verifyPublication(directory, { ...identity, moduleId: "other" }), /identity/)
  await writeFile(
    resolve(directory, "integrity.json"),
    `${await readFile(resolve(directory, "integrity.json"), "utf8")} `,
  )
  await assert.rejects(verifyPublication(directory), /digest/)
})

test("missing entry/CSS/shared/async outputs fail both publication and admission", async () => {
  for (const file of ["entry.js", "style.css", "shared.js", "async.js"]) {
    const directory = await releaseFixture()
    await writePublication(directory, await createInventory(directory, identity))
    await unlink(resolve(directory, "assets", file))
    await assert.rejects(createInventory(directory, identity), /Missing emitted output/)
    await assert.rejects(verifyPublication(directory), /file set/)
  }
  const directory = await releaseFixture()
  await unlink(resolve(directory, "server/async.mjs"))
  await assert.rejects(createInventory(directory, identity), /Missing emitted output/)
})

test("inventory rejects directories, changed bytes, root links and nested symlinks", async () => {
  const directory = await releaseFixture()
  await writePublication(directory, await createInventory(directory, identity))
  const target = resolve(directory, "assets/async.js")
  await writeFile(target, "changed")
  await assert.rejects(verifyPublication(directory), /digest/)
  await unlink(target)
  await mkdir(target)
  await assert.rejects(createInventory(directory, identity), /Missing emitted output/)
  const link = `${directory}-link`
  await symlink(directory, link, "junction")
  await assert.rejects(verifyPublication(link), /regular directory/)
  await symlink(resolve(directory, "server"), resolve(directory, "assets/linked"), "junction")
  await assert.rejects(createInventory(directory, identity), /symlinks/)
})

test("renderer validation rejects absent export and bounds top-level hangs", async () => {
  const directory = await releaseFixture()
  await writeFile(resolve(directory, "server/server.mjs"), "export const render = null;")
  await assert.rejects(checkRenderer(directory), /failed/)
  await writeFile(resolve(directory, "server/server.mjs"), "while (true) {}")
  const started = Date.now()
  await assert.rejects(checkRenderer(directory, 150), /timed out/)
  assert.ok(Date.now() - started < 2000)
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
})

test("legacy callable renderer alone cannot prove completeness of a lazy server graph", async () => {
  const directory = await releaseFixture()
  await unlink(resolve(directory, "server/emitted-manifest.json"))
  await unlink(resolve(directory, "server/async.mjs"))
  await writeFile(resolve(directory, "server/server.mjs"), 'export function render() { return import("./async.mjs"); }')
  await checkRenderer(directory)
  await assert.rejects(createInventory(directory, identity), /ENOENT/)
})

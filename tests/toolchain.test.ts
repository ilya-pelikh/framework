import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"

test("workspace and lockfile runtime metadata agree without a Node version pin", async () => {
  const read = (path: string) => readFile(resolve(path), "utf8")
  const root = JSON.parse(await read("package.json"))
  const lock = JSON.parse(await read("package-lock.json"))
  assert.equal(root.engines?.node, undefined)
  assert.deepEqual(lock.packages[""].engines, root.engines)
  assert.equal(lock.packages["node_modules/@types/node"].version, root.devDependencies["@types/node"])
  for (const parent of ["apps", "packages"]) {
    for (const directory of await readdir(parent, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      const path = `${parent}/${directory.name}`
      const workspace = JSON.parse(await read(`${path}/package.json`))
      assert.equal(workspace.engines?.node, undefined, path)
      assert.deepEqual(lock.packages[path].engines, workspace.engines, path)
    }
  }
})

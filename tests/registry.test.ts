import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile, rename } from "node:fs/promises"
import { resolve } from "node:path"
import { RegistryStore } from "../packages/server/src/registry.ts"
test("registry retains snapshots across atomic release changes and invalid updates", async () => {
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/registry-"))
  const path = resolve(directory, "registry.json")
  let errors = 0
  const store = new RegistryStore(path, ["http://localhost"], () => errors++)
  await assert.rejects(store.snapshot(), /No valid registry/)
  const data = (releaseId: string) =>
    JSON.stringify({
      fixture: {
        releaseId,
        manifestUrl: `http://localhost/releases/${releaseId}/manifest.json`,
      },
    })
  await writeFile(path, data("v1"))
  const first = await store.snapshot()
  await writeFile(`${path}.next`, data("v2"))
  await rename(`${path}.next`, path)
  assert.equal((await store.snapshot()).fixture!.releaseId, "v2")
  assert.equal(first.fixture!.releaseId, "v1")
  assert.throws(() => {
    first.fixture!.releaseId = "changed"
  })
  await writeFile(path, "{invalid")
  assert.equal((await store.snapshot()).fixture!.releaseId, "v2")
  assert.equal(errors, 2)
  const cold = new RegistryStore(path, ["http://localhost"])
  await assert.rejects(cold.snapshot(), /No valid registry/)
  await writeFile(`${path}.next`, data("v1"))
  await rename(`${path}.next`, path)
  assert.equal((await store.snapshot()).fixture!.releaseId, "v1")
  assert.equal((await cold.snapshot()).fixture!.releaseId, "v1")
  assert.equal(errors, 2)
})

import { lstat, readFile, realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import { attestLegacyRelease } from "@islands/contracts/integrity"

try {
  const { values } = parseArgs({
    options: {
      directory: { type: "string" },
      inventory: { type: "string" },
      sha256: { type: "string" },
      "module-id": { type: "string" },
      "release-id": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  })
  if (!values.directory || !values.inventory || !values.sha256 || !values["module-id"] || !values["release-id"])
    throw new Error("Required arguments missing")
  if (!(await lstat(resolve(values.directory))).isDirectory())
    throw new Error("Release root must be a regular directory")
  const directory = await realpath(resolve(values.directory))
  const inventoryPath = await realpath(resolve(values.inventory))
  const within = process.platform === "win32" ? (path: string) => path.toLowerCase() : (path: string) => path
  if (within(inventoryPath).startsWith(within(directory + sep)))
    throw new Error("Inventory must come from outside the release")
  const metadata = await lstat(inventoryPath)
  if (!metadata.isFile() || metadata.size > 32 * 1024 * 1024) throw new Error("Invalid expected inventory")
  const expectedBytes = await readFile(inventoryPath)
  const expected = {
    moduleId: values["module-id"],
    releaseId: values["release-id"],
  }
  await attestLegacyRelease(directory, expectedBytes, values.sha256, expected)
  console.log(
    JSON.stringify({
      ok: true,
      ...expected,
      expectedInventorySha256: values.sha256,
    }),
  )
} catch {
  console.error(JSON.stringify({ ok: false, category: "attestation-failed" }))
  process.exitCode = 1
}

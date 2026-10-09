import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { assertJson, parseManifest, type Manifest } from "./index.ts"

export interface ReleaseIdentity {
  moduleId: string
  releaseId: string
}
export interface IntegrityFile {
  path: string
  bytes: number
  sha256: string
}
export interface IntegrityInventory extends ReleaseIdentity {
  schemaVersion: 1
  files: IntegrityFile[]
}
export interface Publication extends ReleaseIdentity {
  schemaVersion: 1
  inventorySchemaVersion: 1
  inventorySha256: string
}
const sidecars = new Set(["integrity.json", "published.json"])
const digestPattern = /^[a-f0-9]{64}$/
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

function record(value: unknown): Record<string, unknown> {
  assertJson(value)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid integrity object")
  return value as Record<string, unknown>
}
function identity(value: Record<string, unknown>, expected?: ReleaseIdentity): ReleaseIdentity {
  if (
    typeof value.moduleId !== "string" ||
    typeof value.releaseId !== "string" ||
    !identifierPattern.test(value.moduleId) ||
    !identifierPattern.test(value.releaseId)
  )
    throw new Error("Invalid integrity identity")
  if (expected && (value.moduleId !== expected.moduleId || value.releaseId !== expected.releaseId))
    throw new Error("Integrity identity mismatch")
  return { moduleId: value.moduleId, releaseId: value.releaseId }
}
export function integrityPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    /[\\:%?#\u0000-\u001f]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))
  )
    throw new Error("Invalid integrity path")
  return value
}
function inventorySchema(
  value: unknown,
  expected: ReleaseIdentity | undefined,
  requireServerGraph: boolean,
): IntegrityInventory {
  const input = record(value)
  const release = identity(input, expected)
  if (input.schemaVersion !== 1 || !Array.isArray(input.files) || !input.files.length || input.files.length > 100000)
    throw new Error("Invalid inventory schema")
  const paths = new Set<string>()
  const files = input.files.map((item) => {
    const file = record(item)
    const path = integrityPath(file.path)
    if (sidecars.has(path) || paths.has(path.toLowerCase())) throw new Error("Duplicate or reserved inventory path")
    paths.add(path.toLowerCase())
    if (
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== "string" ||
      !digestPattern.test(file.sha256)
    )
      throw new Error("Invalid inventory file")
    return { path, bytes: file.bytes, sha256: file.sha256 }
  })
  const requiredPaths = ["manifest.json", "server/server.mjs", "assets/manifest.json"]
  if (requireServerGraph) requiredPaths.push("server/emitted-manifest.json")
  for (const required of requiredPaths) if (!paths.has(required)) throw new Error("Incomplete inventory")
  return { schemaVersion: 1, ...release, files }
}
export function parseInventory(value: unknown, expected?: ReleaseIdentity): IntegrityInventory {
  return inventorySchema(value, expected, true)
}
export function parseExpectedInventory(value: unknown, expected?: ReleaseIdentity): IntegrityInventory {
  return inventorySchema(value, expected, false)
}
export function parsePublication(value: unknown, expected?: ReleaseIdentity): Publication {
  const input = record(value)
  const release = identity(input, expected)
  if (
    input.schemaVersion !== 1 ||
    input.inventorySchemaVersion !== 1 ||
    typeof input.inventorySha256 !== "string" ||
    !digestPattern.test(input.inventorySha256)
  )
    throw new Error("Invalid publication schema")
  return {
    schemaVersion: 1,
    inventorySchemaVersion: 1,
    ...release,
    inventorySha256: input.inventorySha256,
  }
}
export function sha256(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function filesIn(directory: string, signal: AbortSignal): Promise<string[]> {
  if (!(await lstat(directory)).isDirectory()) throw new Error("Release root must be a regular directory")
  const files: string[] = []
  async function visit(relative: string, depth: number) {
    signal.throwIfAborted()
    if (depth > 64) throw new Error("Release tree too deep")
    for (const name of await readdir(resolve(directory, relative))) {
      signal.throwIfAborted()
      const path = integrityPath(relative ? `${relative}/${name}` : name)
      const metadata = await lstat(resolve(directory, path))
      if (metadata.isSymbolicLink()) throw new Error("Release symlinks are forbidden")
      if (metadata.isDirectory()) await visit(path, depth + 1)
      else if (metadata.isFile()) files.push(path)
      else throw new Error("Release entries must be regular files")
      if (files.length > 100002) throw new Error("Release tree too large")
    }
  }
  await visit("", 0)
  return files.sort()
}
async function fileDigest(directory: string, path: string, signal: AbortSignal): Promise<IntegrityFile> {
  const digest = createHash("sha256")
  let bytes = 0
  const stream = createReadStream(resolve(directory, path), { signal })
  for await (const chunk of stream) {
    bytes += chunk.length
    digest.update(chunk)
  }
  return { path, bytes, sha256: digest.digest("hex") }
}
async function metadata(directory: string, name: string, signal: AbortSignal) {
  const path = resolve(directory, name)
  const file = await lstat(path)
  if (!file.isFile() || file.size > 32 * 1024 * 1024) throw new Error("Invalid release metadata file")
  return readFile(path, { signal })
}
function assetPath(url: string, manifest: Manifest) {
  const parsed = new URL(url)
  const prefix = `/releases/${manifest.releaseId}/assets/`
  if (!parsed.pathname.startsWith(prefix) || parsed.search || parsed.hash) throw new Error("Asset outside release")
  return `assets/${integrityPath(parsed.pathname.slice(prefix.length))}`
}
async function validateGraph(
  directory: string,
  files: Set<string>,
  expected: ReleaseIdentity,
  signal: AbortSignal,
  expectedServerFiles?: string[],
) {
  const manifest = parseManifest(JSON.parse((await metadata(directory, "manifest.json", signal)).toString("utf8")))
  identity(manifest as unknown as Record<string, unknown>, expected)
  const requireFile = (path: string) => {
    if (!files.has(path)) throw new Error("Missing emitted output")
  }
  requireFile("server/server.mjs")
  for (const entry of Object.values(manifest.islands))
    for (const url of [entry.clientEntryUrl, ...entry.cssUrls]) requireFile(assetPath(url, manifest))
  const emitted = record(JSON.parse((await metadata(directory, "assets/manifest.json", signal)).toString("utf8")))
  if (!Array.isArray(emitted.allFiles) || !emitted.allFiles.length) throw new Error("Missing emitted asset graph")
  for (const url of emitted.allFiles) {
    if (typeof url !== "string") throw new Error("Invalid emitted asset")
    requireFile(assetPath(url, manifest))
  }
  const server = expectedServerFiles
    ? { allFiles: expectedServerFiles }
    : record(JSON.parse((await metadata(directory, "server/emitted-manifest.json", signal)).toString("utf8")))
  if (!Array.isArray(server.allFiles) || !server.allFiles.length) throw new Error("Missing emitted server graph")
  for (const path of server.allFiles) {
    if (typeof path !== "string" || !path.startsWith("/")) throw new Error("Invalid emitted server output")
    requireFile(`server/${integrityPath(path.slice(1))}`)
  }
  return manifest
}
export async function checkRenderer(directory: string, timeoutMs = 5000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid renderer timeout")
  const entry = pathToFileURL(resolve(directory, "server/server.mjs")).href
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'try { const entry = await import(process.argv[1]); process.exit(typeof entry.render === "function" ? 0 : 1); } catch { process.exit(1); }',
        entry,
      ],
      { stdio: "ignore", windowsHide: true },
    )
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Renderer validation timed out"))
    }, timeoutMs)
    child.once("error", () => {
      clearTimeout(timer)
      reject(new Error("Renderer validation failed"))
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      code === 0 ? done() : reject(new Error("Renderer validation failed"))
    })
  })
}
export async function createInventory(
  directory: string,
  expected: ReleaseIdentity,
  timeoutMs = 10000,
): Promise<IntegrityInventory> {
  const signal = AbortSignal.timeout(timeoutMs)
  const paths = (await filesIn(directory, signal)).filter((path) => !sidecars.has(path))
  await validateGraph(directory, new Set(paths), expected, signal)
  const files: IntegrityFile[] = []
  for (const path of paths) files.push(await fileDigest(directory, path, signal))
  return parseInventory(
    {
      schemaVersion: 1,
      moduleId: expected.moduleId,
      releaseId: expected.releaseId,
      files,
    },
    expected,
  )
}
export async function writePublication(directory: string, inventory: IntegrityInventory) {
  const bytes = JSON.stringify(parseInventory(inventory), null, 2)
  await writeFile(resolve(directory, "integrity.json"), bytes, { flag: "wx" })
  const publication: Publication = {
    schemaVersion: 1,
    inventorySchemaVersion: 1,
    moduleId: inventory.moduleId,
    releaseId: inventory.releaseId,
    inventorySha256: sha256(bytes),
  }
  await writeFile(resolve(directory, "published.json"), JSON.stringify(publication, null, 2), { flag: "wx" })
}
async function verifyFiles(directory: string, actual: string[], inventory: IntegrityInventory, signal: AbortSignal) {
  const paths = new Set(actual)
  if (paths.size !== inventory.files.length || inventory.files.some((file) => !paths.has(file.path)))
    throw new Error("Inventory file set mismatch")
  for (const file of inventory.files) {
    const checked = await fileDigest(directory, file.path, signal)
    if (checked.bytes !== file.bytes || checked.sha256 !== file.sha256) throw new Error("Output digest mismatch")
  }
}
export async function attestLegacyRelease(
  directory: string,
  expectedBytes: Buffer,
  expectedSha256: string,
  expected: ReleaseIdentity,
  timeoutMs = 10000,
) {
  if (
    !digestPattern.test(expectedSha256) ||
    expectedBytes.length > 32 * 1024 * 1024 ||
    sha256(expectedBytes) !== expectedSha256
  )
    throw new Error("Expected inventory digest mismatch")
  const inventory = parseExpectedInventory(JSON.parse(expectedBytes.toString("utf8")), expected)
  const root = resolve(directory)
  if (basename(root) !== inventory.releaseId) throw new Error("Release directory identity mismatch")
  if (inventory.files.some((file) => file.path.toLowerCase() === "attestation.json"))
    throw new Error("Reserved attestation metadata")
  async function verifyOriginals() {
    const signal = AbortSignal.timeout(timeoutMs)
    const paths = await filesIn(root, signal)
    await verifyFiles(root, paths, inventory, signal)
    const expectedServerFiles = paths.includes("server/emitted-manifest.json")
      ? undefined
      : inventory.files
          .filter((file) => file.path.startsWith("server/"))
          .map((file) => `/${file.path.slice("server/".length)}`)
    await validateGraph(root, new Set(paths), inventory, signal, expectedServerFiles)
  }
  await verifyOriginals()
  await checkRenderer(root, timeoutMs)
  await verifyOriginals()
  const reservations = resolve(root, "../../.attestations")
  await mkdir(reservations, { recursive: true })
  if (!(await lstat(reservations)).isDirectory()) throw new Error("Invalid attestation reservation directory")
  await mkdir(resolve(reservations, inventory.releaseId))
  await verifyOriginals()
  if (!inventory.files.some((file) => file.path === "server/emitted-manifest.json")) {
    const allFiles = inventory.files
      .filter((file) => file.path.startsWith("server/"))
      .map((file) => `/${file.path.slice("server/".length)}`)
    await writeFile(resolve(root, "server/emitted-manifest.json"), JSON.stringify({ allFiles }, null, 2), {
      flag: "wx",
    })
  }
  await writeFile(
    resolve(root, "attestation.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        ...expected,
        expectedInventorySha256: expectedSha256,
      },
      null,
      2,
    ),
    { flag: "wx" },
  )
  const complete = await createInventory(root, expected, timeoutMs)
  for (const file of inventory.files) {
    const checked = complete.files.find((candidate) => candidate.path === file.path)
    if (!checked || checked.bytes !== file.bytes || checked.sha256 !== file.sha256)
      throw new Error("Original output changed during attestation")
  }
  await writePublication(root, complete)
  return verifyPublication(root, expected, timeoutMs)
}
export async function verifyPublication(directory: string, expected?: ReleaseIdentity, timeoutMs = 10000) {
  const signal = AbortSignal.timeout(timeoutMs)
  const paths = await filesIn(directory, signal)
  const publication = parsePublication(
    JSON.parse((await metadata(directory, "published.json", signal)).toString("utf8")),
    expected,
  )
  const inventoryBytes = await metadata(directory, "integrity.json", signal)
  if (sha256(inventoryBytes) !== publication.inventorySha256) throw new Error("Inventory digest mismatch")
  const inventory = parseInventory(JSON.parse(inventoryBytes.toString("utf8")), publication)
  const actual = paths.filter((path) => !sidecars.has(path))
  await verifyFiles(directory, actual, inventory, signal)
  const manifest = await validateGraph(directory, new Set(actual), publication, signal)
  return { manifest, inventory, publication }
}

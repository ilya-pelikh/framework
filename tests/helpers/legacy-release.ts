import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { sha256 } from "@islands/contracts/integrity"

export async function legacyFixture(
  renderer?: string,
  parent = resolve(".cache"),
  origin = "http://localhost:4311",
  releaseId = "v1",
) {
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, "attestation-"))
  const directory = resolve(root, `releases/${releaseId}`)
  const identity = { moduleId: "fixture", releaseId }
  const original: Record<string, string> = {
    "manifest.json": JSON.stringify({
      ...identity,
      protocolVersion: 1,
      reactVersion: "19.3.0",
      renderUrl: `${origin}/releases/${releaseId}/render`,
      islands: {
        counter: {
          clientEntryUrl: `${origin}/releases/${releaseId}/assets/counter.js`,
          cssUrls: [],
        },
      },
    }),
    "assets/manifest.json": JSON.stringify({
      allFiles: [`${origin}/releases/${releaseId}/assets/counter.js`, `${origin}/releases/${releaseId}/assets/lazy.js`],
      entries: {},
    }),
    "assets/counter.js": "export function hydrate() { return () => {}; }",
    "assets/lazy.js": "export const value = 1;",
    "server/server.mjs":
      renderer ??
      'export function render(input) { return { protocolVersion: 1, moduleId: input.moduleId, releaseId: input.releaseId, html: "<p>legacy</p>", islands: [] }; } export function lazy() { return import("./lazy.mjs"); }',
    "server/lazy.mjs": "export const value = 1;",
  }
  const expected = {
    schemaVersion: 1,
    ...identity,
    files: Object.entries(original).map(([path, bytes]) => ({
      path,
      bytes: Buffer.byteLength(bytes),
      sha256: sha256(bytes),
    })),
  }
  const bytes = Buffer.from(JSON.stringify(expected))
  for (const [path, contents] of Object.entries(original)) {
    await mkdir(dirname(resolve(directory, path)), { recursive: true })
    await writeFile(resolve(directory, path), contents)
  }
  const evidence = resolve(root, "trusted-ci-snapshot.json")
  await writeFile(evidence, bytes)
  return {
    root,
    directory,
    identity,
    original,
    expected,
    bytes,
    digest: sha256(bytes),
    evidence,
  }
}

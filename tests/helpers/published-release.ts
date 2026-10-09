import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createInventory, writePublication } from "@islands/contracts/integrity"
import type { Manifest } from "@islands/contracts"
import type { FragmentRenderer } from "@islands/server"

export async function publishedRelease(
  directory: string,
  manifest: Manifest,
  render: FragmentRenderer,
  files: Record<string, string>,
) {
  const releaseDirectory = resolve(directory, manifest.releaseId)
  const assetsDirectory = resolve(releaseDirectory, "assets")
  await mkdir(assetsDirectory, { recursive: true })
  await mkdir(resolve(releaseDirectory, "server"))
  for (const [name, content] of Object.entries(files)) await writeFile(resolve(assetsDirectory, name), content)
  const prefix = `${new URL(manifest.renderUrl).origin}/releases/${manifest.releaseId}/assets/`
  await writeFile(
    resolve(assetsDirectory, "manifest.json"),
    JSON.stringify({
      allFiles: Object.keys(files).map((name) => `${prefix}${name}`),
      entries: {},
    }),
  )
  await writeFile(
    resolve(releaseDirectory, "server/server.mjs"),
    'export function render(input) { return {protocolVersion: 1, moduleId: input.moduleId, releaseId: input.releaseId, html: "<p>valid release</p>", islands: []}; }',
  )
  await writeFile(
    resolve(releaseDirectory, "server/emitted-manifest.json"),
    JSON.stringify({ allFiles: ["/server.mjs"] }),
  )
  await writeFile(resolve(releaseDirectory, "manifest.json"), JSON.stringify(manifest))
  await writePublication(releaseDirectory, await createInventory(releaseDirectory, manifest))
  return { manifest, render, assetsDirectory, releaseDirectory }
}

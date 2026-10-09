import { createRsbuild, type RsbuildConfig } from "@rsbuild/core"
import { pluginReact } from "@rsbuild/plugin-react"
import { resolve } from "node:path"
import { access, mkdir, readFile, writeFile, lstat, rename } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { checkRenderer, createInventory, verifyPublication, writePublication } from "@islands/contracts/integrity"
import type { ManifestData } from "@rsbuild/core"
import { createRequire } from "node:module"

export type ReleaseBuildStage = "reserved" | "built" | "manifest" | "verified" | "marked"
export interface ReleaseBuildOptions {
  root: string
  moduleId: string
  releaseId: string
  publicOrigin: string
  serverEntry: string
  islands: Record<string, string>
  outDir?: string
  onStage?: (stage: ReleaseBuildStage, directory: string) => void | Promise<void>
}

function validateReleaseOptions(options: ReleaseBuildOptions): void {
  const { moduleId, releaseId, publicOrigin } = options
  for (const value of [moduleId, releaseId, ...Object.keys(options.islands)]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error("Invalid release identifier")
  }
  const origin = new URL(publicOrigin)
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== publicOrigin) {
    throw new Error("publicOrigin must be an HTTP origin")
  }
}

export function releaseConfig(options: ReleaseBuildOptions, outputDirectory?: string): RsbuildConfig {
  validateReleaseOptions(options)
  const { root, releaseId, publicOrigin } = options
  const destination = outputDirectory ?? resolve(root, options.outDir ?? "dist", "releases", releaseId)
  return {
    plugins: [pluginReact()],
    source: { define: { __RELEASE_ID__: JSON.stringify(releaseId) } },
    environments: {
      browser: {
        source: {
          entry: Object.fromEntries(Object.entries(options.islands).map(([key, entry]) => [key, resolve(root, entry)])),
        },
        output: {
          target: "web",
          module: true,
          manifest: true,
          distPath: { root: resolve(destination, "assets") },
          assetPrefix: `${publicOrigin}/releases/${releaseId}/assets/`,
        },
        tools: {
          htmlPlugin: false,
          rspack: { output: { library: { type: "module" } } },
        },
      },
      server: {
        source: { entry: { server: resolve(root, options.serverEntry) } },
        output: {
          target: "node",
          module: true,
          autoExternal: true,
          manifest: { filename: "emitted-manifest.json" },
          distPath: { root: resolve(destination, "server") },
          filename: { js: "[name].mjs" },
        },
        tools: { rspack: { output: { library: { type: "module" } } } },
      },
    },
  }
}

export async function buildRelease(options: ReleaseBuildOptions): Promise<string> {
  validateReleaseOptions(options)
  const root = resolve(options.root, options.outDir ?? "dist")
  const destination = resolve(options.root, options.outDir ?? "dist", "releases", options.releaseId)
  await mkdir(root, { recursive: true })
  const owner = resolve(root, ".module.json")
  try {
    await writeFile(owner, JSON.stringify({ moduleId: options.moduleId }), {
      flag: "wx",
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (JSON.parse(await readFile(owner, "utf8")).moduleId !== options.moduleId)
      throw new Error("Publication root belongs to another module")
  }
  await mkdir(resolve(root, ".reservations"), { recursive: true })
  await mkdir(resolve(root, ".reservations", options.releaseId))
  try {
    await access(destination)
    throw new Error(`Release already exists: ${options.releaseId}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const staging = resolve(root, ".staging", randomUUID())
  await mkdir(staging, { recursive: true })
  await options.onStage?.("reserved", staging)
  const rsbuild = await createRsbuild({
    cwd: resolve(options.root),
    config: releaseConfig(options, staging),
  })
  const result = await rsbuild.build()
  await result.close()
  await options.onStage?.("built", staging)
  await generateReleaseManifest(options, staging)
  await options.onStage?.("manifest", staging)
  await checkRenderer(staging)
  const inventory = await createInventory(staging, options)
  await options.onStage?.("verified", staging)
  await writePublication(staging, inventory)
  await options.onStage?.("marked", staging)
  await verifyPublication(staging, options)
  await mkdir(resolve(root, "releases"), { recursive: true })
  try {
    await access(destination)
    throw new Error(`Release already exists: ${options.releaseId}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await rename(staging, destination)
  return destination
}

export async function generateReleaseManifest(options: ReleaseBuildOptions, outputDirectory?: string) {
  validateReleaseOptions(options)
  const directory = outputDirectory ?? resolve(options.root, options.outDir ?? "dist", "releases", options.releaseId)
  const assets = resolve(directory, "assets")
  const prefix = `${options.publicOrigin}/releases/${options.releaseId}/assets/`
  const outputs: ManifestData = JSON.parse(await readFile(resolve(assets, "manifest.json"), "utf8"))
  async function check(url: string) {
    if (!url.startsWith(prefix)) throw new Error(`Asset outside release: ${url}`)
    const relative = url.slice(prefix.length)
    if (!relative || relative.split(/[\\/]/).some((part) => part === "..") || /[%?#]/.test(relative))
      throw new Error("Invalid asset path")
    if (!(await lstat(resolve(assets, relative))).isFile()) throw new Error(`Missing asset: ${url}`)
  }
  for (const url of outputs.allFiles) await check(url)
  const islands: Record<string, { clientEntryUrl: string; cssUrls: string[] }> = {}
  for (const key of Object.keys(options.islands)) {
    const entry = outputs.entries[key]
    const js = entry?.initial?.js ?? []
    const clientEntryUrl = js.find((url) => new URL(url).pathname.split("/").at(-1)?.startsWith(`${key}.`))
    if (!clientEntryUrl) throw new Error(`Missing browser entry: ${key}`)
    const cssUrls = entry?.initial?.css ?? []
    for (const url of [...js, ...cssUrls, ...(entry?.async?.js ?? []), ...(entry?.async?.css ?? [])]) await check(url)
    islands[key] = { clientEntryUrl, cssUrls }
  }
  await access(resolve(directory, "server/server.mjs"))
  const require = createRequire(resolve(options.root, "package.json"))
  const manifest = {
    protocolVersion: 1,
    moduleId: options.moduleId,
    releaseId: options.releaseId,
    renderUrl: `${options.publicOrigin}/releases/${options.releaseId}/render`,
    islands,
    reactVersion: require("react/package.json").version as string,
  }
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" })
  return manifest
}

import { lstat, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { checkRenderer, verifyPublication } from "@islands/contracts/integrity"
import type { ServiceRelease } from "./service.ts"

export interface ReleaseDiagnostic {
  releaseId: string
  category: "unpublished" | "integrity"
}
export async function loadPublishedReleases(root: string, onDiagnostic?: (event: ReleaseDiagnostic) => void) {
  const releases: ServiceRelease[] = []
  const invalidReleases: string[] = []
  const emit = (event: ReleaseDiagnostic) => {
    try {
      onDiagnostic?.(event)
    } catch {}
  }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { releases, invalidReleases }
    throw error
  }
  for (const entry of entries) {
    const directory = resolve(root, entry.name)
    let marked = false
    try {
      await lstat(resolve(directory, "published.json"))
      marked = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR")
        marked = true
    }
    if (!marked) {
      emit({ releaseId: entry.name, category: "unpublished" })
      continue
    }
    try {
      const { manifest } = await verifyPublication(directory)
      if (manifest.releaseId !== entry.name) throw new Error("Release directory mismatch")
      await checkRenderer(directory)
      const { render } = await import(
        /* webpackIgnore: true */ pathToFileURL(resolve(directory, "server/server.mjs")).href
      )
      if (typeof render !== "function") throw new Error("Invalid renderer")
      releases.push({
        manifest,
        assetsDirectory: resolve(directory, "assets"),
        releaseDirectory: directory,
        render,
      })
    } catch {
      invalidReleases.push(entry.name)
      emit({ releaseId: entry.name, category: "integrity" })
    }
  }
  return { releases, invalidReleases }
}

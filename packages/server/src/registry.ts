import { readFile } from "node:fs/promises"
import { parseRegistry, type Registry } from "@islands/contracts"

export class RegistryStore {
  #last: Registry | undefined
  constructor(
    readonly path: string,
    readonly origins: readonly string[],
    readonly onError: () => void = () => {},
  ) {}
  async snapshot(onError = this.onError): Promise<Registry> {
    try {
      const registry = parseRegistry(JSON.parse(await readFile(this.path, "utf8")))
      for (const entry of Object.values(registry)) {
        if (!this.origins.includes(new URL(entry.manifestUrl).origin)) throw new Error("Disallowed registry origin")
        if (new URL(entry.manifestUrl).pathname !== `/releases/${entry.releaseId}/manifest.json`)
          throw new Error("Registry release mismatch")
        Object.freeze(entry)
      }
      this.#last = Object.freeze(registry)
    } catch {
      try {
        onError()
      } catch {}
    }
    if (!this.#last) throw new Error("No valid registry")
    return this.#last
  }
}

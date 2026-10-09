import { buildRelease } from "../packages/rsbuild/src/index.ts"
import { readFile, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const options = JSON.parse(process.argv[2]!)
const fault = process.argv[3]!
await buildRelease({
  ...options,
  onStage: async (stage, directory) => {
    if (fault === `crash-${stage}`) process.exit(99)
    if (stage !== "built") return
    if (fault === "invalid-render" || fault === "hung-render") {
      await writeFile(
        resolve(directory, "server/server.mjs"),
        fault === "invalid-render" ? "export const render = null;" : "while (true) {}",
      )
      return
    }
    if (fault === "missing-server-chunk") {
      const graph = JSON.parse(await readFile(resolve(directory, "server/emitted-manifest.json"), "utf8"))
      const target = graph.allFiles.find((path: string) => path !== "/server.mjs")
      if (!target) throw new Error("Fixture has no server chunk")
      await unlink(resolve(directory, "server", target.slice(1)))
      return
    }
    const graph = JSON.parse(await readFile(resolve(directory, "assets/manifest.json"), "utf8"))
    const entry = graph.entries.recommendation
    const targets: Record<string, string | undefined> = {
      "missing-entry": entry.initial.js.find((url: string) => /\/recommendation\./.test(url)),
      "missing-css": entry.initial.css[0],
      "missing-shared": entry.initial.js.find((url: string) => /\/lib-react\./.test(url)),
      "missing-async": entry.async?.js[0],
    }
    if (fault.startsWith("missing-")) {
      const url = targets[fault]
      if (!url) throw new Error("Fixture has no requested output")
      await unlink(resolve(directory, "assets", new URL(url).pathname.split("/assets/")[1]!))
    }
  },
})

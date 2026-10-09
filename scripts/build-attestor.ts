import { createRsbuild } from "@rsbuild/core"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export async function buildAttestor(outDir = resolve("dist")) {
  const builder = await createRsbuild({
    config: {
      source: {
        entry: { "attest-release": resolve("scripts/attest-release.ts") },
      },
      output: {
        target: "node",
        module: true,
        autoExternal: false,
        cleanDistPath: false,
        distPath: { root: outDir },
        filename: { js: "[name].mjs" },
      },
      tools: { htmlPlugin: false },
    },
  })
  const result = await builder.build()
  await result.close()
  return resolve(outDir, "attest-release.mjs")
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildAttestor()

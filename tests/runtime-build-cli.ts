import { createRsbuild } from "@rsbuild/core"
import { resolve } from "node:path"

const builder = await createRsbuild({
  config: {
    source: { entry: { runtime: resolve("packages/client/src/index.ts") } },
    output: {
      target: "web",
      module: true,
      distPath: { root: resolve(process.argv[2]!), js: "" },
      filename: { js: "[name].js" },
    },
    tools: {
      htmlPlugin: false,
      rspack: { output: { library: { type: "module" } } },
    },
  },
})
const build = await builder.build()
await build.close()

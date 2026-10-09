import { createRsbuild } from "@rsbuild/core"
import { pluginReact } from "@rsbuild/plugin-react"
import { buildRelease } from "../packages/rsbuild/src/index.ts"
import { resolve } from "node:path"
import { mkdir, writeFile, copyFile } from "node:fs/promises"
const selected = process.argv[2]
const outputRoot = resolve(process.env.ISLANDS_BUILD_ROOT ?? process.cwd())
const apps = selected ? [selected] : ["catalog", "cart", "host"]
for (const app of apps) {
  if (!["catalog", "cart", "host"].includes(app)) throw new Error("Unknown app")
  const root = resolve(`apps/${app}`)
  const outDir = resolve(outputRoot, `apps/${app}/dist`)
  await mkdir(outDir, { recursive: true })
  if (app !== "host" && process.env.SERVICE_ONLY !== "1") {
    await buildRelease({
      root: process.cwd(),
      moduleId: app,
      releaseId: process.env.RELEASE_ID ?? "v1",
      publicOrigin: process.env.PUBLIC_ORIGIN ?? `http://localhost:${app === "catalog" ? 4101 : 4102}`,
      outDir,
      serverEntry: `apps/${app}/src/fragment.ts`,
      islands: { [app]: `apps/${app}/src/entry.tsx` },
    })
  }
  const rsbuild = await createRsbuild({
    config: {
      source: {
        define: {
          __ISLANDS_DEV__: JSON.stringify(process.env.ISLANDS_DEV_BUILD === "1"),
        },
      },
      plugins: [pluginReact()],
      environments: {
        ...(app === "host"
          ? {
              coordinator: {
                source: { entry: { start: resolve("scripts/start.ts") } },
                output: {
                  target: "node" as const,
                  module: true,
                  autoExternal: false,
                  cleanDistPath: false,
                  distPath: { root: resolve(outputRoot, "dist") },
                  filename: { js: "[name].mjs" },
                },
              },
            }
          : {}),
        server: {
          source: {
            entry: {
              server: app === "host" ? resolve(root, "src/server.ts") : resolve("scripts/service-entry.ts"),
            },
          },
          output: {
            target: "node",
            module: true,
            autoExternal: false,
            distPath: { root: outDir },
            cleanDistPath: false,
            filename: { js: "[name].mjs" },
          },
          tools: {
            rspack: {
              module: { parser: { javascript: { importMeta: false } } },
              output: { library: { type: "module" } },
            },
          },
        },
        ...(app === "host"
          ? {
              browser: {
                source: {
                  entry: { bootstrap: resolve(root, "src/bootstrap.ts") },
                },
                output: {
                  target: "web" as const,
                  module: true,
                  distPath: { root: resolve(outDir, "assets"), js: "" },
                  filename: { js: "[name].js" },
                },
                tools: { htmlPlugin: false as const },
              },
            }
          : {}),
      },
    },
  })
  const result = await rsbuild.build()
  await result.close()
  await writeFile(
    resolve(outDir, "package.json"),
    JSON.stringify(
      {
        name: `islands-${app}-deploy`,
        private: true,
        type: "module",
        scripts: { start: "node server.mjs" },
      },
      null,
      2,
    ),
  )
  if (app === "host") {
    await copyFile(resolve(root, "src/shell.css"), resolve(outDir, "assets/shell.css"))
    if (process.env.ISLANDS_DEV_BUILD === "1")
      await copyFile(resolve(root, "src/dev-reload.js"), resolve(outDir, "assets/dev-reload.js"))
    const releaseId = process.env.RELEASE_ID ?? "v1"
    await writeFile(
      resolve(outDir, "registry.sample.json"),
      JSON.stringify(
        Object.fromEntries(
          ["catalog", "cart"].map((name, index) => [
            name,
            {
              releaseId,
              manifestUrl: `http://localhost:${4101 + index}/releases/${releaseId}/manifest.json`,
            },
          ]),
        ),
        null,
        2,
      ),
    )
  }
}

import { createHost, createHttpServer, ServiceCredentials, productionHeaders } from "@islands/server"
import { deploymentConfig, readSecretJson } from "../../../scripts/deployment-config.ts"
import express from "express"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
declare const __ISLANDS_DEV__: boolean
const directory = dirname(fileURLToPath(import.meta.url))
const profile = await deploymentConfig()
if (__ISLANDS_DEV__ && profile) throw new Error("Development build cannot use a deployment profile")
const tokens = profile ? await readSecretJson(profile.secrets.hostTokensFile) : undefined
if (
  profile &&
  (!tokens ||
    typeof tokens !== "object" ||
    Array.isArray(tokens) ||
    Object.keys(tokens).length !== profile.network.moduleOrigins.length ||
    profile.network.moduleOrigins.some((origin) => !Object.hasOwn(tokens, origin)))
)
  throw new Error("Missing origin-bound service credentials")
const serviceCredentials = profile ? new ServiceCredentials(tokens as Record<string, string>) : undefined
const app = express()
if (profile) app.use(productionHeaders(profile.network.moduleOrigins))
const shutdown = new AbortController()
app.use("/assets", express.static(resolve(directory, "assets")))
app.use(
  createHost({
    signal: shutdown.signal,
    registryPath: profile?.registryPath ?? process.env.REGISTRY_PATH ?? resolve(directory, "registry.json"),
    allowedOrigins:
      profile?.network.moduleOrigins ??
      (process.env.ALLOWED_ORIGINS ?? "http://localhost:4101,http://localhost:4102").split(","),
    ...(serviceCredentials ? { serviceCredentials } : {}),
    bootstrapUrl: "/assets/bootstrap.js",
    requiredFiles: [resolve(directory, "assets/bootstrap.js"), resolve(directory, "assets/shell.css")],
    routes: {
      "/": [
        {
          name: "catalog",
          moduleId: "catalog",
          props: { title: "Catalog", policy: "load" },
          fallback: "<p>Catalog unavailable</p>",
        },
        {
          name: "repeat",
          moduleId: "catalog",
          props: { title: "Independent catalog", policy: "idle" },
          fallback: "<p>Second catalog unavailable</p>",
        },
        {
          name: "static",
          moduleId: "catalog",
          props: { title: "Static catalog", policy: "never" },
          fallback: "<p>Static catalog unavailable</p>",
        },
        {
          name: "cart",
          moduleId: "cart",
          props: { title: "Cart", policy: "visible" },
          fallback: "<p>Cart unavailable</p>",
        },
      ],
    },
    shell: (slots) =>
      `<link rel="stylesheet" href="/assets/shell.css"><header><h1>Independent React islands</h1><p>Server-rendered content with selective interactivity.</p></header><main>${slots.catalog}${slots.repeat}${slots.static}<div class="below">${slots.cart}</div></main>${__ISLANDS_DEV__ ? '<script src="/assets/dev-reload.js" defer></script>' : ""}`,
    onDiagnostic: (diagnostic) => console.error(JSON.stringify(diagnostic)),
  }),
)
const running = createHttpServer(app, { onDrain: () => shutdown.abort() })
running.server.listen(Number(process.env.PORT ?? 4100), profile ? "127.0.0.1" : undefined)
const stop = () => {
  void running.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  )
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop)
process.on("message", (message) => {
  if (message === "stop") stop()
})

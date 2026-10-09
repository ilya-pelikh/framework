import { createModuleService, loadPublishedReleases, createHttpServer, productionHeaders } from "@islands/server"
import express from "express"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { deploymentConfig, readSecretJson } from "./deployment-config.ts"
const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, "releases")
const profile = await deploymentConfig()
const serviceTokens = profile ? ((await readSecretJson(profile.secrets.moduleTokensFile)) as string[]) : undefined
const loaded = await loadPublishedReleases(root, (event) => console.error(JSON.stringify(event)))
const app = express()
if (profile) app.use(productionHeaders())
app.use(
  createModuleService({
    ...loaded,
    ...(serviceTokens !== undefined ? { serviceTokens } : {}),
    allowedHostOrigins: profile
      ? [profile.hostOrigin]
      : (process.env.HOST_ORIGINS ?? "http://localhost:4100").split(","),
    onDiagnostic: (event) => console.error(JSON.stringify(event)),
  }),
)
const running = createHttpServer(app)
running.server.listen(Number(process.env.PORT ?? 4101), profile ? "127.0.0.1" : undefined)
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

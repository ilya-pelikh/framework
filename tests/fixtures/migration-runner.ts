import express from "express"
import { resolve } from "node:path"
import { createHost, createModuleService, loadPublishedReleases } from "@islands/server"
import { listen, close } from "../helpers/http-server.ts"

let service = createModuleService({ releases: [], allowedHostOrigins: [] })
const remoteApp = express()
remoteApp.use((req, res, next) => service(req, res, next))
const remote = await listen(remoteApp)
const host = await listen(
  createHost({
    registryPath: resolve("registry.json"),
    allowedOrigins: [remote.origin],
    bootstrapUrl: "/bootstrap.js",
    routes: {
      "/": [
        {
          name: "main",
          moduleId: "fixture",
          props: {},
          fallback: "<p>unavailable</p>",
        },
      ],
    },
  }),
)
process.send?.({ host: host.origin, remote: remote.origin })
process.on("message", async (message) => {
  if (message !== "reload") return
  try {
    service = createModuleService({
      ...(await loadPublishedReleases(resolve("live/releases"))),
      allowedHostOrigins: [host.origin],
    })
    process.send?.("loaded")
  } catch {
    process.send?.("failed")
  }
})
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await Promise.all([close(host.server), close(remote.server)])
  process.exit(0)
}
process.on("disconnect", stop)
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop)

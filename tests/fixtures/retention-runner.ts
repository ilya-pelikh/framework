import express from "express"
import { resolve } from "node:path"
import { createHost, createModuleService, createHttpServer, loadPublishedReleases } from "@islands/server"

const running = new Map<string, ReturnType<typeof createHttpServer>>()
const ports = new Map<string, number>()
const shutdown = new AbortController()
async function listen(name: string, app: ReturnType<typeof express>, onDrain?: () => void) {
  const processServer = createHttpServer(app, {
    shutdownGraceMs: 1000,
    ...(onDrain ? { onDrain } : {}),
  })
  running.set(name, processServer)
  await new Promise<void>((done, reject) => {
    processServer.server.once("error", reject)
    processServer.server.listen(ports.get(name) ?? 0, "127.0.0.1", done)
  })
  ports.set(name, (processServer.server.address() as { port: number }).port)
  return `http://127.0.0.1:${ports.get(name)}`
}
const catalog = await listen("catalog", express())
const cart = await listen("cart", express())
const app = express()
app.use("/assets", express.static(resolve("assets")))
app.use(
  createHost({
    signal: shutdown.signal,
    registryPath: resolve("registry.json"),
    allowedOrigins: [catalog, cart],
    bootstrapUrl: "/assets/bootstrap.js",
    routes: {
      "/": [
        {
          name: "catalog",
          moduleId: "catalog",
          props: {},
          fallback: "<p>Catalog unavailable</p>",
        },
        {
          name: "cart",
          moduleId: "cart",
          props: { policy: "load" },
          fallback: "<p>Cart unavailable</p>",
        },
      ],
    },
  }),
)
const host = await listen("host", app, () => shutdown.abort())
process.send?.({ host, catalog, cart })
let operations = Promise.resolve()
process.on("message", (message: { action?: string; module?: string } | string) => {
  if (message === "stop") {
    void stop()
    return
  }
  if (typeof message !== "object" || message === null || stopping) return
  operations = operations
    .then(async () => {
      if (!["catalog", "cart"].includes(message.module ?? "")) throw new Error("Invalid module")
      const name = message.module!
      await running.get(name)?.stop()
      running.delete(name)
      if (message.action === "reload") {
        const loaded = await loadPublishedReleases(resolve(name, "releases"))
        await listen(name, createModuleService({ ...loaded, allowedHostOrigins: [host] }))
      } else if (message.action !== "drain") throw new Error("Invalid action")
      process.send?.("ok")
    })
    .catch(() => {
      process.send?.("failed")
    })
})
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await operations
  await Promise.all([...running.values()].map((server) => server.stop()))
  process.exit(0)
}
process.on("disconnect", () => {
  void stop()
})
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void stop()
  })

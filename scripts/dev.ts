import { watch } from "node:fs"
import { writeFile, rename, mkdir, mkdtemp } from "node:fs/promises"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import express from "express"
import type { Response } from "express"
import { startApps } from "./start.ts"
import { stopOwnedChild } from "./process-lifecycle.ts"
const app = express()
const clients = new Set<Response>()
app.get("/events", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:4100")
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-store")
  res.flushHeaders()
  clients.add(res)
  res.on("close", () => clients.delete(res))
})
const reloadServer = app.listen(4103)
let running: Awaited<ReturnType<typeof startApps>> | undefined
let building = false
let pending = false
let stopped = false
let builder: ReturnType<typeof spawn> | undefined
let activeBase: string | undefined
let work: Promise<void> = Promise.resolve()
const launch = (base: string) =>
  startApps(base, true, {
    env: { REGISTRY_PATH: resolve(base, "apps/host/dist/registry.json") },
  })
function scheduleBuild() {
  if (building) {
    pending = true
    return
  }
  work = rebuild()
}
async function rebuild() {
  if (building) {
    pending = true
    return
  }
  building = true
  try {
    await mkdir(".cache/dev", { recursive: true })
    const base = await mkdtemp(resolve(".cache/dev/generation-"))
    const release = `dev-${randomUUID()}`
    await new Promise<void>((done, reject) => {
      builder = spawn(process.execPath, ["--import", "tsx", "scripts/build.ts"], {
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          RELEASE_ID: release,
          ISLANDS_BUILD_ROOT: base,
          ISLANDS_DEV_BUILD: "1",
        },
      })
      const timer = setTimeout(() => {
        builder?.kill("SIGKILL")
        reject(new Error("Build deadline exceeded"))
      }, 60000)
      builder.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      builder.once("exit", (code) => {
        clearTimeout(timer)
        if (code === 0) done()
        else reject(new Error(`Build failed: ${code}`))
      })
    })
    if (stopped) return
    const registry = Object.fromEntries(
      ["catalog", "cart"].map((name, index) => [
        name,
        {
          releaseId: release,
          manifestUrl: `http://localhost:${4101 + index}/releases/${release}/manifest.json`,
        },
      ]),
    )
    const registryPath = resolve(base, "apps/host/dist/registry.json")
    await writeFile(`${registryPath}.next`, JSON.stringify(registry))
    await rename(`${registryPath}.next`, registryPath)
    if (stopped) return
    await running?.stop()
    running = undefined
    if (stopped) return
    try {
      running = await launch(base)
      activeBase = base
    } catch (error) {
      if (activeBase && !stopped) running = await launch(activeBase)
      throw error
    }
    if (stopped) {
      await running.stop()
      return
    }
    for (const client of clients) client.write("data: reload\n\n")
    console.log(`Dev ready: http://localhost:4100 (${release})`)
  } catch (error) {
    if (!stopped) console.error(error)
  } finally {
    builder = undefined
    building = false
    if (pending && !stopped) {
      pending = false
      scheduleBuild()
    }
  }
}
let debounce: ReturnType<typeof setTimeout>
const watchers = ["apps", "packages"].map((path) =>
  watch(path, { recursive: true }, (_event, file) => {
    if (!file || !/[/\\]src[/\\]/.test(`/${file}`)) return
    clearTimeout(debounce)
    debounce = setTimeout(scheduleBuild, 150)
  }),
)
let stopping: Promise<void> | undefined
function stop() {
  return (stopping ??= (async () => {
    stopped = true
    clearTimeout(debounce)
    watchers.forEach((watcher) => watcher.close())
    if (builder) await stopOwnedChild(builder)
    await work
    await running?.stop()
    for (const client of clients) client.end()
    reloadServer.close()
    process.stdin.pause()
    process.disconnect?.()
  })())
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void stop()
  })
process.stdin.on("data", (data) => {
  if (String(data).trim() === "q") void stop()
})
process.on("message", (message) => {
  if (message === "stop") void stop()
})
work = rebuild()
await work

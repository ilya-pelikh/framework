import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import { stopOwnedChild } from "./process-lifecycle.ts"
export interface StartOptions {
  demo?: boolean
  env?: NodeJS.ProcessEnv
  ports?: readonly [number, number, number]
  startupTimeoutMs?: number
  probeTimeoutMs?: number
  shutdownGraceMs?: number
  shutdownForceMs?: number
}
export async function startApps(
  base = process.env.ISLANDS_BUILD_ROOT ?? process.cwd(),
  stopOnExit = true,
  options: StartOptions = {},
) {
  const children: ChildProcess[] = []
  let stopping = false
  let spawnFailed = false
  const startupTimeout = options.startupTimeoutMs ?? 15000
  const probeTimeout = options.probeTimeoutMs ?? 1000
  const grace = options.shutdownGraceMs ?? 10000
  const force = options.shutdownForceMs ?? 2000
  const ports = options.ports ?? [4100, 4101, 4102]
  if (
    ports.length !== 3 ||
    new Set(ports).size !== 3 ||
    ports.some((port) => !Number.isSafeInteger(port) || port <= 0 || port > 65535)
  )
    throw new Error("Invalid app ports")
  for (const value of [startupTimeout, probeTimeout, grace, force])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid process lifecycle limit")
  const expires = performance.now() + startupTimeout
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ??= (async () => {
      stopping = true
      await Promise.all(children.map((child) => stopOwnedChild(child, grace, force, true)))
    })())
  try {
    for (const [index, app] of ["host", "catalog", "cart"].entries()) {
      const child = spawn(process.execPath, [resolve(base, `apps/${app}/dist/server.mjs`)], {
        env: {
          ...process.env,
          ...options.env,
          ...(options.demo && app === "host"
            ? {
                REGISTRY_PATH: resolve(base, "apps/host/dist/registry.sample.json"),
              }
            : {}),
          PORT: String(ports[index]),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      })
      child.stdout?.pipe(process.stdout)
      child.stderr?.pipe(process.stderr)
      children.push(child)
      child.once("error", () => {
        spawnFailed = true
        if (stopOnExit) void stop().catch(() => console.error("Child cleanup failed"))
      })
      child.once("exit", (code) => {
        if (!stopping && stopOnExit) {
          console.error(`${app} exited: ${code}`)
          void stop().catch(() => console.error("Child cleanup failed"))
        }
      })
    }
    for (const port of ports) {
      for (;;) {
        if (spawnFailed || stopping || children.some((child) => child.exitCode !== null || child.signalCode !== null))
          throw new Error("App exited before readiness")
        if (performance.now() >= expires) throw new Error("Startup deadline exceeded")
        try {
          const response = await fetch(`http://localhost:${port}/readyz`, {
            signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(probeTimeout, expires - performance.now())))),
          })
          await response.body?.cancel()
          if (response.ok) break
        } catch {}
        await new Promise((done) => setTimeout(done, 100))
      }
    }
    return { stop, children }
  } catch (error) {
    await stop()
    throw error
  }
}
if (process.argv[1]?.endsWith("start.ts") || process.argv[1]?.endsWith("start.mjs")) {
  const running = await startApps(undefined, true, {
    demo: process.argv.includes("--demo"),
  })
  console.log("Ready: http://localhost:4100")
  const stop = async () => {
    await running.stop()
    process.stdin.pause()
    process.disconnect?.()
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
}

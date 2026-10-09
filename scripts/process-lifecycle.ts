import type { ChildProcess } from "node:child_process"

export async function stopOwnedChild(child: ChildProcess, graceMs = 10000, forceMs = 2000, ipc = false): Promise<void> {
  for (const value of [graceMs, forceMs])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid shutdown limit")
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  await new Promise<void>((done, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const cleanup = () => {
      clearTimeout(timer)
      child.off("exit", exited)
      child.off("error", failed)
    }
    const exited = () => {
      cleanup()
      done()
    }
    const failed = () => {
      cleanup()
      reject(new Error("Child shutdown failed"))
    }
    child.once("exit", exited)
    child.once("error", failed)
    timer = setTimeout(() => {
      child.kill("SIGKILL")
      timer = setTimeout(() => {
        cleanup()
        reject(new Error("Child forced shutdown deadline"))
      }, forceMs)
    }, graceMs)
    if (ipc && child.connected)
      child.send("stop", (error) => {
        if (error) child.kill()
      })
    else child.kill()
  })
}

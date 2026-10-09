import { mkdtemp, mkdir } from "node:fs/promises"
import { spawn } from "node:child_process"
import type { TestContext } from "node:test"
import { resolve } from "node:path"
import express from "express"
import { browserSession } from "./browser-session.ts"
import { failureArtifacts } from "./failure-artifacts.ts"
import { listen, close } from "./http-server.ts"
export { listen, close } from "./http-server.ts"

export async function runtimeBrowser(
  options: {
    test?: TestContext
    session?: Parameters<typeof browserSession>[0]
    onListening?: (origin: string) => void
  } = {},
) {
  const artifacts = options.session?.artifacts ?? (await failureArtifacts())
  artifacts.stage("setup")
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/runtime-test-"))
  let remote: Awaited<ReturnType<typeof listen>> | undefined
  let session: Awaited<ReturnType<typeof browserSession>> | undefined
  let child: ReturnType<typeof spawn> | undefined
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ??= (async () => {
      artifacts.stage("cleanup")
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      try {
        await session?.stop()
      } finally {
        if (remote) await close(remote.server)
        artifacts.stage("closed")
        await artifacts.save()
      }
    })())
  try {
    artifacts.stage("build")
    await new Promise<void>((done, reject) => {
      child = spawn(process.execPath, ["--import", "tsx", "tests/runtime-build-cli.ts", directory], {
        stdio: "ignore",
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        child?.kill("SIGKILL")
        reject(new Error("Fixture build deadline"))
      }, 15000)
      child.once("error", () => {
        clearTimeout(timer)
        reject(new Error("Fixture build failed"))
      })
      child.once("exit", (code) => {
        clearTimeout(timer)
        if (code === 0) done()
        else reject(new Error("Fixture build failed"))
      })
    })
    options.test?.signal.throwIfAborted()
    const app = express()
    app.use("/runtime", express.static(directory))
    app.get("/bootstrap.js", (_req, res) =>
      res
        .type("js")
        .send(
          'import * as runtime from "/runtime/runtime.js"; globalThis.runtime = runtime; globalThis.diagnostics = []; runtime.bootstrap(undefined, {onError: value => diagnostics.push(value)});',
        ),
    )
    app.get("/empty", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><body><script type="module">import * as runtime from "/runtime/runtime.js"; globalThis.runtime = runtime;</script></body></html>',
        ),
    )
    app.get("/favicon.ico", (_req, res) => res.sendStatus(204))
    remote = await listen(app)
    artifacts.stage("listen")
    options.onListening?.(remote.origin)
    session = await browserSession({
      ...options.session,
      artifacts,
      setup: async (context) => {
        await context.addInitScript({
          content: "globalThis.__name = value => value;",
        })
        await options.session?.setup?.(context)
      },
    })
    options.test?.signal.throwIfAborted()
    options.test?.after(stop)
    return {
      app,
      origin: remote.origin,
      browser: session.browser,
      context: session.context,
      directory,
      artifacts,
      stop,
      assertHealthy: session.assertHealthy,
    }
  } catch (error) {
    artifacts.stage("failed")
    await stop()
    throw error
  }
}

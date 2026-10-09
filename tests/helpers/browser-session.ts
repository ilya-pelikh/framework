import { chromium, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test"
import assert from "node:assert/strict"
import { failureArtifacts } from "./failure-artifacts.ts"

export async function deadline<Result>(pending: Promise<Result>, timeoutMs: number): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_done, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture deadline exceeded")), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function browserSession(
  options: {
    launch?: Parameters<typeof chromium.launchServer>[0]
    setup?: (context: BrowserContext) => Promise<void>
    timeoutMs?: number
    artifacts?: Awaited<ReturnType<typeof failureArtifacts>>
  } = {},
) {
  const artifacts = options.artifacts ?? (await failureArtifacts())
  const timeoutMs = options.timeoutMs ?? 10000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid fixture timeout")
  const expires = performance.now() + timeoutMs
  const remaining = () => Math.max(1, expires - performance.now())
  artifacts.stage("launch")
  let server: Awaited<ReturnType<typeof chromium.launchServer>> | undefined
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ??= (async () => {
      artifacts.stage("cleanup")
      try {
        if (server) {
          try {
            await deadline(server.close(), 3000)
          } catch {
            await deadline(server.kill(), 2000)
          }
        }
      } finally {
        artifacts.stage("closed")
        await artifacts.save()
      }
    })())
  try {
    server = await chromium.launchServer({
      ...options.launch,
      timeout: remaining(),
    })
    const browser = await chromium.connect(server.wsEndpoint(), {
      timeout: remaining(),
    })
    const errors = new WeakMap<Page, { count: number }>()
    const newContext = async (settings: BrowserContextOptions = {}) => {
      const context = await deadline(browser.newContext(settings), 5000)
      context.setDefaultTimeout(5000)
      context.setDefaultNavigationTimeout(10000)
      artifacts.watch(context)
      context.on("page", (page) => {
        const state = { count: 0 }
        errors.set(page, state)
        page.on("pageerror", () => state.count++)
        page.on("console", (message) => {
          if (["error", "warning"].includes(message.type())) state.count++
        })
      })
      return context
    }
    artifacts.stage("context")
    const context = await deadline(newContext(), remaining())
    if (options.setup) await deadline(options.setup(context), remaining())
    artifacts.stage("ready")
    const assertHealthy = (page: Page) => {
      assert.ok(errors.has(page), "Page must belong to this fixture")
      assert.equal(errors.get(page)!.count, 0, "Unexpected browser error or hydration warning")
    }
    return { browser, context, newContext, artifacts, stop, assertHealthy }
  } catch (error) {
    artifacts.stage("failed")
    await stop()
    throw error
  }
}

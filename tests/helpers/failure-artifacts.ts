import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { BrowserContext, Page, Request } from "@playwright/test"

type Stage = "setup" | "build" | "listen" | "launch" | "context" | "ready" | "failed" | "cleanup" | "closed"

export async function failureArtifacts() {
  await mkdir(".cache/test-artifacts", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/test-artifacts/run-"))
  const started = performance.now()
  const limit = 4096
  const trace: object[] = []
  const consoleEvents: object[] = []
  const network: object[] = []
  let dropped = 0
  let pages = 0
  let requests = 0
  const requestIds = new WeakMap<Request, number>()
  const watched = new WeakSet<Page>()
  const push = (target: object[], value: object) => {
    if (target.length < limit) target.push(value)
    else dropped++
  }
  const event = (name: string, page = 0) =>
    push(trace, {
      name,
      cat: "fixture",
      ph: "i",
      s: "t",
      pid: 1,
      tid: page,
      ts: Math.round((performance.now() - started) * 1000),
    })
  const watchPage = (page: Page) => {
    if (watched.has(page)) return
    watched.add(page)
    const id = ++pages
    event("page", id)
    page.on("console", (message) => {
      const type = ["error", "warning", "log", "info", "debug"].includes(message.type()) ? message.type() : "other"
      push(consoleEvents, { page: id, type })
      event(`console-${type}`, id)
    })
    page.on("pageerror", () => {
      push(consoleEvents, { page: id, type: "pageerror" })
      event("pageerror", id)
    })
    page.on("request", (request) => {
      const requestId = ++requests
      requestIds.set(request, requestId)
      const type = ["document", "stylesheet", "script", "image", "font", "fetch", "xhr", "eventsource"].includes(
        request.resourceType(),
      )
        ? request.resourceType()
        : "other"
      push(network, { page: id, request: requestId, event: "request", type })
      event("request", id)
    })
    page.on("response", (response) => {
      push(network, {
        page: id,
        request: requestIds.get(response.request()),
        event: "response",
        status: response.status(),
      })
      event("response", id)
    })
    page.on("requestfailed", (request) => {
      push(network, {
        page: id,
        request: requestIds.get(request),
        event: "failed",
      })
      event("request-failed", id)
    })
    page.on("close", () => event("page-closed", id))
  }
  return {
    directory,
    stage: (stage: Stage) => event(stage),
    watch: (context: BrowserContext) => {
      context.on("page", watchPage)
      for (const page of context.pages()) watchPage(page)
    },
    save: async () => {
      await Promise.all([
        writeFile(resolve(directory, "trace.json"), JSON.stringify({ traceEvents: trace, dropped })),
        writeFile(resolve(directory, "console.json"), JSON.stringify({ events: consoleEvents, dropped })),
        writeFile(resolve(directory, "network.json"), JSON.stringify({ events: network, dropped })),
      ])
    },
  }
}

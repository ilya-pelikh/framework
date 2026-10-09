import { createHash } from "node:crypto"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import express from "express"
import { buildRelease } from "@islands/rsbuild"
import { createHost, createModuleService, loadPublishedReleases } from "@islands/server"
import { runtimeBrowser, listen, close } from "./runtime-browser.ts"
import { scenarios, type QualificationProfile } from "../../scripts/qualification.ts"
import type { LoadAdapter, BrowserSample } from "../../scripts/load-harness.ts"

export async function loadFixture() {
  const fixture = await runtimeBrowser()
  const remotes: Awaited<ReturnType<typeof listen>>[] = []
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let mode = "normal"
  let upstreamDisconnects = 0
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    loop.disable()
    for (const timer of timers) clearTimeout(timer)
    await Promise.all(remotes.map((remote) => close(remote.server)))
    await fixture.stop()
  }
  try {
    const registry: Record<string, { releaseId: string; manifestUrl: string }> = {}
    const artifacts: QualificationProfile["identity"]["artifacts"] = []
    for (const moduleId of ["busy", "neighbor"]) {
      const app = express()
      const remote = await listen(app)
      remotes.push(remote)
      app.use((req, res, next) => {
        if (moduleId !== "busy" || !req.path.endsWith("/render")) return next()
        if (mode === "outage") {
          res.sendStatus(503)
          return
        }
        if (mode !== "disconnect") return next()
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!res.destroyed) next()
        }, 150)
        timers.add(timer)
        res.once("close", () => {
          if (!res.writableFinished) upstreamDisconnects++
          clearTimeout(timer)
          timers.delete(timer)
        })
      })
      const outDir = resolve(fixture.directory, moduleId)
      await buildRelease({
        root: process.cwd(),
        outDir,
        moduleId,
        releaseId: "v1",
        publicOrigin: remote.origin,
        serverEntry: "tests/fixtures/recommendations/fragment.ts",
        islands: { recommendation: "tests/fixtures/recommendations/entry.ts" },
      })
      app.use(
        createModuleService({
          ...(await loadPublishedReleases(resolve(outDir, "releases"))),
          allowedHostOrigins: [fixture.origin],
        }),
      )
      registry[moduleId] = {
        releaseId: "v1",
        manifestUrl: `${remote.origin}/releases/v1/manifest.json`,
      }
      artifacts.push({
        name: `${moduleId}/integrity.json`,
        sha256: createHash("sha256")
          .update(await readFile(resolve(outDir, "releases/v1/integrity.json")))
          .digest("hex"),
      })
    }
    const registryPath = resolve(fixture.directory, "registry.json")
    await writeFile(registryPath, JSON.stringify(registry))
    fixture.app.use(
      createHost({
        registryPath,
        allowedOrigins: remotes.map((remote) => remote.origin),
        bootstrapUrl: "/bootstrap.js",
        routes: {
          "/": ["busy", "neighbor"].map((moduleId) => ({
            name: moduleId,
            moduleId,
            props: { message: moduleId },
            fallback: `<p>${moduleId}-fallback</p>`,
          })),
        },
      }),
    )
    const bytes = await readFile("tests/helpers/load-fixture.ts")
    const fingerprint = createHash("sha256").update(bytes).digest("hex")
    artifacts.push({
      name: "browser/runtime.js",
      sha256: createHash("sha256")
        .update(await readFile(resolve(fixture.directory, "runtime.js")))
        .digest("hex"),
    })
    const profile: QualificationProfile = {
      schemaVersion: 1,
      purpose: "local-smoke",
      environment: {
        name: "synthetic-local-fixture",
        baseUrl: fixture.origin,
        assetOrigins: remotes.map((remote) => remote.origin),
        deploymentProfileSha256: createHash("sha256").update(JSON.stringify(registry)).digest("hex"),
      },
      // Local source fingerprint only; not a Git revision or target provenance.
      identity: { commit: fingerprint, artifacts },
      approval: {
        frozenAt: new Date().toISOString(),
        approvedBy: "local-test-fixture",
        evidence: "synthetic test configuration, not owner approval",
      },
      owners: {
        environment: "local-test",
        release: "local-test",
        security: "local-test",
        onCall: "local-test",
      },
      operations: {
        runbookRecord: "local-test-only",
        retentionMs: 1000,
        pageLifetimeMs: 500,
        rollbackWindowMs: 500,
        propagationMs: 100,
        clockMarginMs: 100,
      },
      workload: Object.fromEntries(
        scenarios.map((name) => [
          name,
          {
            rps: name === "burst" ? 20 : 10,
            concurrency: 4,
            durationMs: name === "soak" ? 800 : 400,
            requestTimeoutMs: 2000,
            disconnectAfterMs: 30,
            routes: [
              {
                path: "/",
                weight: 1,
                slots: 2,
                payloadBytes:
                  Buffer.byteLength(JSON.stringify({ message: "busy" })) +
                  Buffer.byteLength(JSON.stringify({ message: "neighbor" })),
              },
            ],
          },
        ]),
      ) as QualificationProfile["workload"],
      devices: [
        {
          name: "chromium-desktop-emulation",
          viewport: { width: 1280, height: 720 },
          deviceScaleFactor: 1,
          cpuSlowdown: 1,
          mobile: false,
        },
      ],
      networks: [
        {
          name: "local-shaped-network",
          latencyMs: 0,
          downloadBytesPerSecond: 20000000,
          uploadBytesPerSecond: 20000000,
        },
      ],
      thresholds: Object.fromEntries(
        scenarios.map((name) => [
          name,
          {
            latencyP95Ms: 2000,
            latencyP99Ms: 2000,
            rssBytes: 2147483648,
            eventLoopP99Ms: 1000,
            connections: 100,
            fallbackRate: name === "outage" ? 1 : 0,
            errorRate: 0,
            browserTransferBytes: 4000000,
            hydrationMs: 10000,
            cls: 1,
          },
        ]),
      ) as QualificationProfile["thresholds"],
    }
    const adapter: LoadAdapter = {
      async begin(candidate) {
        if (candidate.purpose !== "local-smoke" || candidate.environment.baseUrl !== fixture.origin)
          throw new Error("Local fixture only")
        return {
          identity: profile.identity,
          deploymentProfileSha256: createHash("sha256")
            .update(await readFile(registryPath))
            .digest("hex"),
          workloadVerified: JSON.stringify(candidate.workload) === JSON.stringify(profile.workload),
          serverVersions: {
            node: process.version,
            platform: process.platform,
            measurementScope: "fixture and generator share process; smoke only",
          },
        }
      },
      async enter(scenario) {
        mode = scenario
        loop.reset()
        if (scenario === "disconnect") upstreamDisconnects = 0
      },
      async restore(scenario) {
        mode = "normal"
        if (scenario === "disconnect" && upstreamDisconnects === 0) throw new Error("Upstream disconnect not observed")
      },
      async sample() {
        const connections = await Promise.all(
          remotes.map(
            (remote) =>
              new Promise<number>((done, reject) =>
                remote.server.getConnections((error, count) => (error ? reject(error) : done(count))),
              ),
          ),
        )
        return {
          rssBytes: process.memoryUsage().rss,
          eventLoopP99Ms: loop.percentile(99) / 1e6,
          connections: connections.reduce((sum, count) => sum + count, 0),
        }
      },
      classify(status, body) {
        return {
          fallback: body.includes("busy-fallback"),
          error: status !== 200 || (!body.includes("neighbor") && !body.includes("busy")),
        }
      },
      async browser(scenario, path, device, network, signal): Promise<BrowserSample> {
        const context = await fixture.browser.newContext({
          viewport: device.viewport,
          deviceScaleFactor: device.deviceScaleFactor,
          isMobile: device.mobile,
          serviceWorkers: "block",
        })
        fixture.artifacts.watch(context)
        const abort = () => {
          void context.close().catch(() => {})
        }
        signal.addEventListener("abort", abort, { once: true })
        try {
          if (signal.aborted) throw new Error("Aborted")
          await context.addInitScript(() => {
            ;(globalThis as any).__name = (value: unknown) => value
            let current = 0
            let max = 0
            let first = 0
            let last = 0
            ;(globalThis as any).readFixtureCls = () => max
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries() as any[]) {
                if (entry.hadRecentInput) continue
                if (entry.startTime - last >= 1000 || entry.startTime - first >= 5000) {
                  current = 0
                  first = entry.startTime
                }
                current += entry.value
                max = Math.max(max, current)
                last = entry.startTime
              }
            }).observe({ type: "layout-shift", buffered: true })
          })
          const page = await context.newPage()
          const cdp = await context.newCDPSession(page)
          let transferred = 0
          let errors = 0
          page.on("pageerror", () => errors++)
          page.on("console", (message) => {
            if (message.type() === "error" || /hydration|did not match/i.test(message.text())) errors++
          })
          cdp.on("Network.loadingFinished", (value) => {
            transferred += value.encodedDataLength
          })
          await cdp.send("Network.enable")
          await cdp.send("Network.setCacheDisabled", { cacheDisabled: true })
          await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: network.latencyMs,
            downloadThroughput: network.downloadBytesPerSecond,
            uploadThroughput: network.uploadBytesPerSecond,
          })
          await cdp.send("Emulation.setCPUThrottlingRate", {
            rate: device.cpuSlowdown,
          })
          await page.goto(new URL(path, fixture.origin).href, {
            waitUntil: "load",
            timeout: 15000,
          })
          await page.waitForFunction(
            (outage: boolean) => {
              const buttons = Array.from(document.querySelectorAll("button"))
              return buttons.length === (outage ? 1 : 2) && buttons.every((button) => !button.disabled)
            },
            scenario === "outage",
            { timeout: 10000 },
          )
          const hydrationMs = await page.evaluate(() => performance.now())
          await page.getByRole("button", { name: "neighbor", exact: true }).click()
          await page
            .getByRole("button", { name: "neighbor", exact: true })
            .filter({ hasText: "Choose 1" })
            .waitFor({ timeout: 5000 })
          await page.waitForTimeout(100)
          return {
            browserTransferBytes: transferred,
            hydrationMs,
            cls: await page.evaluate(() => (globalThis as any).readFixtureCls()),
            errors,
            browserVersion: fixture.browser.version(),
          }
        } finally {
          signal.removeEventListener("abort", abort)
          await context.close()
        }
      },
    }
    return {
      profile,
      adapter,
      directory: fixture.directory,
      stop,
      upstreamDisconnects: () => upstreamDisconnects,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

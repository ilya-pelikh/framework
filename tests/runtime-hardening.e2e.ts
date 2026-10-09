import { test } from "node:test"
import assert from "node:assert/strict"
import { runtimeBrowser } from "./helpers/runtime-browser.ts"

test(
  "browser validates payloads and isolates invalid explicit descriptors/entries",
  { timeout: 30000 },
  async (testContext) => {
    const fixture = await runtimeBrowser({ test: testContext })
    try {
      const page = await fixture.context.newPage()
      const uncaught: string[] = []
      page.on("pageerror", (error) => uncaught.push(error.message))
      await page.goto(`${fixture.origin}/empty`)
      await page.waitForFunction(() => !!(window as any).runtime)
      const result = await page.evaluate(async () => {
        const runtime = (window as any).runtime
        const diagnostics: any[] = []
        const options = {
          onError: (item: any) => {
            diagnostics.push(item)
            throw new Error("sink failure")
          },
        }
        for (const html of [
          '<div data-island="counter"></div>',
          '<div id="islands-payload">[]</div>',
          '<script id="islands-payload" type="application/json">not-json</script>',
          '<script id="islands-payload" type="application/json">{}</script>',
          '<script id="islands-payload" type="application/json">[]</script><script id="islands-payload" type="application/json">[]</script>',
        ]) {
          document.body.innerHTML = html
          runtime.bootstrap(undefined, options)
        }
        document.body.innerHTML = ""
        const names = ["valid", "bad-entry", "bad-hydrate", "bad-import", "missing"]
        const descriptors = names.map((name) => ({
          id: name,
          islandKey: "counter",
          moduleId: "fixture",
          releaseId: "v1",
          identifierPrefix: `${name}-`,
          props: { secret: "NEVER_LOG" },
          policy: "load",
          clientEntryUrl: `${location.origin}/releases/v1/assets/${name}.js`,
        }))
        for (const name of names.slice(0, -1)) {
          const element = document.createElement("div")
          element.id = name
          element.dataset.island = "counter"
          element.textContent = "SSR"
          document.body.append(element)
        }
        let roots = 0
        const importer = async (url: string) => {
          if (url.includes("bad-entry")) return {}
          if (url.includes("bad-import")) throw new Error("NEVER_LOG")
          return {
            hydrate: () => {
              if (url.includes("bad-hydrate")) throw new Error("NEVER_LOG")
              roots++
              return () => {}
            },
          }
        }
        runtime.bootstrap([{ invalid: true }, ...descriptors], {
          ...options,
          importEntry: importer,
        })
        await new Promise((done) => setTimeout(done, 20))
        return {
          roots,
          diagnostics,
          ssr: document.getElementById("bad-import")!.textContent,
          unavailable: document.querySelectorAll("[data-island-unavailable]").length,
        }
      })
      assert.equal(result.roots, 1)
      assert.equal(result.ssr, "SSR")
      assert.equal(result.unavailable, 3)
      assert.equal(result.diagnostics.filter((item) => item.category === "payload").length, 5)
      for (const category of ["descriptor", "entry-contract", "hydrate", "import", "missing-container"])
        assert.ok(
          result.diagnostics.some((item) => item.category === category),
          category,
        )
      assert.doesNotMatch(JSON.stringify(result.diagnostics), /NEVER_LOG/)
      assert.deepEqual(uncaught, [])
    } finally {
      await fixture.stop()
    }
  },
)

test(
  "dispose isolates cleanup, is idempotent and scopes equal IDs by document",
  { timeout: 30000 },
  async (testContext) => {
    const fixture = await runtimeBrowser({ test: testContext })
    try {
      const page = await fixture.context.newPage()
      await page.goto(`${fixture.origin}/empty`)
      await page.waitForFunction(() => !!(window as any).runtime)
      const result = await page.evaluate(async () => {
        const runtime = (window as any).runtime
        const counts: Record<string, number> = {}
        const diagnostics: string[] = []
        const descriptor = (name: string, suffix = name) => ({
          id: name,
          islandKey: "counter",
          moduleId: "fixture",
          releaseId: "v1",
          identifierPrefix: `${name}-`,
          props: {},
          policy: "load",
          clientEntryUrl: `${location.origin}/releases/v1/assets/${suffix}.js`,
        })
        const mount = (doc: Document, name: string) => {
          const element = doc.createElement("div")
          element.id = name
          element.dataset.island = "counter"
          doc.body.append(element)
        }
        for (const name of ["throwing", "neighbor", "same"]) mount(document, name)
        const importer = async (url: string) => ({
          hydrate: () => {
            counts.roots = (counts.roots ?? 0) + 1
            return () => {
              const name = url.split("/").at(-1)!
              counts[name] = (counts[name] ?? 0) + 1
              if (name === "throwing.js") throw new Error("cleanup failure")
            }
          },
        })
        const cleanup = runtime.bootstrap(
          ["throwing", "neighbor", "same"].map((name) => descriptor(name)),
          {
            importEntry: importer,
            onError: (item: any) => diagnostics.push(item.category),
          },
        )
        const frame = document.createElement("iframe")
        document.body.append(frame)
        const other = frame.contentDocument!
        mount(other, "same")
        const cleanupOther = runtime.bootstrap([descriptor("same", "other")], {
          document: other,
          importEntry: importer,
        })
        await new Promise((done) => setTimeout(done, 20))
        cleanup()
        cleanup()
        runtime.dispose()
        runtime.bootstrap([descriptor("same")], { importEntry: importer })
        const before = counts["other.js"] ?? 0
        cleanupOther()
        cleanupOther()
        return { counts, before, diagnostics }
      })
      assert.equal(result.counts.roots, 4)
      assert.equal(result.before, 0)
      for (const name of ["throwing.js", "neighbor.js", "same.js", "other.js"])
        assert.equal(result.counts[name], 1, name)
      assert.deepEqual(result.diagnostics, ["cleanup"])
    } finally {
      await fixture.stop()
    }
  },
)

test(
  "dispose cancels scheduled work and late imports without retaining detached DOM",
  { timeout: 30000 },
  async (testContext) => {
    const fixture = await runtimeBrowser({ test: testContext })
    try {
      const page = await fixture.context.newPage()
      await page.goto(`${fixture.origin}/empty`)
      await page.waitForFunction(() => !!(window as any).runtime)
      const result = await page.evaluate(async () => {
        const runtime = (window as any).runtime
        let roots = 0
        let idleCancelled = 0
        let observerCancelled = 0
        let resolveImport: (value: any) => void = () => {}
        const pending = new Promise((done) => {
          resolveImport = done
        })
        const callbacks: (() => void)[] = []
        ;(window as any).requestIdleCallback = (callback: () => void) => {
          callbacks.push(callback)
          return 1
        }
        ;(window as any).cancelIdleCallback = () => {
          idleCancelled++
          throw new Error("cancel failure")
        }
        ;(window as any).IntersectionObserver = class {
          constructor(callback: (entries: any[]) => void) {
            callbacks.push(() => callback([{ isIntersecting: true }]))
          }
          observe() {}
          disconnect() {
            observerCancelled++
          }
        }
        const descriptors = ["load", "idle", "visible"].map((policy) => {
          const element = document.createElement("div")
          element.id = policy
          element.dataset.island = "counter"
          document.body.append(element)
          return {
            id: policy,
            islandKey: "counter",
            moduleId: "fixture",
            releaseId: "v1",
            identifierPrefix: `${policy}-`,
            props: {},
            policy,
            clientEntryUrl: `${location.origin}/releases/v1/assets/${policy}.js`,
          }
        })
        const cleanup = runtime.bootstrap(descriptors, {
          importEntry: () => pending,
        })
        await Promise.resolve()
        cleanup()
        cleanup()
        for (const callback of callbacks) callback()
        for (const descriptor of descriptors) document.getElementById(descriptor.id)!.remove()
        resolveImport({
          hydrate: () => {
            roots++
            return () => {}
          },
        })
        await new Promise((done) => setTimeout(done, 20))
        let detached: HTMLElement | null = document.createElement("div")
        detached.id = "collectable"
        detached.dataset.island = "counter"
        document.body.append(detached)
        runtime.bootstrap(
          [
            {
              ...descriptors[0],
              id: "collectable",
              identifierPrefix: "collectable-",
              clientEntryUrl: `${location.origin}/releases/v1/assets/collectable.js`,
            },
          ],
          { importEntry: async () => ({ hydrate: () => () => {} }) },
        )
        await new Promise((done) => setTimeout(done, 20))
        runtime.dispose("collectable")
        detached.remove()
        ;(window as any).detachedReference = new WeakRef(detached)
        detached = null
        return { roots, idleCancelled, observerCancelled }
      })
      assert.deepEqual(result, {
        roots: 0,
        idleCancelled: 1,
        observerCancelled: 1,
      })
      const session = await fixture.context.newCDPSession(page)
      await session.send("HeapProfiler.collectGarbage")
      assert.equal(await page.evaluate(() => (window as any).detachedReference.deref() === undefined), true)
    } finally {
      await fixture.stop()
    }
  },
)

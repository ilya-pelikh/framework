import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises"
import { resolve } from "node:path"
import { createHash, X509Certificate } from "node:crypto"
import { createServer as httpServer, request as httpRequest } from "node:http"
import { createServer, request, type Server } from "node:https"
import { buildRelease } from "@islands/rsbuild"
import { browserSession, deadline } from "./helpers/browser-session.ts"
import { close } from "./helpers/http-server.ts"
import { stopOwnedChild } from "../scripts/process-lifecycle.ts"

const execute = promisify(execFile)

test(
  "HTTPS target binaries hydrate cross-origin under enforced CSP without production reload",
  { timeout: 90000 },
  async () => {
    await mkdir(".cache", { recursive: true })
    const directory = await mkdtemp(resolve(".cache/https-policy-"))
    const keyPath = resolve(directory, "localhost.key")
    const certificatePath = resolve(directory, "localhost.crt")
    const servers: Server[] = []
    const children: ChildProcess[] = []
    let session: Awaited<ReturnType<typeof browserSession>> | undefined
    try {
      await execute(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certificatePath,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { timeout: 15000, windowsHide: true },
      )
      const key = await readFile(keyPath)
      const cert = await readFile(certificatePath)
      const upstreams: number[] = []
      const origins: string[] = []
      for (const index of [0, 1, 2]) {
        const reserve = httpServer()
        await new Promise<void>((done, reject) => {
          reserve.once("error", reject)
          reserve.listen(0, "127.0.0.1", done)
        })
        upstreams.push((reserve.address() as { port: number }).port)
        await close(reserve)
        const server = createServer({ key, cert, minVersion: "TLSv1.2" }, (incoming, outgoing) => {
          const upstream = httpRequest(
            {
              hostname: "127.0.0.1",
              port: upstreams[index]!,
              method: incoming.method,
              path: incoming.url,
              headers: incoming.headers,
            },
            (response) => {
              outgoing.writeHead(response.statusCode!, response.headers)
              response.pipe(outgoing)
            },
          )
          upstream.setTimeout(5000, () => upstream.destroy())
          upstream.on("error", () => {
            if (!outgoing.headersSent) outgoing.writeHead(502)
            outgoing.end()
          })
          outgoing.on("close", () => upstream.destroy())
          incoming.pipe(upstream)
        })
        servers.push(server)
        await new Promise<void>((done, reject) => {
          server.once("error", reject)
          server.listen(0, "127.0.0.1", done)
        })
        origins.push(`https://127.0.0.1:${(server.address() as { port: number }).port}`)
      }
      const hostOrigin = origins[0]!
      const moduleOrigins = origins.slice(1)
      const get = (url: string, headers: Record<string, string> = {}) =>
        new Promise<{
          status: number
          headers: import("node:http").IncomingHttpHeaders
          body: string
        }>((done, reject) => {
          const pending = request(url, { ca: cert, headers, timeout: 5000 }, (response) => {
            let body = ""
            response.setEncoding("utf8")
            response.on("data", (chunk) => {
              body += chunk
            })
            response.on("end", () =>
              done({
                status: response.statusCode!,
                headers: response.headers,
                body,
              }),
            )
            response.on("error", reject)
          })
          pending.on("timeout", () => pending.destroy(new Error("HTTPS fixture deadline")))
          pending.on("error", reject)
          pending.end()
        })
      await execute(process.execPath, ["--import", "tsx", "scripts/build.ts"], {
        timeout: 45000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          ISLANDS_BUILD_ROOT: directory,
          ISLANDS_DEV_BUILD: "0",
          SERVICE_ONLY: "1",
        },
      })
      for (const [index, moduleId] of ["catalog", "cart"].entries()) {
        await buildRelease({
          root: process.cwd(),
          outDir: resolve(directory, `apps/${moduleId}/dist`),
          moduleId,
          releaseId: "v1",
          publicOrigin: moduleOrigins[index]!,
          serverEntry: `apps/${moduleId}/src/fragment.ts`,
          islands: { [moduleId]: `apps/${moduleId}/src/entry.tsx` },
        })
      }
      const registryPath = resolve(directory, "registry.json")
      await writeFile(
        registryPath,
        JSON.stringify(
          Object.fromEntries(
            ["catalog", "cart"].map((moduleId, index) => [
              moduleId,
              {
                releaseId: "v1",
                manifestUrl: `${moduleOrigins[index]}/releases/v1/manifest.json`,
              },
            ]),
          ),
        ),
      )
      const hostTokensFile = resolve(directory, "host-tokens.json")
      const moduleTokensFile = resolve(directory, "module-tokens.json")
      const token = "fixture-service-token-".padEnd(64, "a")
      await writeFile(
        hostTokensFile,
        JSON.stringify(Object.fromEntries(moduleOrigins.map((origin) => [origin, token]))),
      )
      await writeFile(moduleTokensFile, JSON.stringify([token]))
      const reference = JSON.parse(await readFile("deployment/profile.example.json", "utf8"))
      const profilePath = resolve(directory, "profile.json")
      await writeFile(
        profilePath,
        JSON.stringify({
          ...reference,
          purpose: "target",
          environment: "local-https-fixture",
          hostOrigin,
          registryPath,
          network: {
            ...reference.network,
            moduleOrigins,
            hostAddresses: ["127.0.0.1"],
          },
          secrets: { hostTokensFile, moduleTokensFile },
        }),
      )
      for (const [index, name] of ["host", "catalog", "cart"].entries()) {
        const child = spawn(process.execPath, [resolve(directory, `apps/${name}/dist/server.mjs`)], {
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            ...process.env,
            PORT: String(upstreams[index]),
            DEPLOYMENT_PROFILE: profilePath,
            NODE_EXTRA_CA_CERTS: certificatePath,
            DEV_RELOAD_ORIGIN: "http://localhost:4103",
            ISLANDS_DEV_BUILD: "1",
          },
        })
        children.push(child)
        let failed = false
        child.once("error", () => {
          failed = true
        })
        const expires = performance.now() + 10000
        while (true) {
          if (failed || child.exitCode !== null || performance.now() > expires)
            throw new Error("HTTPS target startup failed")
          const readiness = await get(`${origins[index]}/readyz`, index ? { Authorization: `Bearer ${token}` } : {})
          if (readiness.status === 200) break
          await new Promise((done) => setTimeout(done, 50))
        }
      }
      const certificate = new X509Certificate(cert)
      const fingerprint = createHash("sha256")
        .update(certificate.publicKey.export({ type: "spki", format: "der" }))
        .digest("base64")
      session = await browserSession({
        launch: {
          args: [`--ignore-certificate-errors-spki-list=${fingerprint}`],
        },
      })
      await session.context.addInitScript({
        content:
          'globalThis.__name = value => value; globalThis.cspViolations = []; addEventListener("securitypolicyviolation", event => cspViolations.push(event.effectiveDirective));',
      })
      const page = await session.context.newPage()
      const requested: string[] = []
      page.on("request", (incoming) => requested.push(incoming.url()))
      const response = await page.goto(hostOrigin)
      assert.equal(response!.status(), 200)
      assert.match(response!.headers()["content-security-policy"]!, /script-src 'self' https:/)
      const catalog = page.locator("section").first()
      await catalog.locator("input:enabled").fill("apple")
      assert.equal(await catalog.locator("li").count(), 1)
      await page.getByRole("button", { name: "Add one" }).scrollIntoViewIfNeeded()
      await page.getByRole("button", { name: "Add one" }).click()
      await page.getByText("Quantity: 2", { exact: true }).waitFor()
      assert.equal(await page.locator("body").evaluate((element) => getComputedStyle(element).maxWidth), "900px")
      assert.equal(await page.locator('style, [style], script:not([src]):not([type="application/json"])').count(), 0)
      assert.deepEqual(await page.evaluate(() => (globalThis as any).cspViolations), [])
      assert.ok(requested.some((url) => url.startsWith(moduleOrigins[0]!) && url.endsWith(".js")))
      assert.ok(requested.some((url) => url.startsWith(moduleOrigins[1]!) && url.endsWith(".css")))
      assert.ok(requested.every((url) => url.startsWith("https://")))
      assert.ok(requested.every((url) => !/4103|dev-reload|\/events/.test(url)))
      session.assertHealthy(page)
      for (const path of ["/", "/assets/shell.css", "/missing", "/events", "/assets/dev-reload.js"]) {
        const result = await get(hostOrigin + path)
        assert.equal(result.status, ["/", "/assets/shell.css"].includes(path) ? 200 : 404)
        assert.equal(result.headers["x-content-type-options"], "nosniff")
        assert.equal(result.headers["referrer-policy"], "no-referrer")
        assert.equal(result.headers["strict-transport-security"], "max-age=31536000")
      }
      const manifest = JSON.parse(
        (
          await get(`${moduleOrigins[0]}/releases/v1/manifest.json`, {
            Authorization: `Bearer ${token}`,
          })
        ).body,
      )
      for (const [url, mime] of [
        [manifest.islands.catalog.clientEntryUrl, /javascript/],
        [manifest.islands.catalog.cssUrls[0], /css/],
      ] as const) {
        const allowed = await get(url, { Origin: hostOrigin })
        assert.equal(allowed.status, 200)
        assert.match(allowed.headers["content-type"]!, mime)
        assert.equal(allowed.headers["access-control-allow-origin"], hostOrigin)
        assert.match(String(allowed.headers.vary), /Origin/)
        assert.equal(allowed.headers["x-content-type-options"], "nosniff")
        const denied = await get(url, { Origin: "https://untrusted.example" })
        assert.equal(denied.headers["access-control-allow-origin"], undefined)
      }
      const privateResponse = await get(`${moduleOrigins[0]}/releases/v1/manifest.json`)
      assert.equal(privateResponse.status, 401)
      assert.equal(privateResponse.headers["x-content-type-options"], "nosniff")
      await page.evaluate(() => {
        const script = document.createElement("script")
        script.textContent = "globalThis.inlineExecuted = true"
        document.body.append(script)
        const style = document.createElement("style")
        style.textContent = "body{max-width:1px}"
        document.head.append(style)
      })
      await page.waitForFunction(() => (globalThis as any).cspViolations.length === 2)
      assert.equal(await page.evaluate(() => (globalThis as any).inlineExecuted), undefined)
      assert.deepEqual((await page.evaluate(() => (globalThis as any).cspViolations)).sort(), [
        "script-src-elem",
        "style-src-elem",
      ])
      assert.equal(await page.locator("body").evaluate((element) => getComputedStyle(element).maxWidth), "900px")
    } finally {
      try {
        await session?.stop()
      } finally {
        try {
          await Promise.all(children.map((child) => stopOwnedChild(child, 3000, 2000, true)))
        } finally {
          try {
            await Promise.all(servers.map((server) => deadline(close(server), 5000)))
          } finally {
            await unlink(keyPath).catch(() => {})
          }
        }
      }
    }
  },
)

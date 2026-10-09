import { test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes, createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { request as httpRequest } from "node:http"
import express from "express"
import {
  createHost,
  createModuleService,
  FragmentFetcher,
  ServiceCredentials,
  serviceBoundary,
  parseDeploymentProfile,
  type Diagnostic,
} from "@islands/server"
import { listen, close } from "./helpers/http-server.ts"
import { publishedRelease } from "./helpers/published-release.ts"
import { deploymentConfig, readSecretJson } from "../scripts/deployment-config.ts"

test("deployment schema rejects missing ownership, writable artifacts, public render and missing authentication", async () => {
  const example = JSON.parse(await readFile("deployment/profile.example.json", "utf8"))
  assert.equal(parseDeploymentProfile(example).purpose, "reference")
  const changes = [
    { owner: "" },
    { schemaVersion: 2 },
    { token: "do-not-store-secrets" },
    { registryPath: "../registry.json" },
    {
      principals: {
        ...example.principals,
        registryWriters: [example.principals.runtime],
      },
    },
    { principals: { ...example.principals, trustedPublishers: [] } },
    { storage: { ...example.storage, releasesReadOnly: false } },
    { storage: { ...example.storage, registryReadOnly: false } },
    { network: { ...example.network, renderAccess: "public" } },
    { network: { ...example.network, serviceAuth: "none" } },
    { network: { ...example.network, upstreamBind: "0.0.0.0" } },
    {
      network: { ...example.network, moduleOrigins: ["http://module.example"] },
    },
    { network: { ...example.network, moduleOrigins: [example.hostOrigin] } },
    { network: { ...example.network, hostAddresses: ["0.0.0.0/0"] } },
  ]
  for (const change of changes) assert.throws(() => parseDeploymentProfile({ ...example, ...change }))
  assert.throws(() => parseDeploymentProfile({}))
})

test("service credentials reject unsafe origins and tokens and never serialize secrets", () => {
  const token = randomBytes(32).toString("base64url")
  const credentials = new ServiceCredentials({
    "https://module.example": token,
  })
  assert.equal(credentials.headers("https://module.example/releases/v1/render").authorization, `Bearer ${token}`)
  for (const url of [
    "https://neighbor.example/releases/v1/render",
    "http://module.example/releases/v1/render",
    "https://module.example/releases/v1/assets/entry.js",
  ])
    assert.deepEqual(credentials.headers(url), {})
  assert.equal(JSON.stringify(credentials), "{}")
  for (const origin of ["http://module.example", "https://user:password@module.example", "https://module.example/path"])
    assert.throws(() => new ServiceCredentials({ [origin]: token }))
  assert.throws(() => new ServiceCredentials({ "https://module.example": "short" }))
  assert.throws(() => serviceBoundary([]))
})

test("production entry configuration refuses reference profile and unavailable secrets without exposing values", async (context) => {
  const previous = process.env.DEPLOYMENT_PROFILE
  context.after(() => {
    if (previous === undefined) delete process.env.DEPLOYMENT_PROFILE
    else process.env.DEPLOYMENT_PROFILE = previous
  })
  process.env.DEPLOYMENT_PROFILE = resolve("deployment/profile.example.json")
  await assert.rejects(deploymentConfig(), /^Error: Target deployment profile required$/)
  await assert.rejects(readSecretJson("missing-secret-file"), /^Error: Service secret unavailable$/)
})

test(
  "real host authenticates private manifest/render while public assets stay public and client credentials cannot bypass boundary",
  { timeout: 15000 },
  async (context) => {
    const token = randomBytes(32).toString("base64url")
    const oldToken = randomBytes(32).toString("base64url")
    const app = express()
    const remote = await listen(app)
    context.after(() => close(remote.server))
    const decoyApp = express()
    const decoy = await listen(decoyApp)
    context.after(() => close(decoy.server))
    let leaked = 0
    const decoyHeaders: (string | undefined)[] = []
    decoyApp.use((req, res) => {
      leaked++
      decoyHeaders.push(req.get("authorization"))
      res.json({ ok: true })
    })
    app.get("/releases/redirect/manifest.json", serviceBoundary([token]), (_req, res) =>
      res.redirect(`${decoy.origin}/releases/v1/manifest.json`),
    )
    await mkdir(".cache", { recursive: true })
    const directory = await mkdtemp(resolve(".cache/deployment-boundary-"))
    let rendered = 0
    const headers: (string | undefined)[] = []
    const cookies: (string | undefined)[] = []
    app.use((req, _res, next) => {
      headers.push(req.get("authorization"))
      cookies.push(req.get("cookie"))
      next()
    })
    const manifest = {
      protocolVersion: 1 as const,
      moduleId: "fixture",
      releaseId: "v1",
      reactVersion: "19.3.0",
      renderUrl: `${remote.origin}/releases/v1/render`,
      islands: {},
    }
    const release = await publishedRelease(
      directory,
      manifest,
      () => {
        rendered++
        return {
          protocolVersion: 1,
          moduleId: "fixture",
          releaseId: "v1",
          html: "<p>authenticated SSR</p>",
          islands: [],
        }
      },
      { "entry.js": "export const ready = true;" },
    )
    const inventory = await readFile(resolve(release.releaseDirectory, "integrity.json"))
    const events: Diagnostic[] = []
    app.use(
      createModuleService({
        releases: [release],
        allowedHostOrigins: ["https://shop.example"],
        serviceTokens: [token, oldToken],
        onDiagnostic: (event) => events.push(event),
      }),
    )
    for (const path of [
      "/healthz",
      "/readyz",
      "/releases/v1/readyz",
      "/releases/v1/manifest.json",
      "/releases/v1/render",
    ]) {
      const response = await fetch(remote.origin + path, {
        method: path.endsWith("/render") ? "POST" : "GET",
        headers: {
          origin: "https://shop.example",
          "x-forwarded-for": "192.0.2.10",
          cookie: "session=client",
        },
      })
      assert.equal(response.status, 401)
      assert.equal(response.headers.get("cache-control"), "no-store")
    }
    assert.equal(rendered, 0)
    const asset = await fetch(`${remote.origin}/releases/v1/assets/entry.js`, {
      headers: { origin: "https://shop.example" },
    })
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get("access-control-allow-origin"), "https://shop.example")
    const privateUrl = `${remote.origin}/releases/v1/manifest.json`
    const authenticatedManifest = await fetch(privateUrl, {
      headers: { authorization: `Bearer ${oldToken}` },
    })
    assert.equal(authenticatedManifest.status, 200)
    assert.match(authenticatedManifest.headers.get("cache-control")!, /^private,/)
    assert.equal(
      (
        await fetch(privateUrl, {
          headers: {
            authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
          },
        })
      ).status,
      401,
    )
    const duplicateStatus = await new Promise<number | undefined>((done, reject) => {
      const request = httpRequest(
        privateUrl,
        {
          headers: [
            "Host",
            new URL(privateUrl).host,
            "Authorization",
            `Bearer ${token}`,
            "Authorization",
            `Bearer ${token}`,
          ],
        },
        (response) => {
          response.resume()
          response.on("end", () => done(response.statusCode))
        },
      )
      request.on("error", reject)
      request.end()
    })
    assert.equal(duplicateStatus, 401)
    const registryPath = resolve(directory, "registry.json")
    await writeFile(registryPath, JSON.stringify({ fixture: { releaseId: "v1", manifestUrl: privateUrl } }))
    const credentials = new ServiceCredentials({ [remote.origin]: token })
    const host = await listen(
      createHost({
        registryPath,
        allowedOrigins: [remote.origin],
        serviceCredentials: credentials,
        bootstrapUrl: "/bootstrap.js",
        routes: {
          "/": [
            {
              name: "main",
              moduleId: "fixture",
              props: {},
              fallback: "<p>fallback</p>",
            },
          ],
        },
        onDiagnostic: (event) => events.push(event),
      }),
    )
    context.after(() => close(host.server))
    headers.length = 0
    cookies.length = 0
    const html = await (
      await fetch(host.origin, {
        headers: {
          authorization: "Bearer CLIENT_SECRET",
          cookie: "CLIENT_COOKIE=secret",
        },
      })
    ).text()
    assert.match(html, /authenticated SSR/)
    assert.equal(rendered, 1)
    assert.ok(headers.length >= 2 && headers.every((value) => value === `Bearer ${token}`))
    assert.ok(cookies.every((value) => value === undefined))
    assert.ok(!html.includes(token) && !JSON.stringify(events).includes(token))
    assert.doesNotMatch(html + JSON.stringify(events), /CLIENT_SECRET|CLIENT_COOKIE/)
    const fetcher = new FragmentFetcher([remote.origin, decoy.origin], {}, undefined, false, credentials)
    await assert.rejects(
      fetcher.json(`${remote.origin}/releases/redirect/manifest.json`, 1024, AbortSignal.timeout(1000)),
    )
    assert.equal(leaked, 0)
    await fetcher.json(`${decoy.origin}/releases/v1/manifest.json`, 1024, AbortSignal.timeout(1000))
    assert.deepEqual(decoyHeaders, [undefined])
    assert.equal(
      createHash("sha256")
        .update(await readFile(resolve(release.releaseDirectory, "integrity.json")))
        .digest("hex"),
      createHash("sha256").update(inventory).digest("hex"),
    )
  },
)

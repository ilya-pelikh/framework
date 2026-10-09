import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises"
import { resolve } from "node:path"
import { createServer } from "node:http"
import {
  artifactInventory,
  auditState,
  runNpm,
  securityReport,
  type CommandResult,
  type NpmRunner,
} from "../scripts/security.ts"

const cleanAudit = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
  },
}
const json = (value: unknown, code = 0): CommandResult => ({
  code,
  stdout: JSON.stringify(value),
})

test("audit gate rejects findings, unavailable output and inconsistent success reports", () => {
  assert.equal(auditState(json(cleanAudit)), "passed")
  assert.equal(
    auditState(
      json(
        {
          ...cleanAudit,
          vulnerabilities: { fixture: {} },
          metadata: {
            vulnerabilities: {
              ...cleanAudit.metadata.vulnerabilities,
              high: 1,
              total: 1,
            },
          },
        },
        1,
      ),
    ),
    "findings",
  )
  for (const result of [
    json({}),
    json(cleanAudit, 2),
    { code: null, stdout: "SECRET upstream failure" },
    json({ ...cleanAudit, vulnerabilities: { hidden: {} } }),
    json({
      ...cleanAudit,
      metadata: {
        vulnerabilities: { ...cleanAudit.metadata.vulnerabilities, low: 1 },
      },
    }),
  ]) {
    assert.equal(auditState(result), "unavailable")
  }
})

test(
  "versioned security fixture binds complete build/runtime SBOM, lockfile and artifact bytes",
  { timeout: 30000 },
  async () => {
    await mkdir(".cache", { recursive: true })
    const directory = await mkdtemp(resolve(".cache/security-fixture-"))
    for (const app of ["host", "catalog", "cart"]) {
      await mkdir(resolve(directory, `apps/${app}/dist`), { recursive: true })
      await writeFile(resolve(directory, `apps/${app}/dist/server.mjs`), "fixture")
      await writeFile(resolve(directory, `apps/${app}/dist/package.json`), "{}")
    }
    await mkdir(resolve(directory, "dist"))
    await writeFile(resolve(directory, "dist/start.mjs"), "fixture")
    const results = new Map<string, CommandResult>()
    const runner: NpmRunner = async (args, cwd) => {
      if (args[0] === "audit") return json(cleanAudit)
      const key = JSON.stringify(args)
      if (!results.has(key)) results.set(key, await runNpm(args, cwd))
      return results.get(key)!
    }
    const options = {
      root: process.cwd(),
      buildRoot: directory,
      outputRoot: resolve(directory, "reports"),
      run: runner,
    }
    const positive = await securityReport(options)
    assert.deepEqual(positive.report.failures, [])
    assert.equal(positive.report.status, "passed")
    assert.equal(positive.report.productionQualified, false)
    assert.equal(positive.report.schemaVersion, 1)
    const lock = await readFile("package-lock.json")
    assert.equal(positive.report.lockSha256, createHash("sha256").update(lock).digest("hex"))
    for (const [name, identity] of Object.entries(positive.report.reports)) {
      const bytes = await readFile(resolve(positive.directory, name))
      assert.equal(identity.sha256, createHash("sha256").update(bytes).digest("hex"))
      assert.equal(identity.bytes, bytes.length)
    }
    for (const mode of ["audit", "findings", "sbom", "policy"]) {
      const negative = await securityReport({
        ...options,
        run: async (args, cwd) => {
          if (mode === "audit" && args[0] === "audit") return { code: null, stdout: "SECRET credential/token" }
          if (mode === "findings" && args[0] === "audit")
            return json(
              {
                ...cleanAudit,
                vulnerabilities: { fixture: { severity: "low" } },
                metadata: {
                  vulnerabilities: {
                    ...cleanAudit.metadata.vulnerabilities,
                    low: 1,
                    total: 1,
                  },
                },
              },
              1,
            )
          if (mode === "policy" && args[0] === "install-scripts")
            return json({ allowScripts: [{ name: "unreviewed" }] })
          const result = await runner(args, cwd)
          if (mode === "sbom" && args[0] === "sbom" && args.includes("--include=dev")) {
            const bom = JSON.parse(result.stdout)
            bom.components = bom.components.filter((component: { name: string }) => component.name !== "tsx")
            return json(bom)
          }
          return result
        },
      })
      assert.equal(negative.report.status, "not-qualified", mode)
      assert.notEqual(negative.directory, positive.directory)
      assert.doesNotMatch(await readFile(resolve(negative.directory, "report.json"), "utf8"), /SECRET|credential/)
      assert.doesNotMatch(await readFile(resolve(negative.directory, "audit.json"), "utf8"), /SECRET|credential/)
    }
    const before = await artifactInventory(directory)
    await writeFile(resolve(directory, "dist/start.mjs"), "changed fixture")
    assert.notEqual((await artifactInventory(directory)).sha256, before.sha256)
    await assert.rejects(artifactInventory(resolve(directory, "missing")))
  },
)

test(
  "strict npm policy rejects an unreviewed tarball script and explicit denial never executes it",
  { timeout: 30000 },
  async (context) => {
    await mkdir(".cache", { recursive: true })
    const directory = await mkdtemp(resolve(".cache/install-policy-"))
    const dependency = resolve(directory, "dependency")
    await mkdir(dependency)
    await writeFile(
      resolve(dependency, "package.json"),
      JSON.stringify({
        name: "islands-script-fixture",
        version: "1.0.0",
        scripts: { postinstall: "node install.cjs" },
      }),
    )
    await writeFile(resolve(dependency, "install.cjs"), "require('node:fs').writeFileSync('EXECUTED', 'unexpected')")
    assert.equal((await runNpm(["pack", "--ignore-scripts", "--pack-destination", directory], dependency)).code, 0)
    const tarball = await readFile(resolve(directory, "islands-script-fixture-1.0.0.tgz"))
    const server = createServer((_request, response) => response.end(tarball))
    context.after(async () => {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const source = `http://127.0.0.1:${(server.address() as { port: number }).port}/islands-script-fixture/-/islands-script-fixture-1.0.0.tgz`
    const manifest = {
      name: "policy-fixture",
      version: "1.0.0",
      private: true,
      dependencies: { "islands-script-fixture": source },
      allowScripts: {},
    }
    await writeFile(resolve(directory, "package.json"), JSON.stringify(manifest))
    await writeFile(resolve(directory, ".npmrc"), "strict-allow-scripts=true\naudit=false\nfund=false\n")
    assert.equal(
      (
        await runNpm(
          ["install", "--package-lock-only", "--ignore-scripts", "--fetch-retries=0", "--fetch-timeout=3000"],
          directory,
        )
      ).code,
      0,
    )
    const rejected = await runNpm(["ci", "--offline", "--json"], directory)
    assert.notEqual(rejected.code, 0)
    assert.equal(JSON.parse(rejected.stdout).error.code, "ESTRICTALLOWSCRIPTS")
    const marker = resolve(directory, "node_modules/islands-script-fixture/EXECUTED")
    await assert.rejects(access(marker))
    await writeFile(
      resolve(directory, "package.json"),
      JSON.stringify({ ...manifest, allowScripts: { [source]: false } }),
    )
    const denied = await runNpm(["ci", "--offline", "--json"], directory)
    assert.equal(denied.code, 0, denied.stdout)
    await assert.rejects(access(marker))
  },
)

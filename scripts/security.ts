import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { release } from "node:os"

type RecordValue = Record<string, unknown>
export interface CommandResult {
  code: number | null
  stdout: string
}
export type NpmRunner = (args: string[], cwd: string) => Promise<CommandResult>
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const parse = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export const runNpm: NpmRunner = async (args, cwd) => {
  const cli =
    process.env.npm_execpath ??
    resolve(
      dirname(process.execPath),
      process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "../lib/node_modules/npm/bin/npm-cli.js",
    )
  return new Promise((done) => {
    execFile(
      process.execPath,
      [cli, ...args],
      {
        cwd,
        timeout: 45000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        done({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout,
        })
      },
    )
  })
}

export function auditState(result: CommandResult): "passed" | "findings" | "unavailable" {
  const value = parse(result.stdout)
  if (
    !record(value) ||
    value.auditReportVersion !== 2 ||
    !record(value.vulnerabilities) ||
    !record(value.metadata) ||
    !record(value.metadata.vulnerabilities)
  )
    return "unavailable"
  const counts = value.metadata.vulnerabilities
  const severities = ["info", "low", "moderate", "high", "critical"]
  if (
    ![...severities, "total"].every(
      (key) => typeof counts[key] === "number" && Number.isSafeInteger(counts[key]) && counts[key] >= 0,
    )
  )
    return "unavailable"
  if (severities.reduce((total, key) => total + (counts[key] as number), 0) !== counts.total) return "unavailable"
  if (result.code !== 0 && result.code !== 1) return "unavailable"
  if (Object.keys(value.vulnerabilities).length !== counts.total) return "unavailable"
  return counts.total === 0 && result.code === 0 ? "passed" : "findings"
}

function componentPairs(result: CommandResult): Set<string> | undefined {
  const value = parse(result.stdout)
  if (
    result.code !== 0 ||
    !record(value) ||
    value.bomFormat !== "CycloneDX" ||
    value.specVersion !== "1.5" ||
    !Array.isArray(value.components)
  )
    return
  const pairs = new Set<string>()
  for (const component of value.components) {
    if (!record(component) || typeof component.name !== "string" || typeof component.version !== "string") return
    pairs.add(`${component.name}@${component.version}`)
  }
  return pairs
}

export async function artifactInventory(root: string) {
  const files: { path: string; bytes: number; sha256: string }[] = []
  const walk = async (path: string): Promise<void> => {
    const absolute = resolve(root, path)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error("Artifact link")
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        if (path.endsWith("/dist") && [".staging", ".reservations", ".attestations"].includes(name)) continue
        await walk(`${path}/${name}`)
      }
    } else if (info.isFile()) {
      const bytes = await readFile(absolute)
      files.push({ path, bytes: bytes.length, sha256: digest(bytes) })
    } else throw new Error("Invalid artifact")
  }
  for (const path of ["dist", "apps/host/dist", "apps/catalog/dist", "apps/cart/dist"]) {
    let parent = path
    while (parent !== ".") {
      if ((await lstat(resolve(root, parent))).isSymbolicLink()) throw new Error("Artifact parent link")
      parent = dirname(parent)
    }
    await walk(path)
  }
  for (const path of [
    "dist/start.mjs",
    ...["host", "catalog", "cart"].flatMap((app) => [`apps/${app}/dist/server.mjs`, `apps/${app}/dist/package.json`]),
  ]) {
    if (!files.some((file) => file.path === path)) throw new Error("Missing build artifact")
  }
  return { files, sha256: digest(JSON.stringify(files)) }
}

export async function securityReport(options: {
  root: string
  buildRoot?: string
  outputRoot?: string
  run?: NpmRunner
}) {
  const root = resolve(options.root)
  const outputRoot = resolve(options.outputRoot ?? resolve(root, ".cache/security"))
  await mkdir(outputRoot, { recursive: true })
  const directory = resolve(outputRoot, `${Date.now()}-${randomUUID()}`)
  await mkdir(directory)
  const failures: string[] = []
  const reports: Record<string, { sha256: string; bytes: number }> = {}
  const save = async (name: string, value: unknown) => {
    const bytes = JSON.stringify(value, null, 2) + "\n"
    await writeFile(resolve(directory, name), bytes, { flag: "wx" })
    reports[name] = { sha256: digest(bytes), bytes: Buffer.byteLength(bytes) }
  }
  const command = async (args: string[]) => {
    try {
      return await (options.run ?? runNpm)(args, root)
    } catch {
      return { code: null, stdout: "" }
    }
  }
  let lockSha256: string | null = null
  let npmVersion: string | null = null
  try {
    const lockBytes = await readFile(resolve(root, "package-lock.json"))
    lockSha256 = digest(lockBytes)
    const lock = JSON.parse(lockBytes.toString("utf8"))
    const packageBytes = await readFile(resolve(root, "package.json"))
    const manifest = JSON.parse(packageBytes.toString("utf8"))
    const npmrc = await readFile(resolve(root, ".npmrc"), "utf8")
    const version = await command(["--version"])
    npmVersion = version.code === 0 ? version.stdout.trim() : null
    if (!npmVersion || (manifest.engines?.npm && npmVersion !== manifest.engines.npm)) failures.push("toolchain")
    if (
      !/^strict-allow-scripts=true\s*$/m.test(npmrc) ||
      !record(manifest.allowScripts) ||
      !Object.entries(manifest.allowScripts).every(
        ([name, allowed]) => allowed === false || (allowed === true && /@\d+\.\d+\.\d+$/.test(name)),
      )
    )
      failures.push("install-policy")
    const pending = await command(["install-scripts", "ls", "--json"])
    const policyResult = parse(pending.stdout)
    if (
      pending.code !== 0 ||
      !record(policyResult) ||
      !Array.isArray(policyResult.allowScripts) ||
      policyResult.allowScripts.length !== 0
    )
      failures.push("unreviewed-install-scripts")
    await save("install-policy.json", {
      schemaVersion: 1,
      packageSha256: digest(packageBytes),
      npmrcSha256: digest(npmrc),
      allowScripts: manifest.allowScripts,
      reviewed: !failures.includes("unreviewed-install-scripts") && !failures.includes("install-policy"),
    })
    const all = ["--package-lock-only", "--include=dev", "--include=optional", "--include=peer"]
    const audit = await command([
      "audit",
      "--json",
      "--audit-level=low",
      "--fetch-retries=0",
      "--fetch-timeout=15000",
      ...all,
    ])
    const state = auditState(audit)
    if (state !== "passed") failures.push(`audit-${state}`)
    await save("audit.json", state === "unavailable" ? { schemaVersion: 1, state } : parse(audit.stdout))
    const full = await command(["sbom", "--sbom-format=cyclonedx", ...all])
    const runtime = await command([
      "sbom",
      "--sbom-format=cyclonedx",
      "--package-lock-only",
      "--omit=dev",
      "--workspace=@islands/host",
      "--workspace=@islands/catalog",
      "--workspace=@islands/cart",
    ])
    const fullPairs = componentPairs(full)
    const runtimePairs = componentPairs(runtime)
    if (!fullPairs || !runtimePairs || !runtimePairs.size) failures.push("sbom-unavailable")
    const required = Object.entries(lock.packages).flatMap(([path, entry]) => {
      if (!path.includes("node_modules/") || !record(entry) || entry.link) return []
      return [`${path.slice(path.lastIndexOf("node_modules/") + 13)}@${entry.version}`]
    })
    if (!required.length || required.some((pair) => !fullPairs?.has(pair))) failures.push("sbom-incomplete-build")
    for (const name of ["express", "react", "react-dom", "parse5"]) {
      const version = lock.packages[`node_modules/${name}`]?.version
      if (!version || !runtimePairs?.has(`${name}@${version}`)) failures.push(`sbom-incomplete-runtime-${name}`)
    }
    if (runtimePairs && fullPairs && [...runtimePairs].some((pair) => !fullPairs.has(pair)))
      failures.push("sbom-runtime-mismatch")
    if (fullPairs) await save("build.cdx.json", parse(full.stdout))
    if (runtimePairs) await save("runtime.cdx.json", parse(runtime.stdout))
    if (digest(await readFile(resolve(root, "package-lock.json"))) !== lockSha256) failures.push("lockfile-changed")
    await save("artifacts.json", {
      schemaVersion: 1,
      ...(await artifactInventory(resolve(options.buildRoot ?? root))),
    })
  } catch {
    failures.push("input-or-artifact-unavailable")
  }
  const report = {
    schemaVersion: 1,
    kind: "dependency-security",
    createdAt: new Date().toISOString(),
    status: failures.length ? "not-qualified" : "passed",
    productionQualified: false,
    node: process.version,
    npm: npmVersion,
    platform: process.platform,
    osRelease: release(),
    arch: process.arch,
    commit: /^[a-f0-9]{40,64}$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : null,
    lockSha256,
    coverage: "full-lock-build-and-runtime-superset",
    failures,
    reports,
    advisoryPolicy: "Every finding blocks; no automatic waivers or dispositions.",
  }
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  return { directory, report }
}

import { isIP } from "node:net"

export interface DeploymentProfile {
  schemaVersion: 1
  purpose: "reference" | "target"
  environment: string
  owner: string
  hostOrigin: string
  registryPath: string
  principals: {
    runtime: string
    trustedPublishers: string[]
    registryWriters: string[]
  }
  storage: {
    releasesReadOnly: true
    registryReadOnly: true
    publisherExclusive: true
  }
  network: {
    moduleOrigins: string[]
    hostAddresses: string[]
    renderAccess: "private"
    serviceAuth: "bearer"
    upstreamBind: "loopback"
    tlsTermination: "reverse-proxy"
  }
  secrets: { hostTokensFile: string; moduleTokensFile: string }
}

export function parseDeploymentProfile(value: unknown): DeploymentProfile {
  const fail = () => {
    throw new Error("Invalid deployment profile")
  }
  const object = (input: unknown, keys: string[]): Record<string, unknown> => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(input, key))
    )
      return fail()
    return input as Record<string, unknown>
  }
  const text = (input: unknown) => {
    if (typeof input !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}$/.test(input)) return fail()
    return input
  }
  const list = (input: unknown, check: (item: unknown) => string) => {
    if (!Array.isArray(input) || !input.length || input.length > 64) return fail()
    const result = input.map(check)
    if (new Set(result).size !== result.length) return fail()
    return result
  }
  const origin = (input: unknown) => {
    if (typeof input !== "string") return fail()
    let parsed: URL
    try {
      parsed = new URL(input)
    } catch {
      return fail()
    }
    if (parsed.protocol !== "https:" || parsed.origin !== input) return fail()
    return input
  }
  const path = (input: unknown) => {
    if (
      typeof input !== "string" ||
      input.length > 512 ||
      !/^(\/|[a-zA-Z]:[\\/])/.test(input) ||
      /[\r\n\0]/.test(input) ||
      input.split(/[\\/]/).includes("..")
    )
      return fail()
    return input
  }
  const profile = object(value, [
    "schemaVersion",
    "purpose",
    "environment",
    "owner",
    "hostOrigin",
    "registryPath",
    "principals",
    "storage",
    "network",
    "secrets",
  ])
  if (profile.schemaVersion !== 1 || !["reference", "target"].includes(profile.purpose as string)) return fail()
  const principals = object(profile.principals, ["runtime", "trustedPublishers", "registryWriters"])
  const runtime = text(principals.runtime)
  const trustedPublishers = list(principals.trustedPublishers, text)
  const registryWriters = list(principals.registryWriters, text)
  if ([...trustedPublishers, ...registryWriters].includes(runtime)) return fail()
  const storage = object(profile.storage, ["releasesReadOnly", "registryReadOnly", "publisherExclusive"])
  if (Object.values(storage).some((item) => item !== true)) return fail()
  const network = object(profile.network, [
    "moduleOrigins",
    "hostAddresses",
    "renderAccess",
    "serviceAuth",
    "upstreamBind",
    "tlsTermination",
  ])
  if (
    network.renderAccess !== "private" ||
    network.serviceAuth !== "bearer" ||
    network.upstreamBind !== "loopback" ||
    network.tlsTermination !== "reverse-proxy"
  )
    return fail()
  const secrets = object(profile.secrets, ["hostTokensFile", "moduleTokensFile"])
  const result: DeploymentProfile = {
    schemaVersion: 1,
    purpose: profile.purpose as DeploymentProfile["purpose"],
    environment: text(profile.environment),
    owner: text(profile.owner),
    hostOrigin: origin(profile.hostOrigin),
    registryPath: path(profile.registryPath),
    principals: { runtime, trustedPublishers, registryWriters },
    storage: {
      releasesReadOnly: true,
      registryReadOnly: true,
      publisherExclusive: true,
    },
    network: {
      moduleOrigins: list(network.moduleOrigins, origin),
      hostAddresses: list(network.hostAddresses, (input) => {
        if (typeof input !== "string" || !isIP(input) || ["0.0.0.0", "::"].includes(input)) return fail()
        return input
      }),
      renderAccess: "private",
      serviceAuth: "bearer",
      upstreamBind: "loopback",
      tlsTermination: "reverse-proxy",
    },
    secrets: {
      hostTokensFile: path(secrets.hostTokensFile),
      moduleTokensFile: path(secrets.moduleTokensFile),
    },
  }
  if (result.network.moduleOrigins.includes(result.hostOrigin)) return fail()
  return result
}

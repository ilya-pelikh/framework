export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Policy = "load" | "visible" | "idle" | "never"
export interface Registry {
  [moduleId: string]: { releaseId: string; manifestUrl: string }
}
export interface Manifest {
  protocolVersion: 1
  moduleId: string
  releaseId: string
  renderUrl: string
  reactVersion: string
  islands: Record<string, { clientEntryUrl: string; cssUrls: string[] }>
}
export interface RenderRequest {
  protocolVersion: 1
  moduleId: string
  releaseId: string
  instanceId: string
  props: Json
  context: Record<string, Json>
}
export interface IslandDescriptor {
  id: string
  islandKey: string
  props: Json
  policy: Policy
  identifierPrefix: string
}
export interface RenderResponse {
  protocolVersion: 1
  moduleId: string
  releaseId: string
  html: string
  islands: IslandDescriptor[]
}
export interface BrowserIsland extends IslandDescriptor {
  moduleId: string
  releaseId: string
  clientEntryUrl: string
}

export function assertJson(value: unknown, parents = new Set<object>()): asserts value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value !== "object" || parents.has(value)) throw new Error("Expected acyclic JSON value")
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Expected plain JSON object")
  if (Object.getOwnPropertySymbols(value).length) throw new Error("JSON cannot contain symbol keys")
  parents.add(value)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("Expected standard JSON array")
    const descriptors = Object.getOwnPropertyDescriptors(value as object)
    const length = descriptors.length!.value as number
    if (Object.keys(descriptors).length !== length + 1)
      throw new Error("Expected dense JSON array without extra properties")
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new Error("Expected JSON array data property")
      assertJson(descriptor.value, parents)
    }
  } else {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor) || !descriptor.enumerable) throw new Error("Expected JSON data property")
      assertJson(descriptor.value, parents)
    }
  }
  parents.delete(value)
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object")
  return value as Record<string, unknown>
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error("Invalid ID")
  return value
}
export function url(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid URL")
  const parsed = new URL(value)
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
    throw new Error("Invalid HTTP URL")
  return value
}
function identity(value: Record<string, unknown>) {
  if (value.protocolVersion !== 1) throw new Error("Unsupported protocol version")
  id(value.moduleId)
  id(value.releaseId)
}
export function parseRegistry(value: unknown): Registry {
  assertJson(value)
  const registry = object(value)
  for (const [key, item] of Object.entries(registry)) {
    id(key)
    const entry = object(item)
    id(entry.releaseId)
    url(entry.manifestUrl)
  }
  return value as unknown as Registry
}
export function parseManifest(value: unknown): Manifest {
  assertJson(value)
  const manifest = object(value)
  identity(manifest)
  url(manifest.renderUrl)
  if (typeof manifest.reactVersion !== "string" || !manifest.reactVersion) throw new Error("Missing React version")
  const releasePath = `/releases/${manifest.releaseId}/`
  if (new URL(manifest.renderUrl as string).pathname !== `${releasePath}render`)
    throw new Error("Unversioned render URL")
  for (const [key, raw] of Object.entries(object(manifest.islands))) {
    id(key)
    const entry = object(raw)
    url(entry.clientEntryUrl)
    if (!Array.isArray(entry.cssUrls)) throw new Error("Invalid CSS list")
    for (const resource of [entry.clientEntryUrl, ...entry.cssUrls]) {
      if (!new URL(url(resource)).pathname.startsWith(`${releasePath}assets/`))
        throw new Error("Asset release mismatch")
    }
  }
  return value as unknown as Manifest
}
export function parseRenderRequest(value: unknown): RenderRequest {
  assertJson(value)
  const request = object(value)
  identity(request)
  id(request.instanceId)
  assertJson(request.props)
  object(request.context)
  return value as unknown as RenderRequest
}
export function parseRenderResponse(value: unknown): RenderResponse {
  assertJson(value)
  const response = object(value)
  identity(response)
  if (typeof response.html !== "string" || !Array.isArray(response.islands)) throw new Error("Invalid render response")
  const ids = new Set<string>()
  const prefixes = new Set<string>()
  for (const raw of response.islands) {
    const island = object(raw)
    const key = id(island.id)
    id(island.islandKey)
    id(island.identifierPrefix)
    assertJson(island.props)
    if (!["load", "visible", "idle", "never"].includes(island.policy as string)) throw new Error("Invalid policy")
    if (ids.has(key) || prefixes.has(island.identifierPrefix as string)) throw new Error("Duplicate island ID/prefix")
    ids.add(key)
    prefixes.add(island.identifierPrefix as string)
  }
  return value as unknown as RenderResponse
}
export function serializePayload(value: unknown): string {
  assertJson(value)
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}
export function escapeAttribute(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  )
}
export function parseBrowserIsland(value: unknown): BrowserIsland {
  assertJson(value)
  const island = object(value)
  id(island.moduleId)
  id(island.releaseId)
  parseRenderResponse({
    protocolVersion: 1,
    moduleId: island.moduleId,
    releaseId: island.releaseId,
    html: "",
    islands: [value],
  })
  if (island.identifierPrefix !== `${island.id}-` || (island.id as string).startsWith("islands-"))
    throw new Error("Invalid browser identity")
  if (!new URL(url(island.clientEntryUrl)).pathname.startsWith(`/releases/${island.releaseId}/assets/`))
    throw new Error("Browser asset release mismatch")
  return value as unknown as BrowserIsland
}

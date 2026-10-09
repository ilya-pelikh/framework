import { test } from "node:test"
import assert from "node:assert/strict"
import {
  assertJson,
  parseManifest,
  parseRegistry,
  parseRenderRequest,
  parseRenderResponse,
  serializePayload,
  escapeAttribute,
} from "../packages/contracts/src/index.ts"
const request = {
  protocolVersion: 1,
  moduleId: "demo",
  releaseId: "v1",
  instanceId: "request-slot",
  props: { title: "example" },
  context: {},
}
test("requests and registries reject invalid versions, IDs and non-JSON values", () => {
  assert.deepEqual(parseRenderRequest(request), request)
  for (const change of [
    { protocolVersion: 2 },
    { moduleId: "../x" },
    { instanceId: "" },
    { props: undefined },
    { context: [] },
  ])
    assert.throws(() => parseRenderRequest({ ...request, ...change }))
  assert.throws(() => parseRegistry({ demo: { releaseId: "v1", manifestUrl: "file:///secret" } }))
  const cyclic: any = {}
  cyclic.self = cyclic
  for (const value of [cyclic, undefined, () => {}, 1n, NaN, Infinity, new Date(), new Array(2), { a: undefined }])
    assert.throws(() => assertJson(value))
})
test("manifest and descriptors validate release paths, keys and unique IDs", () => {
  const manifest = {
    protocolVersion: 1,
    moduleId: "demo",
    releaseId: "v1",
    reactVersion: "19.3.0",
    renderUrl: "http://localhost/releases/v1/render",
    islands: {
      counter: {
        clientEntryUrl: "http://localhost/releases/v1/assets/counter.js",
        cssUrls: [],
      },
    },
  }
  assert.deepEqual(parseManifest(manifest), manifest)
  assert.throws(() =>
    parseManifest({
      ...manifest,
      islands: { "../bad": manifest.islands.counter },
    }),
  )
  assert.throws(() => parseManifest({ ...manifest, releaseId: "v2" }))
  const island = {
    id: "one",
    islandKey: "counter",
    props: {},
    policy: "load",
    identifierPrefix: "one-",
  }
  const response = { ...request, html: "<div></div>", islands: [island] }
  assert.equal(parseRenderResponse(response).islands.length, 1)
  assert.throws(() => parseRenderResponse({ ...response, islands: [island, island] }))
  assert.throws(() =>
    parseRenderResponse({
      ...response,
      islands: [{ ...island, policy: "unknown" }],
    }),
  )
})
test("payload serialization preserves script-like text and Unicode without raw markup", () => {
  const props = { text: '</script><script>alert("&")</script>\u2028\u2029' }
  const serialized = serializePayload(props)
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/)
  assert.deepEqual(JSON.parse(serialized), props)
  assert.equal(escapeAttribute("<\"'&>"), "&lt;&quot;&#39;&amp;&gt;")
})

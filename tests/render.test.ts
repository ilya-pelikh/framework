import { test } from "node:test"
import assert from "node:assert/strict"
import { createElement, useId } from "react"
import { defineFragment, defineIsland, validateFragment } from "../packages/server/src/render.ts"
const request = {
  protocolVersion: 1 as const,
  moduleId: "fixture",
  releaseId: "v1",
  instanceId: "request-slot",
  props: {},
  context: {},
}
const counter = defineIsland("counter", () => createElement("label", { id: useId() }, "counter"))
test("repeated islands have distinct useId, wrappers and descriptor prefixes", () => {
  const renderer = defineFragment((builder) => builder.island(counter, {}) + builder.island(counter, {}))
  const response = renderer(request)
  assert.equal(response.islands.length, 2)
  assert.notEqual(response.islands[0]!.identifierPrefix, response.islands[1]!.identifierPrefix)
  assert.match(response.html, /request-slot-0-/)
  assert.match(response.html, /request-slot-1-/)
  assert.throws(() => validateFragment({ ...response, html: "" }), /Missing/)
  assert.throws(() => validateFragment({ ...response, html: response.html + response.html }), /Duplicate/)
})
test("nested declarations and wrappers are rejected", () => {
  const nested = defineFragment((builder) => {
    const outer = defineIsland("outer", () =>
      createElement("div", {
        dangerouslySetInnerHTML: { __html: builder.island(counter, {}) },
      }),
    )
    return builder.island(outer, {})
  })
  assert.throws(() => nested(request), /Nested/)
  const renderer = defineFragment((builder) => builder.island(counter, {}))
  const response = renderer(request)
  assert.throws(
    () =>
      validateFragment({
        ...response,
        html: response.html.replace("</div>", '<div data-island="counter"></div></div>'),
      }),
    /Nested/,
  )
})

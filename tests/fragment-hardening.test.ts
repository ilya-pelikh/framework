import { test } from "node:test"
import assert from "node:assert/strict"
import { validateFragment } from "../packages/server/src/render.ts"
const island = {
  id: "slot-0",
  identifierPrefix: "slot-0-",
  islandKey: "counter",
  props: {},
  policy: "load" as const,
}
const wrapper = '<div id="slot-0" data-island="counter">content</div>'
const response = {
  protocolVersion: 1 as const,
  moduleId: "fixture",
  releaseId: "v1",
  html: wrapper,
  islands: [island],
}

test("fragments reject reserved IDs, attributes and composition markers", () => {
  for (const prefix of [
    '<p id="islands-payload">bad</p>',
    '<p data-islands-slot="one">bad</p>',
    "<!-- islands-slot:fake -->",
  ]) {
    assert.throws(() => validateFragment({ ...response, html: prefix + wrapper }), /Reserved/)
  }
  validateFragment(response)
})

test("inert, nested and missing live wrappers are rejected", () => {
  for (const html of [
    `<template>${wrapper}</template>`,
    `<div inert>${wrapper}</div>`,
    `<noscript>${wrapper}</noscript>`,
  ]) {
    assert.throws(() => validateFragment({ ...response, html }), /Inert|Missing/)
  }
  assert.throws(
    () =>
      validateFragment({
        ...response,
        html: wrapper.replace("content", wrapper),
      }),
    /Duplicate|Nested/,
  )
})

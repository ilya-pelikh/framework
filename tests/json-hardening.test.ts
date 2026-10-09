import { test } from "node:test"
import assert from "node:assert/strict"
import { assertJson, serializePayload } from "../packages/contracts/src/index.ts"

test("JSON arrays reject accessors and serialization hooks without executing them", () => {
  let calls = 0
  const accessor = [1]
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get: () => {
      calls++
      return 1
    },
  })
  const serializer = [1]
  Object.defineProperty(serializer, "toJSON", {
    value: () => {
      calls++
      return {}
    },
  })
  const setter = [1]
  Object.defineProperty(setter, "0", {
    enumerable: true,
    set: () => {
      calls++
    },
  })
  for (const value of [accessor, serializer, setter]) {
    assert.throws(() => assertJson(value))
    assert.throws(() => serializePayload(value))
  }
  assert.equal(calls, 0)
})

test("JSON arrays reject extra properties, symbols, custom prototypes and holes", () => {
  const hidden = [1]
  Object.defineProperty(hidden, "extra", { value: 1 })
  const indexedHidden = [1]
  Object.defineProperty(indexedHidden, "0", { enumerable: false })
  const symbol = [1]
  Object.defineProperty(symbol, Symbol("extra"), { value: 1 })
  const custom = [1]
  Object.setPrototypeOf(custom, Object.create(Array.prototype))
  const replacedIndex = new Array(1)
  Object.assign(replacedIndex, { other: 1 })
  for (const value of [
    hidden,
    indexedHidden,
    symbol,
    custom,
    replacedIndex,
    new Array(1),
    Object.assign([1], { extra: 1 }),
  ]) {
    assert.throws(() => assertJson(value))
  }
})

test("standard arrays and shared acyclic values preserve nested JSON exactly", () => {
  const shared = { text: "</script>\u2028\u2029", count: 2 }
  const input = Object.freeze([null, false, 1, "", [], { items: [shared, shared] }])
  assertJson(input)
  assert.deepEqual(JSON.parse(serializePayload(input)), input)
})

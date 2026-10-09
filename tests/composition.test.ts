import { test } from "node:test"
import assert from "node:assert/strict"
import { composeSlots, type CompositionSlot } from "../packages/server/src/compose.ts"

function slot(name: string, html: string, fallback = "<p>unavailable</p>"): CompositionSlot {
  return { name, html, fallback, islands: [] }
}
test("document collisions prefer shell then configured slot order, not DOM order", () => {
  const slots = [slot("first", '<p id="same">first</p>'), slot("second", '<p id="same">second</p>')]
  const output = composeSlots(slots, (values) => `${values.second}${values.first}`)
  assert.deepEqual([...output.rejected], [1])
  assert.match(output.body, />first</)
  assert.doesNotMatch(output.body, />second</)
  const shell = composeSlots(slots, (values) => `${values.first}${values.second}<footer id="same">shell</footer>`)
  assert.deepEqual([...shell.rejected].sort(), [0, 1])
})

test("reserved IDs cause local fallback and shell executes only once", () => {
  let calls = 0
  const output = composeSlots(
    [slot("bad", '<p id="islands-payload">bad</p>'), slot("good", "<p>good</p>")],
    (values) => {
      calls++
      return `${values.bad}${values.good}`
    },
  )
  assert.equal(calls, 1)
  assert.deepEqual([...output.rejected], [0])
  assert.match(output.body, />good</)
})

test("invalid shell boundaries and invalid fallback terminate safely", () => {
  const slots = [slot("one", "<p>one</p>")]
  assert.throws(() => composeSlots(slots, () => ""), /exactly once/)
  assert.throws(() => composeSlots(slots, (values) => values.one! + values.one!), /exactly once/)
  assert.throws(() => composeSlots(slots, (values) => `${values.one}<p id="same"></p><p id="same"></p>`), /shell/)
  assert.throws(() => composeSlots([slot("one", '<p id="islands-bad"></p>', '<p id="islands-bad"></p>')]), /Reserved/)
})

test("parser repair cannot move fragment markup across slot boundaries", () => {
  const output = composeSlots([slot("one", "<div>unclosed")])
  assert.deepEqual([...output.rejected], [0])
  assert.match(output.body, /unavailable/)
  assert.throws(() => composeSlots([slot("one", "<div>unclosed", "<div>unclosed")]), /shell or fallback/)
  const repaired = composeSlots(
    [slot("one", "<div>fostered</div>", "<tbody><tr><td>fallback</td></tr></tbody>")],
    (values) => `<table>${values.one}</table>`,
  )
  assert.deepEqual([...repaired.rejected], [0])
})

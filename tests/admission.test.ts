import { test } from "node:test"
import assert from "node:assert/strict"
import { AdmissionController, createHost } from "@islands/server"

test("admission bounds global/per-module/body work and leaves quota for a neighbor", async () => {
  const pool = new AdmissionController({
    maxActive: 3,
    maxPerModule: 1,
    maxResponseBytes: 20,
  })
  const signal = new AbortController().signal
  const first = await pool.acquire("busy", 10, signal)
  await assert.rejects(pool.acquire("busy", 1, signal), {
    category: "overload",
  })
  const neighbor = await pool.acquire("neighbor", 10, signal)
  await assert.rejects(pool.acquire("other", 1, signal), {
    category: "overload",
  })
  assert.deepEqual(pool.snapshot(), {
    active: 2,
    queued: 0,
    reservedBytes: 20,
    modules: 2,
  })
  first()
  first()
  neighbor()
  assert.deepEqual(pool.snapshot(), {
    active: 0,
    queued: 0,
    reservedBytes: 0,
    modules: 0,
  })
  const global = new AdmissionController({ maxActive: 1 })
  const release = await global.acquire("one", 1, signal)
  await assert.rejects(global.acquire("two", 1, signal), {
    category: "overload",
  })
  release()
})

test("bounded queue releases cancellation and admits eligible neighbors without head-of-line blocking", async () => {
  const pool = new AdmissionController({
    maxActive: 2,
    maxPerModule: 1,
    maxQueue: 2,
  })
  const signal = new AbortController().signal
  const first = await pool.acquire("busy", 1, signal)
  const second = await pool.acquire("neighbor", 1, signal)
  const cancel = new AbortController()
  const canceled = assert.rejects(pool.acquire("busy", 1, cancel.signal))
  const next = pool.acquire("other", 1, signal)
  await assert.rejects(pool.acquire("third", 1, signal), {
    category: "overload",
  })
  second()
  const release = await next
  assert.deepEqual(pool.snapshot(), {
    active: 2,
    queued: 1,
    reservedBytes: 2,
    modules: 2,
  })
  cancel.abort()
  await canceled
  first()
  release()
  assert.equal(pool.snapshot().queued, 0)
  assert.equal(pool.snapshot().active, 0)
})

test("admission configuration and excessive static routes fail before any upstream work", () => {
  for (const value of [0, -1, Infinity, NaN, 0.5]) assert.throws(() => new AdmissionController({ maxActive: value }))
  for (const value of [-1, Infinity, NaN, 0.5]) assert.throws(() => new AdmissionController({ maxQueue: value }))
  assert.throws(
    () =>
      createHost({
        registryPath: "unused",
        allowedOrigins: [],
        bootstrapUrl: "/bootstrap.js",
        admission: new AdmissionController({ maxSlots: 1 }),
        routes: {
          "/": [1, 2].map((index) => ({
            name: String(index),
            moduleId: "fixture",
            props: {},
            fallback: "<p>fallback</p>",
          })),
        },
      }),
    /slot limit/,
  )
})

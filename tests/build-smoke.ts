import { test } from "node:test"
import { buildRelease } from "../packages/rsbuild/src/index.ts"
test("independent release build", { timeout: 120000 }, async (testContext) => {
  await buildRelease({
    root: process.cwd(),
    moduleId: "fixture",
    releaseId: process.env.RELEASE_ID ?? "fixture-v1",
    publicOrigin: "http://localhost:4311",
    outDir: ".cache/build-smoke",
    serverEntry: "tests/fixtures/module/server.tsx",
    islands: {
      counter: "tests/fixtures/module/counter.tsx",
      repeat: "tests/fixtures/module/counter.tsx",
    },
  })
})

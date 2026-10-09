import { buildRelease } from "../packages/rsbuild/src/index.ts"
await buildRelease(JSON.parse(process.argv[2]!))

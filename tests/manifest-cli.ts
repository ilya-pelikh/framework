import { generateReleaseManifest } from "../packages/rsbuild/src/index.ts"
await generateReleaseManifest(JSON.parse(process.argv[2]!))

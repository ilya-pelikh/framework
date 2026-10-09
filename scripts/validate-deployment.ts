import { readFile } from "node:fs/promises"
import { parseDeploymentProfile } from "../packages/server/src/deployment.ts"

try {
  if (!process.argv[2] || process.argv.length !== 3) throw new Error()
  const profile = parseDeploymentProfile(JSON.parse(await readFile(process.argv[2], "utf8")))
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      valid: true,
      purpose: profile.purpose,
      productionQualified: false,
    }),
  )
} catch {
  console.error(
    JSON.stringify({
      schemaVersion: 1,
      valid: false,
      productionQualified: false,
      error: "Invalid deployment profile",
    }),
  )
  process.exitCode = 1
}

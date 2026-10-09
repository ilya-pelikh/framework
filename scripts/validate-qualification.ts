import { readFile } from "node:fs/promises"
import { validateQualificationProfile } from "./qualification.ts"

try {
  if (!process.argv[2] || process.argv.length !== 3) throw new Error()
  const bytes = await readFile(process.argv[2])
  if (bytes.length > 1048576) throw new Error()
  const result = validateQualificationProfile(JSON.parse(bytes.toString("utf8")))
  console.log(JSON.stringify({ schemaVersion: 1, ...result }))
  if (!result.valid) process.exitCode = 1
} catch {
  console.error(
    JSON.stringify({
      schemaVersion: 1,
      valid: false,
      status: "not-qualified",
      productionQualified: false,
      errors: ["profile unreadable or invalid JSON"],
    }),
  )
  process.exitCode = 1
}

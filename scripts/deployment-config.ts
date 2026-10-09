import { readFile } from "node:fs/promises"
import { parseDeploymentProfile } from "../packages/server/src/deployment.ts"

export async function deploymentConfig() {
  if (!process.env.DEPLOYMENT_PROFILE) return
  try {
    const profile = parseDeploymentProfile(JSON.parse(await readFile(process.env.DEPLOYMENT_PROFILE, "utf8")))
    if (profile.purpose !== "target") throw new Error()
    return profile
  } catch {
    throw new Error("Target deployment profile required")
  }
}

export async function readSecretJson(path: string): Promise<unknown> {
  try {
    const bytes = await readFile(path)
    if (bytes.length > 32768) throw new Error()
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("Service secret unavailable")
  }
}

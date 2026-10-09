import { createHash, timingSafeEqual } from "node:crypto"
import type { RequestHandler } from "express"

function tokenDigest(token: string) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(token))
    throw new Error("Invalid service token configuration")
  return createHash("sha256").update(token).digest()
}

export class ServiceCredentials {
  #tokens = new Map<string, string>()
  constructor(tokens: Record<string, string>) {
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens) || !Object.keys(tokens).length)
      throw new Error("Invalid service credentials")
    for (const [origin, token] of Object.entries(tokens)) {
      const parsed = new URL(origin)
      if (
        parsed.origin !== origin ||
        (parsed.protocol !== "https:" &&
          !(parsed.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)))
      )
        throw new Error("Service credentials require HTTPS")
      tokenDigest(token)
      this.#tokens.set(origin, token)
    }
  }
  headers(address: string): Record<string, string> {
    const parsed = new URL(address)
    if (parsed.username || parsed.password) return {}
    const token = this.#tokens.get(parsed.origin)
    return token && /^\/releases\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/(manifest\.json|render)$/.test(parsed.pathname)
      ? { authorization: `Bearer ${token}` }
      : {}
  }
}

export function serviceBoundary(tokens: readonly string[]): RequestHandler {
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 2)
    throw new Error("One or two service tokens required")
  const digests = tokens.map(tokenDigest)
  return (req, res, next) => {
    const path = req.path
    const publicAsset =
      /^\/releases\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/assets\/[a-zA-Z0-9_./-]+$/.test(path) &&
      !path.split("/").some((part) => part === "." || part === "..")
    if (publicAsset && ["GET", "HEAD"].includes(req.method)) {
      next()
      return
    }
    const count = req.rawHeaders.filter(
      (_value, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === "authorization",
    ).length
    const value = req.get("authorization")
    let valid = false
    if (count === 1 && value && /^Bearer [A-Za-z0-9_-]{43,128}$/.test(value)) {
      const supplied = createHash("sha256").update(value.slice(7)).digest()
      for (const expected of digests) valid = timingSafeEqual(supplied, expected) || valid
    }
    if (!valid) {
      res.setHeader("Cache-Control", "no-store")
      res.status(401).json({ error: "Unauthorized service request" })
      return
    }
    res.setHeader("Cache-Control", "no-store")
    next()
  }
}

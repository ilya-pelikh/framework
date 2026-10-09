import type { RequestHandler } from "express"

export function productionHeaders(moduleOrigins: readonly string[] = []): RequestHandler {
  if (!Array.isArray(moduleOrigins) || moduleOrigins.length > 64) throw new Error("Invalid security origins")
  const origins = moduleOrigins.map((origin) => {
    if (typeof origin !== "string" || origin.length > 2048 || !/^https:\/\/[a-zA-Z0-9.[\]:-]+$/.test(origin))
      throw new Error("Invalid security origin")
    const parsed = new URL(origin)
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password)
      throw new Error("Invalid security origin")
    return origin
  })
  const sources = ["'self'", ...new Set(origins)].join(" ")
  const policy = [
    "default-src 'none'",
    ...["script-src", "style-src", "img-src", "font-src", "connect-src"].map((directive) => `${directive} ${sources}`),
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ")
  return (_req, res, next) => {
    res.removeHeader("X-Powered-By")
    res.setHeader("Content-Security-Policy", policy)
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Referrer-Policy", "no-referrer")
    res.setHeader("Strict-Transport-Security", "max-age=31536000")
    next()
  }
}

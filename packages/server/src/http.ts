import { createServer, type RequestListener } from "node:http"

export interface HttpLimits {
  requestTimeoutMs?: number
  headersTimeoutMs?: number
  socketTimeoutMs?: number
  keepAliveTimeoutMs?: number
  maxHeaderBytes?: number
  maxRequestsPerSocket?: number
  shutdownGraceMs?: number
  onDrain?: () => void
}

export function createHttpServer(listener: RequestListener, limits: HttpLimits = {}) {
  const requestTimeout = limits.requestTimeoutMs ?? 15000
  const headersTimeout = limits.headersTimeoutMs ?? 5000
  const socketTimeout = limits.socketTimeoutMs ?? 10000
  const keepAliveTimeout = limits.keepAliveTimeoutMs ?? 5000
  const maxHeaderSize = limits.maxHeaderBytes ?? 16384
  const maxRequestsPerSocket = limits.maxRequestsPerSocket ?? 1000
  const grace = limits.shutdownGraceMs ?? 10000
  for (const value of [
    requestTimeout,
    headersTimeout,
    socketTimeout,
    keepAliveTimeout,
    maxHeaderSize,
    maxRequestsPerSocket,
    grace,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid HTTP limit")
  }
  if (headersTimeout > requestTimeout) throw new Error("Header deadline exceeds request deadline")
  let draining = false
  const server = createServer(
    {
      requestTimeout,
      headersTimeout,
      keepAliveTimeout,
      maxHeaderSize,
      connectionsCheckingInterval: Math.min(1000, headersTimeout),
    },
    (req, res) => {
      if (draining) {
        res.writeHead(503, { Connection: "close" })
        res.end()
        return
      }
      listener(req, res)
    },
  )
  server.maxRequestsPerSocket = maxRequestsPerSocket
  server.setTimeout(socketTimeout, (socket) => socket.destroy())
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ??= new Promise<void>((done, reject) => {
      draining = true
      let drainFailed = false
      try {
        limits.onDrain?.()
      } catch {
        drainFailed = true
      }
      const timer = setTimeout(() => server.closeAllConnections(), grace)
      server.close(() => {
        clearTimeout(timer)
        if (drainFailed) reject(new Error("Drain hook failed"))
        else done()
      })
      server.closeIdleConnections()
    }))
  return { server, stop }
}

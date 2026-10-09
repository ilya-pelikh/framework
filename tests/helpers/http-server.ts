import type express from "express"
import type { Server } from "node:http"

export async function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0)
  await new Promise<void>((done, reject) => {
    server.once("listening", done)
    server.once("error", reject)
  })
  return {
    server,
    origin: `http://localhost:${(server.address() as { port: number }).port}`,
  }
}

export async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
}

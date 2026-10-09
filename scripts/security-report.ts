import { securityReport } from "./security.ts"

try {
  const { directory, report } = await securityReport({
    root: process.cwd(),
    ...(process.env.ISLANDS_BUILD_ROOT ? { buildRoot: process.env.ISLANDS_BUILD_ROOT } : {}),
  })
  console.log(
    JSON.stringify({
      directory,
      status: report.status,
      failures: report.failures,
    }),
  )
  if (report.status !== "passed") process.exitCode = 1
} catch {
  console.error("Security report unavailable")
  process.exitCode = 1
}

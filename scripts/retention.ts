export interface RetentionPolicy {
  pageLifetimeMs: number
  rollbackWindowMs: number
  retentionMs: number
  propagationMs: number
  clockSkewMs: number
}

export interface RetirementState {
  selected: boolean
  rollbackPinned: boolean
  lastDeselectedAt: number | null
}

export function retirementEligibility(
  policy: RetentionPolicy,
  state: RetirementState,
  now: number,
):
  | {
      eligible: false
      reason: "unknown" | "selected" | "rollback-pinned" | "retained"
    }
  | { eligible: true; eligibleAfter: number } {
  const hold = (reason: "unknown" | "selected" | "rollback-pinned" | "retained") => ({
    eligible: false as const,
    reason,
  })
  if (!policy || !state || !Number.isSafeInteger(now) || now < 0) return hold("unknown")
  if (state.selected === true) return hold("selected")
  if (state.rollbackPinned === true) return hold("rollback-pinned")
  if (state.selected !== false || state.rollbackPinned !== false) return hold("unknown")
  for (const value of [policy.pageLifetimeMs, policy.rollbackWindowMs, policy.retentionMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) return hold("unknown")
  }
  for (const value of [policy.propagationMs, policy.clockSkewMs]) {
    if (!Number.isSafeInteger(value) || value < 0) return hold("unknown")
  }
  const minimum = Math.max(policy.pageLifetimeMs, policy.rollbackWindowMs) + policy.propagationMs + policy.clockSkewMs
  if (!Number.isSafeInteger(minimum) || policy.retentionMs < minimum) return hold("unknown")
  if (
    !Number.isSafeInteger(state.lastDeselectedAt) ||
    state.lastDeselectedAt === null ||
    state.lastDeselectedAt < 0 ||
    state.lastDeselectedAt > now
  )
    return hold("unknown")
  const eligibleAfter = state.lastDeselectedAt + policy.retentionMs
  if (!Number.isSafeInteger(eligibleAfter)) return hold("unknown")
  return now > eligibleAfter ? { eligible: true, eligibleAfter } : hold("retained")
}

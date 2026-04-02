/**
 * Lockdown Gate — alive-runtime
 * src/enforcement/lockdown-gate.ts
 *
 * Per-action lockdown enforcement and mode query helpers.
 * Used by pipeline.ts, reflex-router.ts, and any other execution path
 * that needs to know whether execution is permitted.
 *
 * For the full authorization check (hash, expiry, single-use), use
 * global-gate.ts → checkAndConsumeGate(). This file is mode-query only.
 *
 * In LOCKDOWN:
 *   - checkLockdownGate()         → blocks or requires approval
 *   - isReflexPathPermitted()     → false
 *   - isAutoExecutionPermitted()  → false
 *   - areBackgroundLoopsPermitted() → false
 */

import type { Action }              from '../../../alive-constitution/contracts/action';
import type { ActionAuthorization } from '../../../alive-constitution/contracts/authorized-action';
import {
  hasValidAuthorization,
  createBlockedResult,
  createAuthorizedResult,
  type AuthorizationResult,
} from '../../../alive-constitution/contracts/authorized-action';
import {
  isLockdown,
  recordBlockedAction,
  getRuntimeModeState,
} from '../modes/lockdown';

// ─── Gate Result ─────────────────────────────────────────────────────────────

export interface GateResult {
  readonly permitted: boolean;
  readonly action?: Action;
  readonly reason: string;
  readonly authorization?: ActionAuthorization;
}

// ─── Lockdown Gate ───────────────────────────────────────────────────────────

/**
 * Check whether an action is permitted to proceed based on system mode.
 *
 * NORMAL: always permitted (shape check only).
 * LOCKDOWN: requires valid ActionAuthorization (approved_by='runtime').
 *
 * Note: this is the mode-level check. For full token validation
 * (expiry, hash, single-use), use global-gate.ts → checkAndConsumeGate().
 */
export function checkLockdownGate(
  action:        Action,
  authorization: ActionAuthorization | undefined,
): GateResult {
  if (!isLockdown()) {
    return { permitted: true, action, reason: 'NORMAL mode: action permitted' };
  }

  if (hasValidAuthorization(authorization)) {
    return {
      permitted:     true,
      action,
      reason:        'LOCKDOWN: action authorized by runtime',
      authorization,
    };
  }

  const actionType = action.type;
  recordBlockedAction(actionType, 'LOCKDOWN: no valid authorization');
  return {
    permitted: false,
    reason:    `LOCKDOWN: action "${actionType}" blocked — valid runtime authorization required`,
  };
}

// ─── Mode query helpers ──────────────────────────────────────────────────────

/** True when the reflex bypass path is permitted to fire. */
export function isReflexPathPermitted(): boolean {
  return !isLockdown();
}

/** True when auto-execution is permitted. False in LOCKDOWN. */
export function isAutoExecutionPermitted(): boolean {
  return !isLockdown();
}

/** True when background/autonomous loops may run. False in LOCKDOWN. */
export function areBackgroundLoopsPermitted(): boolean {
  return !isLockdown();
}

/** Trace info for logging — reads current lockdown state without require(). */
export function getLockdownTraceInfo(): { enabled: boolean; blockedCount: number } {
  if (!isLockdown()) {
    return { enabled: false, blockedCount: 0 };
  }
  const state = getRuntimeModeState();
  return {
    enabled:      true,
    blockedCount: state.blockedActionsCount,
  };
}

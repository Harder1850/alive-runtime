/**
 * Body Bridge — alive-runtime
 * src/wiring/body-bridge.ts
 *
 * The ONLY way the runtime calls into alive-body for action execution.
 *
 * callBodyGated() replaces the former callBody() which called executeAction()
 * directly with no token — a complete authorization bypass.
 *
 * callBodyGated() enforces the full gate path on every call:
 *   1. Issues a single-use ActionAuthorization tied to the action hash + signal
 *   2. Passes action + token through checkAndConsumeGate() (lockdown, expiry,
 *      hash, single-use checks all enforced)
 *   3. Forwards the consumed authorization to executeAction() for
 *      defense-in-depth hash re-verification inside the executor
 *   4. On any gate failure: reports via onAuthorizationFailure() which feeds
 *      the auto-lockdown trigger, then returns an un-executed result
 *
 * There is no unauthenticated execution path through this file.
 */

import type { Action }             from '../../../alive-constitution/contracts/action';
import type { ExecutorResult }     from '../../../alive-body/src/actuators/executor';
import { executeAction }           from '../../../alive-body/src/actuators/executor';
import { issueActionAuthorization, checkAndConsumeGate } from '../enforcement/global-gate';
import { onAuthorizationFailure }  from '../enforcement/lockdown-triggers';

/**
 * Execute an action through the full enforcement gate.
 *
 * This is the required entry point for all runtime → body execution.
 * It may NOT be called without a signalId — the signal chain must be traceable.
 *
 * @param action    The action to execute.
 * @param signalId  The signal ID that triggered this execution cycle.
 *                  Used to tie the authorization token to the signal.
 * @param auditRef  Optional reference from the executive (constitution_ref).
 *                  Included in the token's audit trail.
 */
export function callBodyGated(
  action:    Action,
  signalId:  string,
  auditRef?: string,
): ExecutorResult {
  // ── Step 1: Issue a single-use authorization token ────────────────────────
  const auth = issueActionAuthorization(action, signalId, auditRef);

  // ── Step 2: Gate check — lockdown, expiry, hash, single-use ──────────────
  const gateResult = checkAndConsumeGate(action, auth);

  if (!gateResult.permitted) {
    // Gate blocked the action. Report to the auth-failure monitor so that
    // repeated failures can trigger automatic lockdown.
    onAuthorizationFailure(
      `callBodyGated blocked: ${gateResult.blocked_reason ?? 'unknown'} — ${gateResult.reason}`,
    );
    console.error(
      `[BODY-BRIDGE] BLOCKED action="${action.type}" reason="${gateResult.reason}"`,
    );
    return {
      executed:  false,
      result:    `GATE BLOCKED: ${gateResult.reason}`,
    };
  }

  // ── Step 3: Execute with the consumed authorization (defense-in-depth) ────
  return executeAction(action, gateResult.authorization!);
}

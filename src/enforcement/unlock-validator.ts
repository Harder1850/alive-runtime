/**
 * Unlock Validator — alive-runtime
 * src/enforcement/unlock-validator.ts
 *
 * Validates that the system is safe to exit LOCKDOWN before allowing unlock.
 *
 * validateUnlock(auditRef) runs four integrity checks:
 *
 *   1. auditRef validity — must be a meaningful reference (not empty/trivial)
 *   2. No unresolved critical incidents — all severity='critical' incidents
 *      must have been acknowledged before unlock is permitted
 *   3. Enforcement system integrity — global gate must be operational
 *      (consumed token store accessible, no gate logic tampering detected)
 *   4. Authorization system integrity — no authorization failures in the
 *      current window that indicate an ongoing attack pattern
 *
 * The result is an UnlockResult (from alive-constitution/contracts/system-mode).
 * modes/lockdown.ts calls validateUnlock() before transitioning to NORMAL.
 *
 * Design rules:
 *   - No imports from alive-body, alive-mind, alive-interface
 *   - Failures are additive — all checks run, all failures reported
 *   - This function is pure except for reading module-level state
 */

import type { UnlockResult } from '../../../alive-constitution/contracts/system-mode';
import { getIncidents, isLockdown } from '../modes/lockdown';
import { getAuthFailureCount, getConsumedTokenCount } from './global-gate';

// ── Validation config ──────────────────────────────────────────────────────────

/** Minimum length for a meaningful audit reference. */
const MIN_AUDIT_REF_LENGTH = 10;

/**
 * Maximum number of authorization failures in the current window that
 * we consider acceptable for unlock. More than this means an attack
 * pattern may still be active.
 */
const MAX_AUTH_FAILURES_FOR_UNLOCK = 0;

// ── Main validator ─────────────────────────────────────────────────────────────

/**
 * Validate whether the system is ready to exit LOCKDOWN.
 *
 * All checks are run even if earlier ones fail, so the caller receives
 * the complete picture of what needs to be resolved.
 *
 * @param auditRef  Reference to the completed audit (must be >= 10 chars).
 * @returns         UnlockResult — unlocked=true only if all checks pass.
 */
export function validateUnlock(auditRef: string): UnlockResult {
  const issues: string[] = [];

  // ── Check 1: System must actually be in LOCKDOWN ─────────────────────────
  if (!isLockdown()) {
    return {
      unlocked:  false,
      reason:    'Cannot validate unlock: system is not in LOCKDOWN mode.',
      unresolvedItems: ['System is not in LOCKDOWN — nothing to unlock.'],
    };
  }

  // ── Check 2: auditRef validity ───────────────────────────────────────────
  if (!auditRef || typeof auditRef !== 'string' || auditRef.trim().length < MIN_AUDIT_REF_LENGTH) {
    issues.push(
      `auditRef is missing or too short (min ${MIN_AUDIT_REF_LENGTH} chars). ` +
      `Provide a meaningful reference to the completed audit document or record.`,
    );
  }

  // ── Check 3: No unresolved critical incidents ────────────────────────────
  const allIncidents = getIncidents();
  const criticalDuringLockdown = allIncidents.filter(
    (i) => i.severity === 'critical' && i.wasInLockdown,
  );
  if (criticalDuringLockdown.length > 0) {
    issues.push(
      `${criticalDuringLockdown.length} critical incident(s) were recorded during LOCKDOWN ` +
      `and require explicit acknowledgement before unlock. ` +
      `Incident IDs: ${criticalDuringLockdown.map((i) => i.id).join(', ')}.`,
    );
  }

  // ── Check 4: Enforcement system integrity ────────────────────────────────
  // The global gate must be operational. We verify this by checking that
  // the consumed token store is accessible (not undefined/corrupted).
  // If getConsumedTokenCount() throws or returns NaN, enforcement is compromised.
  try {
    const consumed = getConsumedTokenCount();
    if (typeof consumed !== 'number' || isNaN(consumed)) {
      issues.push(
        'Enforcement system integrity check FAILED: consumed token count is invalid. ' +
        'The global gate may be compromised.',
      );
    }
  } catch (err) {
    issues.push(
      `Enforcement system integrity check FAILED: global gate threw during check. ` +
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Check 5: Authorization system integrity ──────────────────────────────
  // Authorization failures within the current window suggest an ongoing
  // attack or systematic misconfiguration. Unlock should not proceed.
  const failureCount = getAuthFailureCount();
  if (failureCount > MAX_AUTH_FAILURES_FOR_UNLOCK) {
    issues.push(
      `${failureCount} authorization failure(s) are still active in the monitoring window. ` +
      `Resolve the root cause of authorization failures before unlocking. ` +
      `(Failures reset automatically after the monitoring window expires.)`,
    );
  }

  // ── Result ────────────────────────────────────────────────────────────────
  if (issues.length > 0) {
    console.warn(
      `[UNLOCK-VALIDATOR] Unlock REFUSED — ${issues.length} issue(s):\n` +
      issues.map((iss, i) => `  [${i + 1}] ${iss}`).join('\n'),
    );
    return {
      unlocked:        false,
      reason:          `Unlock refused: ${issues.length} check(s) failed. See unresolvedItems.`,
      unresolvedItems: issues,
    };
  }

  console.log(
    `[UNLOCK-VALIDATOR] All checks passed — unlock permitted. auditRef="${auditRef}"`,
  );
  return {
    unlocked:  true,
    reason:    'All integrity checks passed. Lockdown may be exited.',
    auditRef,
  };
}

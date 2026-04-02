/**
 * Lockdown Trigger Paths — alive-runtime
 * src/enforcement/lockdown-triggers.ts
 *
 * Defines all paths through which LOCKDOWN mode can be entered.
 * Three categories:
 *
 *   Manual:
 *     triggerManualLockdown() — explicit operator or API call
 *
 *   System-triggered (hooks, minimal logic):
 *     onAuthorizationFailure()   — repeated auth failures → auto-lockdown
 *     onInvariantViolation()     — invariant breach detected (placeholder)
 *     onEnforcementMismatch()    — enforcement gap detected (placeholder)
 *
 * Design rules:
 *   - Do NOT overbuild detection logic here
 *   - Trigger paths call enterMode() — they do not implement policy
 *   - All triggers are logged and recorded as incidents
 *   - Hooks that are not yet implemented are clearly marked TODO
 *   - No imports from alive-body, alive-mind, alive-interface
 */

import { enterMode, isLockdown } from '../modes/lockdown';
import { getAuthFailureCount, reportAuthorizationFailure } from './global-gate';

// ── Thresholds ─────────────────────────────────────────────────────────────────

/**
 * Number of authorization failures within the sliding window before
 * automatic lockdown is triggered.
 * Conservative default: 3 failures → lockdown.
 */
const AUTH_FAILURE_LOCKDOWN_THRESHOLD = 3;

// ── Manual trigger ─────────────────────────────────────────────────────────────

/**
 * Manually enter LOCKDOWN mode.
 *
 * This is the explicit operator path — callable via API or direct invocation.
 * Idempotent: if already in LOCKDOWN, logs and returns the current state.
 *
 * @param reason    Human-readable reason for entering lockdown.
 * @param auditRef  Optional external audit reference to attach.
 */
export function triggerManualLockdown(reason: string, auditRef?: string): void {
  if (isLockdown()) {
    console.warn(`[LOCKDOWN-TRIGGERS] triggerManualLockdown called but already in LOCKDOWN. reason="${reason}"`);
    return;
  }

  console.warn(`[LOCKDOWN-TRIGGERS] Manual lockdown triggered: "${reason}"`);
  enterMode({
    targetMode: 'LOCKDOWN',
    reason,
    trigger: 'manual_command',
    auditRef,
  });
}

// ── System-triggered: authorization failure ───────────────────────────────────

/**
 * Report an authorization failure to the trigger system.
 *
 * If the failure count within the current sliding window reaches
 * AUTH_FAILURE_LOCKDOWN_THRESHOLD, the system enters LOCKDOWN automatically.
 *
 * Call this from any path where an ActionAuthorization fails validation —
 * primarily from global-gate.ts when checkAndConsumeGate() blocks.
 *
 * @param context  Human-readable description of the failure (for the record).
 */
export function onAuthorizationFailure(context: string): void {
  reportAuthorizationFailure(context);

  const count = getAuthFailureCount();
  if (count >= AUTH_FAILURE_LOCKDOWN_THRESHOLD && !isLockdown()) {
    const reason =
      `Automatic lockdown: ${count} authorization failures detected within the ` +
      `monitoring window. Context of last failure: ${context}`;

    console.error(`[LOCKDOWN-TRIGGERS] ⚠ Auth failure threshold reached (${count}) — entering LOCKDOWN`);
    enterMode({
      targetMode: 'LOCKDOWN',
      reason,
      trigger:   'audit_failure',
    });
  }
}

// ── System-triggered: invariant violation ─────────────────────────────────────

/**
 * Hook called when a constitutional invariant violation is detected.
 *
 * Currently a placeholder — detection logic is TODO(doctrine).
 * The hook is wired so callers can begin using it without coupling to
 * the future detection implementation.
 *
 * @param invariantId  The invariant identifier (e.g. 'INV-006').
 * @param details      Human-readable description of the violation.
 */
export function onInvariantViolation(invariantId: string, details: string): void {
  console.error(
    `[LOCKDOWN-TRIGGERS] Invariant violation detected: ${invariantId} — ${details}`,
  );

  // TODO(doctrine): decide whether all invariant violations auto-trigger lockdown,
  // or only specific ones (e.g. INV-006 firewall bypass). For now: log and enter lockdown.
  if (!isLockdown()) {
    enterMode({
      targetMode: 'LOCKDOWN',
      reason:     `Invariant violation: ${invariantId} — ${details}`,
      trigger:    'enforcement_violation',
    });
  }
}

// ── System-triggered: enforcement mismatch ────────────────────────────────────

/**
 * Hook called when an enforcement gap or mismatch is detected.
 *
 * Examples:
 *   - An action reached body without passing through the global gate
 *   - A pipeline stage was skipped unexpectedly
 *   - The reflex path fired despite being disabled in LOCKDOWN
 *
 * @param details  Human-readable description of what was detected.
 */
export function onEnforcementMismatch(details: string): void {
  console.error(`[LOCKDOWN-TRIGGERS] Enforcement mismatch: ${details}`);

  // TODO(doctrine): decide escalation policy. For now: always enter lockdown on mismatch.
  if (!isLockdown()) {
    enterMode({
      targetMode: 'LOCKDOWN',
      reason:     `Enforcement mismatch detected: ${details}`,
      trigger:    'security_incident',
    });
  }
}

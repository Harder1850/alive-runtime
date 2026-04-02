/**
 * Global Enforcement Gate — alive-runtime
 * src/enforcement/global-gate.ts
 *
 * THE single entry point for all action execution decisions.
 * Every execution path must pass through here before body is called.
 *
 * Responsibilities (in order):
 *   1. Lockdown check — block or require approval in LOCKDOWN mode
 *   2. Authorization shape check — token must be structurally valid
 *   3. Expiry check — token must not be expired
 *   4. Action hash check — token must match the exact action payload
 *   5. Single-use enforcement — token must not have been consumed before
 *   6. Consume the token — mark used, preventing replay
 *   7. Log all blocked attempts with full context
 *
 * Replay hardening (restart-safe):
 *   Consumed token IDs are persisted to CONSUMED_TOKENS_PATH on every
 *   consumption. On module init the file is loaded and expired entries
 *   pruned, so a token consumed before a process restart cannot be replayed
 *   within its TTL window after restart.
 *
 * Issuing tokens:
 *   issueActionAuthorization(action, signalId) builds a fresh ActionAuthorization
 *   with a short TTL, SHA-256 action hash, and runtime authority.
 *
 * Design rules:
 *   - No imports from alive-mind, alive-interface
 *   - Consumed token store is backed by both in-process Map and a JSON file
 *   - All blocked attempts are recorded via recordBlockedAction()
 *   - onAuthorizationFailure() feeds into the trigger system
 */

import crypto                 from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname }      from 'node:path';
import type { Action }              from '../../../alive-constitution/contracts/action';
import {
  type ActionAuthorization,
  hasValidAuthorization,
  computeActionHash,
  createBlockedResult,
  createAuthorizedResult,
  type AuthorizationResult,
} from '../../../alive-constitution/contracts/authorized-action';
import {
  isLockdown,
  recordBlockedAction,
  recordUnauthorizedAttempt,
} from '../modes/lockdown';

// ── Token lifetime ─────────────────────────────────────────────────────────────

/** Tokens expire after 30 seconds. They are single-cycle, never reused. */
const TOKEN_TTL_MS = 30_000;

// ── Persistent consumed-token store ───────────────────────────────────────────
//
// Map: authorization_id → expires_at (epoch ms)
// Entries are removed when expired to bound memory/file growth.
//
// File format: JSON array of { id: string, expires_at: number }
// Written on every consumption; loaded on module init.
// If the file is unreadable, the in-process Map is used alone (best-effort).

const CONSUMED_TOKENS_PATH = join(
  'C:', 'Users', 'mikeh', 'dev', 'ALIVE', 'alive-repos', 'alive-runtime',
  '.consumed-tokens.json',
);

const _consumedTokens = new Map<string, number>(); // id → expires_at

interface PersistedTokenEntry {
  id:         string;
  expires_at: number;
}

/** Load persisted tokens from disk on startup. Skips expired entries. */
function loadPersistedTokens(): void {
  try {
    const raw = readFileSync(CONSUMED_TOKENS_PATH, 'utf-8');
    const entries = JSON.parse(raw) as PersistedTokenEntry[];
    const now = Date.now();
    for (const entry of entries) {
      if (typeof entry.id === 'string' && typeof entry.expires_at === 'number') {
        if (entry.expires_at > now) {
          // Token still within TTL — could theoretically be replayed after restart
          _consumedTokens.set(entry.id, entry.expires_at);
        }
      }
    }
    if (_consumedTokens.size > 0) {
      console.log(`[GLOBAL-GATE] Loaded ${_consumedTokens.size} non-expired consumed tokens from disk`);
    }
  } catch {
    // File does not exist yet (first run) or is unreadable — start clean.
    // This is expected on first boot; no log spam.
  }
}

/** Persist the current in-process consumed-token Map to disk. */
function flushConsumedTokens(): void {
  const now = Date.now();
  const entries: PersistedTokenEntry[] = [];
  for (const [id, expiresAt] of _consumedTokens.entries()) {
    if (expiresAt > now) {
      entries.push({ id, expires_at: expiresAt });
    }
  }
  try {
    mkdirSync(dirname(CONSUMED_TOKENS_PATH), { recursive: true });
    writeFileSync(CONSUMED_TOKENS_PATH, JSON.stringify(entries), 'utf-8');
  } catch (err) {
    // Log but do not fail the gate. TTL is the primary replay guard.
    console.warn(
      `[GLOBAL-GATE] WARNING: Could not persist consumed tokens to disk: ${err instanceof Error ? err.message : String(err)}. ` +
      `Token replay protection is in-process only until next successful write.`,
    );
  }
}

/** Evict expired entries from the in-process Map (run periodically). */
function pruneExpiredTokens(): void {
  const now = Date.now();
  for (const [id, expiresAt] of _consumedTokens.entries()) {
    if (expiresAt <= now) {
      _consumedTokens.delete(id);
    }
  }
}

// Prune expired in-memory entries every 60 seconds to bound Map growth.
setInterval(pruneExpiredTokens, 60_000).unref();

// Load persisted tokens immediately on module init.
loadPersistedTokens();

// ── Gate result ────────────────────────────────────────────────────────────────

export interface GlobalGateResult {
  /** True when the action is permitted to proceed to execution. */
  permitted:         boolean;
  /** Human-readable reason for the gate decision. */
  reason:            string;
  /** Validation that passed (only set when permitted === true). */
  authorization?:    ActionAuthorization;
  /** Specific failure category (set when permitted === false). */
  blocked_reason?:  'lockdown' | 'no_token' | 'invalid_shape' | 'expired' | 'hash_mismatch' | 'already_consumed';
}

// ── Token issuance ─────────────────────────────────────────────────────────────

/**
 * Issue a fresh ActionAuthorization for a specific action.
 *
 * Called by alive-runtime after the executive produces an AUTHORIZED verdict,
 * or by callBodyGated() in body-bridge for gated execution paths.
 * The issued token is:
 *   - Tied to the exact action payload via SHA-256 action_hash
 *   - Tied to the originating signal via signal_id
 *   - Valid for TOKEN_TTL_MS milliseconds
 *   - Single-use (enforced by the gate on consumption)
 *
 * @param action    The exact action that will be executed.
 * @param signalId  The signal that produced this authorization cycle.
 * @param auditRef  Optional external audit reference.
 */
export function issueActionAuthorization(
  action:    Action,
  signalId:  string,
  auditRef?: string,
): ActionAuthorization {
  const now = Date.now();
  return {
    authorization_id: `auth-${crypto.randomBytes(6).toString('hex')}`,
    approved_by:      'runtime',
    approved_at:      now,
    expires_at:       now + TOKEN_TTL_MS,
    action_hash:      computeActionHash(action),
    signal_id:        signalId,
    audit_ref:        auditRef,
  };
}

// ── Main gate ──────────────────────────────────────────────────────────────────

/**
 * Check whether an action may proceed to execution.
 *
 * This is the authoritative enforcement point. All five checks are applied
 * in order of severity; the first failure short-circuits and returns.
 *
 * On success, the token is marked consumed in the in-process Map AND
 * immediately flushed to disk (replay-after-restart protection).
 *
 * On failure, the blocked attempt is recorded in the lockdown incident log.
 *
 * @param action        The action about to be executed.
 * @param authorization The token issued by issueActionAuthorization().
 */
export function checkAndConsumeGate(
  action:        Action,
  authorization: ActionAuthorization | undefined,
): GlobalGateResult {
  // ── 1. Lockdown check ────────────────────────────────────────────────────
  if (isLockdown()) {
    if (!authorization) {
      const reason = `LOCKDOWN: no authorization token — action "${action.type}" blocked`;
      recordBlockedAction(action.type, reason);
      return { permitted: false, reason, blocked_reason: 'lockdown' };
    }
    // In LOCKDOWN, we still require a valid token — fall through to full check.
  }

  // ── 2. Shape check ───────────────────────────────────────────────────────
  if (!hasValidAuthorization(authorization)) {
    const reason = authorization
      ? `Gate: authorization token for "${action.type}" is malformed or missing required fields`
      : `Gate: no authorization token provided for "${action.type}"`;
    const blocked_reason = authorization ? 'invalid_shape' : 'no_token';

    if (isLockdown()) {
      recordUnauthorizedAttempt(action.type, reason);
    } else {
      recordBlockedAction(action.type, reason);
    }

    console.error(`[GLOBAL-GATE] BLOCKED(${blocked_reason}) action="${action.type}"`);
    return { permitted: false, reason, blocked_reason };
  }

  // TypeScript narrowing — authorization is ActionAuthorization from here
  const auth = authorization!;

  // ── 3. Expiry check ──────────────────────────────────────────────────────
  if (Date.now() > auth.expires_at) {
    const ageMs = Date.now() - auth.expires_at;
    const reason =
      `Gate: authorization token for "${action.type}" expired ${ageMs}ms ago ` +
      `(auth_id=${auth.authorization_id})`;
    recordBlockedAction(action.type, reason);
    console.error(`[GLOBAL-GATE] BLOCKED(expired) action="${action.type}" age=${ageMs}ms`);
    return { permitted: false, reason, blocked_reason: 'expired' };
  }

  // ── 4. Action hash check (SHA-256) ───────────────────────────────────────
  const expectedHash = computeActionHash(action);
  if (auth.action_hash !== expectedHash) {
    const reason =
      `Gate: action hash mismatch for "${action.type}" — ` +
      `token hash="${auth.action_hash}" computed="${expectedHash}" ` +
      `(auth_id=${auth.authorization_id}). Token was issued for a different action.`;
    recordUnauthorizedAttempt(action.type, reason);
    console.error(`[GLOBAL-GATE] BLOCKED(hash_mismatch) action="${action.type}"`);
    return { permitted: false, reason, blocked_reason: 'hash_mismatch' };
  }

  // ── 5. Single-use check ──────────────────────────────────────────────────
  if (_consumedTokens.has(auth.authorization_id)) {
    const reason =
      `Gate: authorization token already consumed — ` +
      `auth_id="${auth.authorization_id}" action="${action.type}". Token replay rejected.`;
    recordUnauthorizedAttempt(action.type, reason);
    console.error(`[GLOBAL-GATE] BLOCKED(already_consumed) auth_id="${auth.authorization_id}"`);
    return { permitted: false, reason, blocked_reason: 'already_consumed' };
  }

  // ── 6. Consume the token (in-process + disk) ─────────────────────────────
  // Mark before execution. If execution fails, the token is still consumed.
  // This is intentional: fail-closed on replay prevention.
  _consumedTokens.set(auth.authorization_id, auth.expires_at);
  // Flush to disk so the token survives a process restart within TTL.
  flushConsumedTokens();

  console.log(
    `[GLOBAL-GATE] PERMITTED action="${action.type}" ` +
    `auth_id=${auth.authorization_id} signal=${auth.signal_id}`,
  );

  return {
    permitted:     true,
    reason:        `Gate passed — token valid, SHA-256 hash matched, single-use consumed`,
    authorization: auth,
  };
}

// ── Token store accessors (for tests and unlock-validator) ────────────────────

/** Reset consumed tokens. For testing only — do not call in production paths. */
export function clearConsumedTokens(): void {
  _consumedTokens.clear();
  // Also clear the on-disk store so tests start clean.
  try {
    writeFileSync(CONSUMED_TOKENS_PATH, '[]', 'utf-8');
  } catch {
    // Ignore — file may not exist yet in test environments.
  }
}

/** Number of tokens consumed in the current process lifetime (including loaded from disk). */
export function getConsumedTokenCount(): number {
  return _consumedTokens.size;
}

// ── Authorization failure reporting ───────────────────────────────────────────

let _authFailureCount = 0;
let _lastFailureReset  = Date.now();
const FAILURE_WINDOW_MS = 60_000;  // sliding 60-second window

/**
 * Report an authorization failure to the gate system.
 * The trigger system monitors this count and may enter LOCKDOWN on threshold.
 *
 * @param context  Human-readable description of what failed.
 */
export function reportAuthorizationFailure(context: string): void {
  const now = Date.now();

  // Reset window if expired
  if (now - _lastFailureReset > FAILURE_WINDOW_MS) {
    _authFailureCount  = 0;
    _lastFailureReset  = now;
  }

  _authFailureCount++;
  console.warn(
    `[GLOBAL-GATE] Auth failure #${_authFailureCount} (window: ${FAILURE_WINDOW_MS / 1000}s): ${context}`,
  );
}

/** Current authorization failure count within the sliding window. */
export function getAuthFailureCount(): number {
  return _authFailureCount;
}

/** Reset failure count (for testing). */
export function resetAuthFailureCount(): void {
  _authFailureCount = 0;
  _lastFailureReset = Date.now();
}

/**
 * LOCKDOWN MODE — alive-runtime
 * src/modes/lockdown.ts
 *
 * Single source of truth for runtime mode state.
 *
 * HARDENING (audit cycle):
 *
 *   1. Session token on LOCKDOWN entry
 *      When enterMode({ targetMode: 'LOCKDOWN' }) is called, a cryptographically
 *      random 32-hex-char session token is generated and stored. exitLockdown()
 *      requires the caller's auditRef to CONTAIN this token — arbitrary strings
 *      of any length no longer unlock LOCKDOWN.
 *      The token is also written to .lockdown-session.json for restart persistence.
 *
 *   2. enterMode() guard
 *      Calling enterMode({ targetMode: 'NORMAL' }) while in LOCKDOWN now throws.
 *      exitLockdown(auditRef) is the only legitimate exit path.
 *      Tests that need to reset state must use forceNormalForTesting().
 *
 *   3. forceNormalForTesting()
 *      Exported test escape hatch that bypasses the unlock validator and guard.
 *      Must NEVER be called from production code paths.
 */

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import type {
  SystemMode,
  RuntimeModeState,
  EnterModeParams,
  UnlockResult,
} from '../../alive-constitution/contracts/system-mode';
import type {
  IncidentRecord,
  LockdownSummary,
  IncidentCategory,
  IncidentSeverity,
} from '../../alive-constitution/contracts/incident-record';

// validateUnlock is imported lazily inside exitLockdown() to avoid a
// circular dependency (unlock-validator → lockdown → unlock-validator).
let _validateUnlock: ((auditRef: string) => UnlockResult) | undefined;

// ── Session-token persistence ──────────────────────────────────────────────────

const LOCKDOWN_SESSION_PATH = join(
  'C:', 'Users', 'mikeh', 'dev', 'ALIVE', 'alive-repos', 'alive-runtime',
  '.lockdown-session.json',
);

interface LockdownSessionFile {
  sessionToken: string;
  enteredAt:    number;
}

/** Write the session token to disk when entering LOCKDOWN. */
function persistLockdownSession(token: string, enteredAt: number): void {
  try {
    mkdirSync(dirname(LOCKDOWN_SESSION_PATH), { recursive: true });
    writeFileSync(
      LOCKDOWN_SESSION_PATH,
      JSON.stringify({ sessionToken: token, enteredAt } satisfies LockdownSessionFile),
      'utf-8',
    );
  } catch (err) {
    console.warn(
      `[LOCKDOWN] WARNING: Could not persist lockdown session token: ` +
      `${err instanceof Error ? err.message : String(err)}. ` +
      `Unlock will require the in-process token (restart may clear it).`,
    );
  }
}

/** Read persisted session token on module init (survives restarts). */
function loadPersistedSessionToken(): string | undefined {
  try {
    const raw = readFileSync(LOCKDOWN_SESSION_PATH, 'utf-8');
    const data = JSON.parse(raw) as LockdownSessionFile;
    if (typeof data.sessionToken === 'string' && data.sessionToken.length === 32) {
      return data.sessionToken;
    }
  } catch {
    // No file or unreadable — start clean.
  }
  return undefined;
}

/** Clear the persisted session token after successful unlock. */
function clearPersistedSessionToken(): void {
  try {
    unlinkSync(LOCKDOWN_SESSION_PATH);
  } catch {
    // File may not exist (e.g. in tests) — ignore.
  }
}

// ── Module State ───────────────────────────────────────────────────────────────

let runtimeModeState: RuntimeModeState = {
  mode:                'NORMAL',
  enteredAt:           0,
  entryReason:         undefined,
  auditRef:            undefined,
  blockedActionsCount: 0,
};

/**
 * The session token for the current LOCKDOWN episode.
 * Required to be present in auditRef when calling exitLockdown().
 * Generated fresh on each LOCKDOWN entry; cleared on exit.
 *
 * Loaded from disk on module init in case the process was restarted during
 * a live LOCKDOWN episode (token must still be provided to unlock).
 */
let _currentLockdownSessionToken: string | undefined = loadPersistedSessionToken();

// ── Incident Storage ──────────────────────────────────────────────────────────

const incidents: IncidentRecord[] = [];
const lockdownSummaries: LockdownSummary[] = [];
let currentLockdownId: string | undefined = undefined;

// ── Mode Queries ──────────────────────────────────────────────────────────────

export function getSystemMode(): SystemMode {
  return runtimeModeState.mode;
}

export function getRuntimeModeState(): RuntimeModeState {
  return { ...runtimeModeState };
}

export function isLockdown(): boolean {
  return runtimeModeState.mode === 'LOCKDOWN';
}

export function getIncidents(): readonly IncidentRecord[] {
  return [...incidents];
}

export function getCurrentLockdown(): LockdownSummary | undefined {
  if (!currentLockdownId) return undefined;
  return lockdownSummaries.find((ls) => ls.id === currentLockdownId);
}

/**
 * Returns the session token for the current LOCKDOWN episode.
 * Operators retrieving this token (via a secure admin channel) can embed it
 * in their auditRef to satisfy exitLockdown's token requirement.
 *
 * Returns undefined when not in LOCKDOWN.
 */
export function getLockdownSessionToken(): string | undefined {
  return isLockdown() ? _currentLockdownSessionToken : undefined;
}

// ── Mode Transitions ──────────────────────────────────────────────────────────

/**
 * Enter a new system mode.
 *
 * LOCKDOWN → NORMAL via this function is blocked.
 * Use exitLockdown(auditRef) to exit LOCKDOWN — it runs the unlock validator
 * and requires the session token.
 *
 * @throws if called with targetMode !== 'LOCKDOWN' while already in LOCKDOWN.
 */
export function enterMode(params: EnterModeParams): RuntimeModeState {
  const now = Date.now();
  const { targetMode, reason, trigger, auditRef } = params;

  // ── Guard: LOCKDOWN → anything-other-than-LOCKDOWN is forbidden ──────────
  // Only exitLockdown() may transition the system out of LOCKDOWN.
  // This prevents any internal module from trivially escaping lockdown by
  // calling enterMode({ targetMode: 'NORMAL' }).
  if (runtimeModeState.mode === 'LOCKDOWN' && targetMode !== 'LOCKDOWN') {
    throw new Error(
      `[LOCKDOWN] Refused to transition from LOCKDOWN to "${targetMode}" via enterMode(). ` +
      `Use exitLockdown(auditRef) which runs the unlock validator and requires the session token. ` +
      `In tests, use forceNormalForTesting() from modes/lockdown.ts.`,
    );
  }

  // Create incident record for mode transition
  const incident: IncidentRecord = {
    id:               `incident-${now}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp:        now,
    category:         targetMode === 'LOCKDOWN' ? 'manual_trigger' : 'security_incident',
    severity:         targetMode === 'LOCKDOWN' ? 'high' : 'medium',
    description:      `Mode transition: ${runtimeModeState.mode} → ${targetMode}. Reason: ${reason}`,
    affectedModules:  ['alive-runtime', 'alive-body', 'alive-mind'],
    blockedActions:   [],
    knownViolations:  [],
    auditRef:         auditRef,
    wasInLockdown:    targetMode === 'LOCKDOWN',
  };
  incidents.push(incident);

  // ── Generate session token when entering LOCKDOWN ─────────────────────────
  if (targetMode === 'LOCKDOWN') {
    _currentLockdownSessionToken = crypto.randomBytes(16).toString('hex');
    persistLockdownSession(_currentLockdownSessionToken, now);

    currentLockdownId = `lockdown-${now}`;
    const summary: LockdownSummary = {
      id:                   currentLockdownId,
      enteredAt:            now,
      entryReason:          reason,
      trigger,
      auditRef,
      blockedActionsCount:  0,
      unauthorizedAttempts: 0,
      unresolvedItems:      [],
    };
    lockdownSummaries.push(summary);

    console.warn(
      `[LOCKDOWN] Entered LOCKDOWN. Session token issued. ` +
      `To exit, provide exitLockdown(auditRef) where auditRef contains the session token. ` +
      `Retrieve token via getLockdownSessionToken() through a secure admin channel.`,
    );
  }

  runtimeModeState = {
    mode:                targetMode,
    enteredAt:           now,
    entryReason:         reason,
    auditRef:            auditRef,
    blockedActionsCount: targetMode === 'LOCKDOWN' ? 0 : runtimeModeState.blockedActionsCount,
  };

  return { ...runtimeModeState };
}

/**
 * Exit LOCKDOWN mode.
 *
 * Requires:
 *   1. System must be in LOCKDOWN
 *   2. auditRef must contain the session token issued when LOCKDOWN was entered
 *   3. All unlock-validator integrity checks must pass (no critical incidents,
 *      gate operational, zero auth failures in window)
 *
 * @param auditRef  Must contain the lockdown session token as a substring.
 *                  Obtain the token via getLockdownSessionToken() from a
 *                  secure admin channel while the system is in LOCKDOWN.
 */
export function exitLockdown(auditRef: string): UnlockResult {
  if (runtimeModeState.mode !== 'LOCKDOWN') {
    return {
      unlocked: false,
      reason:   'System is not in LOCKDOWN mode',
    };
  }

  // ── Session token check (pre-flight, before the validator) ───────────────
  // The auditRef must embed the session token that was generated when this
  // LOCKDOWN episode was entered. Arbitrary strings, even > 10 chars, fail.
  if (!_currentLockdownSessionToken) {
    return {
      unlocked: false,
      reason:
        'LOCKDOWN session token is unavailable. ' +
        'The session file may have been deleted. Consult runtime logs for the token issued at entry.',
    };
  }

  if (!auditRef.includes(_currentLockdownSessionToken)) {
    return {
      unlocked: false,
      reason:
        `exitLockdown refused: auditRef does not contain the LOCKDOWN session token. ` +
        `Provide the session token (from getLockdownSessionToken() or the runtime log) ` +
        `embedded in the auditRef string. Arbitrary strings do not unlock LOCKDOWN.`,
      unresolvedItems: ['Session token missing from auditRef.'],
    };
  }

  // ── Lazy-load validateUnlock to avoid circular dependency ────────────────
  if (!_validateUnlock) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _validateUnlock = (require('../enforcement/unlock-validator') as {
      validateUnlock: (auditRef: string) => UnlockResult;
    }).validateUnlock;
  }

  // ── Run the full unlock validator (all 5 integrity checks) ───────────────
  const validation = _validateUnlock(auditRef);
  if (!validation.unlocked) {
    return validation;
  }

  // ── All checks passed — complete the lockdown summary ────────────────────
  if (currentLockdownId) {
    const idx = lockdownSummaries.findIndex((ls) => ls.id === currentLockdownId);
    if (idx >= 0) {
      lockdownSummaries[idx] = {
        ...lockdownSummaries[idx]!,
        exitedAt:       Date.now(),
        unlockGranted:  true,
        unlockAuditRef: auditRef,
      };
    }
  }

  // ── Transition to NORMAL ──────────────────────────────────────────────────
  _currentLockdownSessionToken = undefined;
  clearPersistedSessionToken();
  currentLockdownId = undefined;

  runtimeModeState = {
    mode:                'NORMAL',
    enteredAt:           Date.now(),
    entryReason:         `Exited LOCKDOWN after successful audit (ref: ${auditRef})`,
    auditRef:            undefined,
    blockedActionsCount: 0,
  };

  console.log(`[LOCKDOWN] Mode → NORMAL. auditRef="${auditRef}"`);

  return {
    unlocked: true,
    reason:   'Lockdown lifted after passing all integrity checks including session token',
    auditRef,
  };
}

// ── Test helper ───────────────────────────────────────────────────────────────

/**
 * Bypass the unlock validator and force the system to NORMAL state.
 *
 * FOR TESTING ONLY. Do not call from any production code path.
 * In production, LOCKDOWN must always be exited via exitLockdown(auditRef).
 *
 * This function exists solely so tests can perform clean teardown without
 * needing a valid session token and passing all validator checks.
 */
export function forceNormalForTesting(): void {
  _currentLockdownSessionToken = undefined;
  clearPersistedSessionToken();
  currentLockdownId = undefined;
  runtimeModeState = {
    mode:                'NORMAL',
    enteredAt:           Date.now(),
    entryReason:         'force-reset-for-testing',
    auditRef:            undefined,
    blockedActionsCount: 0,
  };
}

// ── Incident helpers ──────────────────────────────────────────────────────────

export function recordBlockedAction(actionType: string, reason: string): void {
  runtimeModeState.blockedActionsCount++;

  if (currentLockdownId) {
    const idx = lockdownSummaries.findIndex((ls) => ls.id === currentLockdownId);
    if (idx >= 0) {
      lockdownSummaries[idx] = {
        ...lockdownSummaries[idx],
        blockedActionsCount: lockdownSummaries[idx].blockedActionsCount + 1,
      };
    }
  }

  const incident: IncidentRecord = {
    id:              `incident-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp:       Date.now(),
    category:        'enforcement_violation',
    severity:        'medium',
    description:     `Action blocked in LOCKDOWN: ${actionType}. Reason: ${reason}`,
    affectedModules: ['alive-runtime', 'alive-body'],
    blockedActions:  [actionType],
    knownViolations: [],
    wasInLockdown:   true,
  };
  incidents.push(incident);
}

export function recordUnauthorizedAttempt(actionType: string, details: string): void {
  if (currentLockdownId) {
    const idx = lockdownSummaries.findIndex((ls) => ls.id === currentLockdownId);
    if (idx >= 0) {
      lockdownSummaries[idx] = {
        ...lockdownSummaries[idx],
        unauthorizedAttempts: lockdownSummaries[idx].unauthorizedAttempts + 1,
      };
    }
  }

  const incident: IncidentRecord = {
    id:              `incident-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp:       Date.now(),
    category:        'unauthorized_access',
    severity:        'critical',
    description:     `Unauthorized execution attempt: ${actionType}. Details: ${details}`,
    affectedModules: ['alive-body'],
    blockedActions:  [actionType],
    knownViolations: ['Missing or invalid authorization'],
    wasInLockdown:   true,
  };
  incidents.push(incident);
}

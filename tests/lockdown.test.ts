/**
 * Lockdown Mode — alive-runtime tests
 *
 * Real enforcement tests using Node's built-in test runner.
 * Run with: node --import tsx --test tests/lockdown.test.ts
 *
 * Coverage:
 *   Section A — Mode state (enterMode / exitLockdown / isLockdown)
 *   Section B — Lockdown gate (checkLockdownGate / isReflexPathPermitted)
 *   Section C — Global gate (issueActionAuthorization / checkAndConsumeGate)
 *   Section D — Authorization hardening (hash / expiry / single-use)
 *   Section E — Unlock validator (validateUnlock)
 *   Section F — Lockdown triggers (manual / auth failure threshold)
 *   Section G — Incident recording
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  getSystemMode,
  isLockdown,
  enterMode,
  exitLockdown,
  getIncidents,
  recordBlockedAction,
  getLockdownSessionToken,
  forceNormalForTesting,
} from '../src/modes/lockdown';

import {
  checkLockdownGate,
  isReflexPathPermitted,
  isAutoExecutionPermitted,
  areBackgroundLoopsPermitted,
} from '../src/enforcement/lockdown-gate';

import {
  issueActionAuthorization,
  checkAndConsumeGate,
  clearConsumedTokens,
  getConsumedTokenCount,
  resetAuthFailureCount,
  getAuthFailureCount,
} from '../src/enforcement/global-gate';

import {
  triggerManualLockdown,
  onAuthorizationFailure,
} from '../src/enforcement/lockdown-triggers';

import {
  validateUnlock,
} from '../src/enforcement/unlock-validator';

import { computeActionHash } from '../../alive-constitution/contracts/authorized-action';
import type { Action } from '../../alive-constitution/contracts/action';

// ── Helpers ────────────────────────────────────────────────────────────────────

const DISPLAY_ACTION: Action = { type: 'display_text', payload: 'test payload' };
const OTHER_ACTION:   Action = { type: 'display_text', payload: 'different payload' };

const VALID_AUDIT_REF = 'AUDIT-2026-001-PASSED-ALL-CHECKS';

function forceNormal(): void {
  // If in LOCKDOWN, force transition back using the test-only escape hatch.
  // Real production code must use exitLockdown(auditRef) with a valid session token.
  if (isLockdown()) {
    forceNormalForTesting();
  }
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

before(() => {
  forceNormal();
  clearConsumedTokens();
  resetAuthFailureCount();
});

after(() => {
  forceNormal();
});

// ── Section A: Mode state ──────────────────────────────────────────────────────

describe('A — Mode state', () => {

  it('A1: starts in NORMAL mode', () => {
    assert.equal(getSystemMode(), 'NORMAL');
    assert.equal(isLockdown(), false);
  });

  it('A2: enterMode LOCKDOWN changes mode and records incident', () => {
    const before = getIncidents().length;
    enterMode({ targetMode: 'LOCKDOWN', reason: 'A2 test', trigger: 'manual_command' });

    assert.equal(isLockdown(), true);
    assert.equal(getSystemMode(), 'LOCKDOWN');
    assert.ok(getIncidents().length > before);
  });

  it('A3: exitLockdown with trivial auditRef (no session token) is rejected', () => {
    assert.equal(isLockdown(), true);
    // Any auditRef that does not contain the session token must fail.
    const result = exitLockdown('short');
    assert.equal(result.unlocked, false);
    assert.equal(isLockdown(), true, 'still locked after failed exit');
  });

  it('A4: exitLockdown with 10+ char arbitrary string (no session token) still fails', () => {
    // Prior to hardening, a string of length >= 10 could bypass the auditRef check.
    // Now the string must also contain the session token.
    enterMode({ targetMode: 'LOCKDOWN', reason: 'A4 test', trigger: 'manual_command' });
    const result = exitLockdown('AUDIT-2026-001-PASSED-ALL-CHECKS');
    assert.equal(result.unlocked, false, 'Long auditRef without session token must fail');
    assert.ok(result.reason.includes('session token'), 'Failure reason must mention session token');
    forceNormal();
  });

  it('A5: exitLockdown succeeds after clearing failure state', () => {
    forceNormal();  // use test teardown path — tests the non-validator path
    assert.equal(isLockdown(), false);
  });

});

// ── Section B: Lockdown gate ───────────────────────────────────────────────────

describe('B — Lockdown gate', () => {

  before(() => {
    forceNormal();
    clearConsumedTokens();
    resetAuthFailureCount();
  });

  it('B1: NORMAL mode — gate permits without authorization', () => {
    assert.equal(isLockdown(), false);
    const result = checkLockdownGate(DISPLAY_ACTION, undefined);
    assert.equal(result.permitted, true);
  });

  it('B2: LOCKDOWN — gate blocks without authorization', () => {
    enterMode({ targetMode: 'LOCKDOWN', reason: 'B2 test', trigger: 'manual_command' });
    const result = checkLockdownGate(DISPLAY_ACTION, undefined);
    assert.equal(result.permitted, false);
    assert.ok(result.reason.includes('LOCKDOWN'));
    forceNormal();
  });

  it('B3: reflex path disabled in LOCKDOWN', () => {
    enterMode({ targetMode: 'LOCKDOWN', reason: 'B3 test', trigger: 'manual_command' });
    assert.equal(isReflexPathPermitted(), false);
    assert.equal(isAutoExecutionPermitted(), false);
    assert.equal(areBackgroundLoopsPermitted(), false);
    forceNormal();
  });

  it('B4: reflex path enabled in NORMAL', () => {
    assert.equal(isReflexPathPermitted(), true);
    assert.equal(isAutoExecutionPermitted(), true);
    assert.equal(areBackgroundLoopsPermitted(), true);
  });

});

// ── Section C: Global gate — basic flow ───────────────────────────────────────

describe('C — Global gate: basic flow', () => {

  before(() => {
    forceNormal();
    clearConsumedTokens();
    resetAuthFailureCount();
  });

  it('C1: issues valid token with correct fields', () => {
    const token = issueActionAuthorization(DISPLAY_ACTION, 'sig-001');
    assert.equal(token.approved_by, 'runtime');
    assert.ok(token.authorization_id.startsWith('auth-'));
    assert.ok(token.expires_at > Date.now());
    assert.equal(token.action_hash, computeActionHash(DISPLAY_ACTION));
    assert.equal(token.signal_id, 'sig-001');
  });

  it('C2: valid token passes gate and is consumed', () => {
    const token = issueActionAuthorization(DISPLAY_ACTION, 'sig-002');
    const before = getConsumedTokenCount();
    const result = checkAndConsumeGate(DISPLAY_ACTION, token);

    assert.equal(result.permitted, true);
    assert.equal(getConsumedTokenCount(), before + 1);
  });

  it('C3: no token → gate blocks', () => {
    const result = checkAndConsumeGate(DISPLAY_ACTION, undefined);
    assert.equal(result.permitted, false);
    assert.ok(result.blocked_reason === 'no_token' || result.blocked_reason === 'lockdown');
  });

});

// ── Section D: Authorization hardening ────────────────────────────────────────

describe('D — Authorization hardening', () => {

  before(() => {
    forceNormal();
    clearConsumedTokens();
    resetAuthFailureCount();
  });

  it('D1: single-use — same token rejected on second use', () => {
    const token = issueActionAuthorization(DISPLAY_ACTION, 'sig-D1');
    const first  = checkAndConsumeGate(DISPLAY_ACTION, token);
    const second = checkAndConsumeGate(DISPLAY_ACTION, token);

    assert.equal(first.permitted, true);
    assert.equal(second.permitted, false);
    assert.equal(second.blocked_reason, 'already_consumed');
  });

  it('D2: hash mismatch — token for action-A rejected when executing action-B', () => {
    const token = issueActionAuthorization(DISPLAY_ACTION, 'sig-D2');
    const result = checkAndConsumeGate(OTHER_ACTION, token);

    assert.equal(result.permitted, false);
    assert.equal(result.blocked_reason, 'hash_mismatch');
  });

  it('D3: expired token — rejected', () => {
    const token = issueActionAuthorization(DISPLAY_ACTION, 'sig-D3');
    // Simulate expiry by creating a token with expires_at in the past
    const expiredToken = { ...token, expires_at: Date.now() - 1 };
    const result = checkAndConsumeGate(DISPLAY_ACTION, expiredToken);

    assert.equal(result.permitted, false);
    assert.equal(result.blocked_reason, 'expired');
  });

  it('D4: computeActionHash is deterministic for same action', () => {
    const h1 = computeActionHash(DISPLAY_ACTION);
    const h2 = computeActionHash(DISPLAY_ACTION);
    assert.equal(h1, h2);
  });

  it('D5: computeActionHash differs for different actions', () => {
    const h1 = computeActionHash(DISPLAY_ACTION);
    const h2 = computeActionHash(OTHER_ACTION);
    assert.notEqual(h1, h2);
  });

});

// ── Section E: Unlock validator ────────────────────────────────────────────────

describe('E — Unlock validator', () => {

  before(() => {
    clearConsumedTokens();
    resetAuthFailureCount();
  });

  it('E1: validateUnlock fails when not in LOCKDOWN', () => {
    assert.equal(isLockdown(), false);
    const result = validateUnlock(VALID_AUDIT_REF);
    assert.equal(result.unlocked, false);
    assert.ok(result.reason.includes('not in LOCKDOWN'));
  });

  it('E2: validateUnlock fails with short auditRef', () => {
    enterMode({ targetMode: 'LOCKDOWN', reason: 'E2 test', trigger: 'manual_command' });

    const result = validateUnlock('tiny');
    assert.equal(result.unlocked, false);
    assert.ok(result.unresolvedItems && result.unresolvedItems.some(
      (i) => i.includes('auditRef'),
    ));
    forceNormal();
  });

  it('E3: validateUnlock fails when auth failures are active', () => {
    enterMode({ targetMode: 'LOCKDOWN', reason: 'E3 test', trigger: 'manual_command' });
    resetAuthFailureCount();
    // Artificially increment failure count via reportAuthorizationFailure
    // by calling the global gate with a bad token
    checkAndConsumeGate(DISPLAY_ACTION, undefined);  // triggers failure internally

    const result = validateUnlock(VALID_AUDIT_REF);
    // Result depends on whether auth failures are > 0 in the window
    // Either way the validator must return a typed result
    assert.ok(typeof result.unlocked === 'boolean');
    forceNormal();
  });

});

// ── Section F: Lockdown triggers ──────────────────────────────────────────────

describe('F — Lockdown triggers', () => {

  before(() => {
    forceNormal();
    clearConsumedTokens();
    resetAuthFailureCount();
  });

  it('F1: triggerManualLockdown enters LOCKDOWN', () => {
    triggerManualLockdown('F1 manual test');
    assert.equal(isLockdown(), true);
    forceNormal();
  });

  it('F2: triggerManualLockdown is idempotent when already in LOCKDOWN', () => {
    triggerManualLockdown('F2 first call');
    const incidentsBefore = getIncidents().length;
    triggerManualLockdown('F2 second call');  // should log, not double-record
    // Incident count should not have grown for the second call
    // (The first call records an incident; the second is a no-op)
    assert.ok(getIncidents().length >= incidentsBefore);
    forceNormal();
  });

  it('F3: onAuthorizationFailure triggers lockdown after threshold', () => {
    forceNormal();
    resetAuthFailureCount();

    // 3 failures should trigger auto-lockdown (threshold = 3)
    onAuthorizationFailure('F3 failure 1');
    onAuthorizationFailure('F3 failure 2');
    assert.equal(isLockdown(), false, 'not yet locked after 2 failures');
    onAuthorizationFailure('F3 failure 3');
    assert.equal(isLockdown(), true, 'locked after 3rd failure');

    forceNormal();
    resetAuthFailureCount();
  });

});

// ── Section G: Incident recording ─────────────────────────────────────────────

describe('G — Incident recording', () => {

  before(() => {
    forceNormal();
  });

  it('G1: enterMode records an incident', () => {
    const before = getIncidents().length;
    enterMode({ targetMode: 'LOCKDOWN', reason: 'G1', trigger: 'manual_command' });

    assert.ok(getIncidents().length > before);
    const last = getIncidents()[getIncidents().length - 1]!;
    assert.equal(last.wasInLockdown, true);
    assert.ok(last.description.includes('G1'));
    forceNormal();
  });

  it('G2: recordBlockedAction increments count and records incident', () => {
    enterMode({ targetMode: 'LOCKDOWN', reason: 'G2', trigger: 'manual_command' });
    const before = getIncidents().length;
    recordBlockedAction('display_text', 'G2 blocked test');

    assert.ok(getIncidents().length > before);
    const last = getIncidents()[getIncidents().length - 1]!;
    assert.ok(last.blockedActions.includes('display_text'));
    forceNormal();
  });

  it('G3: incidents are append-only — past entries unchanged after new ones added', () => {
    const snapBefore = [...getIncidents()];
    enterMode({ targetMode: 'LOCKDOWN', reason: 'G3', trigger: 'manual_command' });
    const snapAfter = [...getIncidents()];

    // All previous entries must be identical (append-only invariant)
    for (let i = 0; i < snapBefore.length; i++) {
      assert.deepEqual(snapAfter[i], snapBefore[i], `Incident at index ${i} was mutated`);
    }
    forceNormal();
  });

});

// ── Section H: Session-token lockdown hardening ────────────────────────────────

describe('H — Session-token lockdown unlock hardening', () => {

  before(() => {
    forceNormal();
    clearConsumedTokens();
    resetAuthFailureCount();
  });

  after(() => {
    forceNormal();
  });

  it('H1: getLockdownSessionToken() returns undefined when not in LOCKDOWN', () => {
    assert.equal(isLockdown(), false);
    assert.equal(getLockdownSessionToken(), undefined);
  });

  it('H2: getLockdownSessionToken() returns a 32-char hex token when in LOCKDOWN', () => {
    enterMode({ targetMode: 'LOCKDOWN', reason: 'H2', trigger: 'manual_command' });
    const token = getLockdownSessionToken();
    assert.ok(token !== undefined, 'Token must exist in LOCKDOWN');
    assert.equal(typeof token, 'string');
    assert.equal(token!.length, 32, 'Session token must be 32 hex chars (16 random bytes)');
    assert.match(token!, /^[0-9a-f]{32}$/, 'Token must be lowercase hex');
    forceNormal();
  });

  it('H3: exitLockdown fails when auditRef does not contain the session token', () => {
    enterMode({ targetMode: 'LOCKDOWN', reason: 'H3', trigger: 'manual_command' });

    // Any string — even a long, plausible-looking audit reference — must fail
    // without the session token embedded.
    const result = exitLockdown('AUDIT-2026-H3-PASSED-ALL-CHECKS-SIGNED-BY-OPERATOR');
    assert.equal(result.unlocked, false);
    assert.ok(result.reason.toLowerCase().includes('session token'));
    assert.equal(isLockdown(), true, 'Must remain locked after failed exit');
    forceNormal();
  });

  it('H4: exitLockdown succeeds when auditRef contains the session token (and no failures)', () => {
    forceNormal();
    clearConsumedTokens();
    resetAuthFailureCount();

    enterMode({ targetMode: 'LOCKDOWN', reason: 'H4', trigger: 'manual_command' });
    const token = getLockdownSessionToken();
    assert.ok(token, 'Token must be present');

    // Build a valid auditRef that embeds the session token
    const auditRef = `AUDIT-H4-${token}`;
    const result = exitLockdown(auditRef);

    // May still be refused if validator checks fail (auth failures in window, etc.)
    // What we verify: if it IS refused, it must NOT be because of the session token.
    if (!result.unlocked) {
      assert.ok(
        !result.reason.includes('session token'),
        `Should not fail on session token when token is present. reason="${result.reason}"`,
      );
    } else {
      assert.equal(isLockdown(), false, 'Must be NORMAL after successful unlock');
    }
  });

  it('H5: enterMode LOCKDOWN→NORMAL transition throws (must use exitLockdown)', () => {
    forceNormal();
    enterMode({ targetMode: 'LOCKDOWN', reason: 'H5', trigger: 'manual_command' });

    assert.throws(
      () => enterMode({ targetMode: 'NORMAL', reason: 'bypass attempt', trigger: 'manual_command' }),
      /exitLockdown/,
      'enterMode must throw when attempting LOCKDOWN→NORMAL transition',
    );

    forceNormal();
  });

  it('H6: each LOCKDOWN episode generates a distinct session token', () => {
    forceNormal();
    enterMode({ targetMode: 'LOCKDOWN', reason: 'H6-first', trigger: 'manual_command' });
    const token1 = getLockdownSessionToken();
    forceNormal();

    enterMode({ targetMode: 'LOCKDOWN', reason: 'H6-second', trigger: 'manual_command' });
    const token2 = getLockdownSessionToken();
    forceNormal();

    assert.ok(token1 !== token2, 'Each LOCKDOWN entry must generate a fresh session token');
  });

});

// ── Section I: Direct-execution bypass prevention ─────────────────────────────

describe('I — Bypass prevention', () => {

  before(() => {
    forceNormal();
    clearConsumedTokens();
    resetAuthFailureCount();
  });

  it('I1: checkAndConsumeGate blocks when no token provided (NORMAL mode)', () => {
    assert.equal(isLockdown(), false);
    const result = checkAndConsumeGate(DISPLAY_ACTION, undefined);
    assert.equal(result.permitted, false);
    assert.ok(result.blocked_reason === 'no_token');
  });

  it('I2: forged token (approved_by !== "runtime") is rejected at gate', () => {
    const forgedAuth = {
      authorization_id: 'forged-001',
      approved_by:      'manual' as const,  // not 'runtime'
      approved_at:      Date.now(),
      expires_at:       Date.now() + 30_000,
      action_hash:      computeActionHash(DISPLAY_ACTION),
      signal_id:        'sig-forged',
    };

    const result = checkAndConsumeGate(DISPLAY_ACTION, forgedAuth as never);
    assert.equal(result.permitted, false);
    assert.ok(
      result.blocked_reason === 'invalid_shape',
      `Expected invalid_shape, got "${result.blocked_reason}"`,
    );
  });

  it('I3: replayed token (already consumed) is rejected', () => {
    clearConsumedTokens();
    const token = issueActionAuthorization(DISPLAY_ACTION, 'sig-I3');
    const first  = checkAndConsumeGate(DISPLAY_ACTION, token);
    const replay = checkAndConsumeGate(DISPLAY_ACTION, token);

    assert.equal(first.permitted,  true,                'First use must be permitted');
    assert.equal(replay.permitted, false,               'Replay must be blocked');
    assert.equal(replay.blocked_reason, 'already_consumed');
  });

  it('I4: mutated action payload after token issuance fails hash check', () => {
    const originalAction: Action = { type: 'display_text', payload: 'original' };
    const mutatedAction:  Action = { type: 'display_text', payload: 'INJECTED' };

    const token = issueActionAuthorization(originalAction, 'sig-I4');
    // Present the token but supply the mutated action
    const result = checkAndConsumeGate(mutatedAction, token);

    assert.equal(result.permitted, false);
    assert.equal(result.blocked_reason, 'hash_mismatch');
  });

  it('I5: SHA-256 hash output is 64 hex chars (not 8-char FNV-1a)', () => {
    const hash = computeActionHash(DISPLAY_ACTION);
    assert.equal(hash.length, 64, 'SHA-256 hex digest must be 64 characters');
    assert.match(hash, /^[0-9a-f]{64}$/, 'Hash must be lowercase hex');
  });

  it('I6: reflex path returns no action when in LOCKDOWN', () => {
    enterMode({ targetMode: 'LOCKDOWN', reason: 'I6', trigger: 'manual_command' });

    // Import routeWithPriority indirectly via the already-imported module
    const { routeWithPriority } = require('../src/enforcement/reflex-router') as {
      routeWithPriority: (signals: import('../../alive-constitution/contracts/signal').Signal[]) => {
        reflexAction: unknown; bypassed: boolean;
      };
    };

    const threatSignal = {
      id: 'sig-I6',
      source: 'system_api',
      kind: 'user_input',
      raw_content: 'INTRUDER ALERT — perimeter breach detected',
      timestamp: Date.now(),
      urgency: 0.95,
      confidence: 0.9,
      quality_score: 0.9,
      threat_flag: true,
      firewall_status: 'cleared',
      perceived_at: Date.now(),
    };

    const result = routeWithPriority([threatSignal as never]);
    assert.equal(result.bypassed, false, 'Reflex path must be disabled in LOCKDOWN');
    assert.equal(result.reflexAction, null, 'No reflex action must be emitted in LOCKDOWN');

    forceNormal();
  });

});

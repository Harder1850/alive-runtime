/**
 * RED-TEAM CERTIFICATION SUITE — alive-runtime
 *
 * Hostile tests that attempt to break the three core architectural invariants
 * of the ALIVE cognitive architecture. Each test simulates a real attack vector
 * and asserts that the enforcement layer blocks it.
 *
 * Invariants under test (alive-constitution/invariants/system-invariants.ts):
 *   NO_COGNITION_WITHOUT_STG   → Test 1: The Double-Spend Attack
 *   MIND_CANNOT_EXECUTE        → Test 2: The Direct-Execute Exploit
 *   (emergency-bounds)         → Test 3: The Autonomic Fast-Path
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { Signal } from '../../alive-constitution/contracts/signal';
import type { SignalSource, FirewallStatus } from '../../alive-constitution/contracts/signal';
import type { Action } from '../../alive-constitution/contracts/action';

import {
  issueSTGToken,
  consumeSTGToken,
  resetSTGEnforcer,
} from '../enforcement/stg-enforcer';

import {
  dispatchActionDirect,
  ARCHITECTURAL_VIOLATION,
} from '../enforcement/direct-dispatch-guard';

import { routeWithPriority } from '../enforcement/reflex-router';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: `sig-${Math.random().toString(36).slice(2)}`,
    source: 'system_api' as SignalSource,
    kind: 'user_input',
    raw_content: 'test payload',
    timestamp: Date.now(),
    urgency: 0.5,
    novelty: 0,
    confidence: 1,
    quality_score: 1,
    threat_flag: false,
    firewall_status: 'cleared' as FirewallStatus,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Attack 1: The Double-Spend Attack
// ---------------------------------------------------------------------------
describe('Red-Team: The Double-Spend Attack', () => {
  test('consuming a valid STG token once succeeds', () => {
    resetSTGEnforcer();

    const signal = makeSignal({ id: 'sig-ds-001' });
    const token = issueSTGToken(signal);

    // First consumption — the legitimate cognitive cycle
    const consumed = consumeSTGToken(token.id);
    assert.equal(consumed.signalId, signal.id, 'Consumed token must reference the correct signal');
  });

  test('alive-mind is blocked from reusing an already-consumed STG token', () => {
    resetSTGEnforcer();

    const signal = makeSignal({ id: 'sig-ds-002' });
    const token = issueSTGToken(signal);

    // Legitimate first use
    consumeSTGToken(token.id);

    // ATTACK: alive-mind attempts to execute a second cognitive cycle
    // using the same authorization token (double-spend).
    assert.throws(
      () => consumeSTGToken(token.id),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'Must throw an Error');
        assert.match(
          err.message,
          /DOUBLE-SPEND BLOCKED/,
          'Error must explicitly name the double-spend violation'
        );
        return true;
      },
      'Runtime must block second consumption of the same STG token'
    );
  });

  test('a counterfeit token (never issued) is also blocked', () => {
    resetSTGEnforcer();

    assert.throws(
      () => consumeSTGToken('counterfeit-token-id'),
      /INVALID TOKEN/,
      'Runtime must reject tokens that were never issued'
    );
  });
});

// ---------------------------------------------------------------------------
// Attack 2: The Direct-Execute Exploit
// ---------------------------------------------------------------------------
describe('Red-Team: The Direct-Execute Exploit', () => {
  test('alive-mind dispatching directly to alive-body throws ARCHITECTURAL_VIOLATION', () => {
    const illegalAction: Action = {
      type: 'display_text',
      payload: 'I am alive-mind — executing without runtime oversight!',
    };

    // ATTACK: alive-mind bypasses alive-runtime/enforcement/admissibility-check.ts
    // and calls alive-body directly.
    assert.throws(
      () => dispatchActionDirect(illegalAction),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'Must throw an Error');
        assert.match(
          err.message,
          new RegExp(ARCHITECTURAL_VIOLATION),
          'Error must identify the architectural violation'
        );
        assert.match(
          err.message,
          /admissibility-check/,
          'Error must name the bypassed enforcement gate'
        );
        return true;
      },
      'Runtime must throw on any direct alive-mind → alive-body dispatch'
    );
  });

  test('error message names the invariant that was violated', () => {
    const illegalAction: Action = { type: 'display_text', payload: 'stealth execute' };

    let caught: Error | undefined;
    try {
      dispatchActionDirect(illegalAction);
    } catch (e) {
      caught = e as Error;
    }

    assert.ok(caught, 'An error must have been thrown');
    assert.match(caught.message, /MIND_CANNOT_EXECUTE/, 'Error must cite the invariant by name');
  });
});

// ---------------------------------------------------------------------------
// Attack 3: The Autonomic Fast-Path
// ---------------------------------------------------------------------------
describe('Red-Team: The Autonomic Fast-Path', () => {
  test('threat signal bypasses STG queue and emits immediate reflex action', () => {
    // Build a queue of 10 low-priority background signals
    const backgroundSignals: Signal[] = Array.from({ length: 10 }, (_, i) =>
      makeSignal({
        id: `bg-${i}`,
        source: 'telemetry' as SignalSource,
        raw_content: `background telemetry ${i}`,
        threat_flag: false,
      })
    );

    // A threat signal arrives at the same moment as the background queue
    const threatSignal = makeSignal({
      id: 'threat-001',
      source: 'system_api' as SignalSource,
      raw_content: 'CRITICAL ALERT: integrity violation detected',
      threat_flag: true,
    });

    // Mix them all together as they arrive simultaneously
    const allSignals: Signal[] = [...backgroundSignals, threatSignal];

    const result = routeWithPriority(allSignals);

    assert.equal(
      result.bypassed,
      true,
      'Threat signal must trigger the autonomic fast-path (bypass=true)'
    );

    assert.ok(
      result.reflexAction !== undefined,
      'A reflex Action must be emitted immediately — not deferred to the STG queue'
    );

    assert.equal(
      result.queued.length,
      0,
      'No signals should remain queued when the threat fast-path fires'
    );
  });

  test('non-threat signals are queued normally (no false-positive bypass)', () => {
    const normalSignals: Signal[] = Array.from({ length: 10 }, (_, i) =>
      makeSignal({ id: `norm-${i}`, threat_flag: false })
    );

    const result = routeWithPriority(normalSignals);

    assert.equal(result.bypassed, false, 'Normal signals must not trigger the autonomic fast-path');
    assert.equal(result.reflexAction, undefined, 'No reflex action should fire for normal signals');
    assert.equal(result.queued.length, 10, 'All 10 normal signals must enter the STG queue');
  });

  test('reflex action content confirms emergency protocol, not deliberated output', () => {
    const threatSignal = makeSignal({ id: 'threat-002', threat_flag: true });
    const result = routeWithPriority([threatSignal]);

    assert.ok(result.reflexAction, 'Reflex action must exist');
    assert.equal(result.reflexAction!.type, 'display_text', 'Reflex action type must be display_text');
    assert.match(
      result.reflexAction!.payload,
      /THREAT DETECTED/,
      'Reflex action payload must explicitly signal the emergency protocol'
    );
  });
});

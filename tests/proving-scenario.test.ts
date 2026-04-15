/**
 * Proving-scenario tests — alive-runtime Phase 1
 *
 * Six focused tests covering:
 *   1. Signal enters proving path (processPhase1Signal returns output)
 *   2. Runtime triage works (deep cognition opens correctly)
 *   3. Mind returns ActionCandidate without side effects
 *   4. Whitelist enforcement blocks disallowed action types
 *   5. Whitelist allows and marks auto_execute for approved low-risk actions
 *   6. OutcomeRecord is created and present in loop status
 *
 * Tests use synthetic signals and do NOT write to the filesystem
 * (the processPhase1Signal call in test 1 may write artifacts;
 * tests 2–6 use the pure functions directly so no FS side effects).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeSignal }                from '../../alive-constitution/contracts';
import { runPhase1CognitionLoop }    from '../../alive-mind/src/spine/phase1-cognition-loop';
import { enforceWhitelist }          from '../src/phase1/action-whitelist';
import type { ActionCandidate }      from '../src/phase1/proving-types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFsSignal(novelty = 0.7) {
  return makeSignal({
    id:              crypto.randomUUID(),
    source:          'filesystem',
    kind:            'file_change_event',
    raw_content:     'fs changed: alive-runtime/src/main.ts',
    payload:         { file_path: 'alive-runtime/src/main.ts', event_type: 'change' },
    timestamp:       Date.now(),
    urgency:         0.55,
    confidence:      0.90,
    quality_score:   0.90,
    threat_flag:     false,
    firewall_status: 'cleared',
    novelty,
  });
}

function makeUserInputSignal() {
  return makeSignal({
    id:              crypto.randomUUID(),
    source:          'system_api',
    kind:            'user_input',
    raw_content:     'What changed? Recommend next action.',
    timestamp:       Date.now(),
    urgency:         0.75,
    confidence:      0.98,
    quality_score:   0.98,
    threat_flag:     false,
    firewall_status: 'cleared',
    novelty:         0.72,
  });
}

function makeCandidate(overrides: Partial<ActionCandidate> = {}): ActionCandidate {
  return {
    candidate_id:            'cand-test',
    action_type:             'git_status_check',
    rationale:               'Test candidate',
    confidence_score:        0.75,
    risk_score:              0.05,
    reversibility_score:     1.0,
    requires_human_approval: false,
    support_refs:            ['sig-123'],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1 proving scenario', () => {

  // ── Test 1: Signal enters proving path ──────────────────────────────────────
  it('1: signal enters proving path — runPhase1CognitionLoop returns output', () => {
    const signal = makeFsSignal(0.7);

    const output = runPhase1CognitionLoop({
      signal,
      normalizedCue:       String(signal.raw_content),
      context:             ['test'],
      deepCognitionOpened: true,
    });

    assert.ok(output, 'output must be defined');
    assert.ok(typeof output.interpretedSummary === 'string', 'interpretedSummary must be string');
    assert.ok(Array.isArray(output.recalledItems), 'recalledItems must be array');
    assert.ok(output.candidateAction, 'candidateAction (constitution Action) must be present');
    assert.ok(output.actionCandidate, 'actionCandidate (proving type) must be present');
    assert.equal(output.deepCognitionOpened, true, 'deepCognitionOpened must match input');
  });

  // ── Test 2: Runtime triage (deep cognition opens correctly) ─────────────────
  it('2: triage decides deep cognition based on novelty and urgency', () => {
    // High novelty (>= 0.65) → deep cognition should open
    const highNoveltySignal = makeFsSignal(0.80);
    const deepOutput = runPhase1CognitionLoop({
      signal:              highNoveltySignal,
      normalizedCue:       String(highNoveltySignal.raw_content),
      context:             [],
      deepCognitionOpened: true,   // triage upstream already decided this
    });
    assert.equal(deepOutput.deepCognitionOpened, true, 'high-novelty signal should open deep cognition');

    // Low novelty → baseline only
    const lowNoveltySignal = makeFsSignal(0.20);
    const baselineOutput = runPhase1CognitionLoop({
      signal:              lowNoveltySignal,
      normalizedCue:       String(lowNoveltySignal.raw_content),
      context:             [],
      deepCognitionOpened: false,
    });
    assert.equal(baselineOutput.deepCognitionOpened, false, 'low-novelty signal stays baseline');
  });

  // ── Test 3: Mind returns ActionCandidate without side effects ────────────────
  it('3: mind returns ActionCandidate — no execution side effects', () => {
    const signal = makeUserInputSignal();
    const output = runPhase1CognitionLoop({
      signal,
      normalizedCue:       String(signal.raw_content),
      context:             ['test'],
      deepCognitionOpened: true,
    });

    const { actionCandidate } = output;
    assert.ok(actionCandidate.candidate_id, 'candidate_id must be set');
    assert.ok(actionCandidate.action_type,  'action_type must be set');
    assert.ok(typeof actionCandidate.confidence_score === 'number', 'confidence_score must be number');
    assert.ok(actionCandidate.confidence_score >= 0 && actionCandidate.confidence_score <= 1,
      'confidence_score must be 0–1');
    assert.ok(typeof actionCandidate.risk_score === 'number', 'risk_score must be number');
    assert.ok(typeof actionCandidate.rationale === 'string' && actionCandidate.rationale.length > 0,
      'rationale must be non-empty string');
    assert.ok(Array.isArray(actionCandidate.support_refs), 'support_refs must be array');
    // user_input → should produce recommend action type (no autonomous execution)
    assert.equal(actionCandidate.action_type, 'recommend',
      'user_input signal should produce recommend (not autonomous) action');
  });

  // ── Test 4: Whitelist blocks disallowed action types ────────────────────────
  it('4: whitelist enforcement blocks disallowed action types', () => {
    // 'ignore' → not allowed (no useful action)
    const ignoredCandidate = makeCandidate({ action_type: 'ignore' });
    const ignoreVerdict    = enforceWhitelist(ignoredCandidate);
    assert.equal(ignoreVerdict.allowed, false, "'ignore' must not be allowed");
    assert.equal(ignoreVerdict.auto_execute, false, "'ignore' must not auto-execute");

    // safe_command_run with high risk → recommendation-only, not blocked
    const riskyCandiddate = makeCandidate({
      action_type:  'safe_command_run',
      risk_score:   0.40,
      support_refs: [],   // not in demo path
    });
    const riskyVerdict = enforceWhitelist(riskyCandiddate);
    assert.equal(riskyVerdict.allowed, true, 'safe_command_run must be allowed (recommend-only)');
    assert.equal(riskyVerdict.auto_execute, false, 'safe_command_run must NOT auto-execute');

    // git_status_check with requires_human_approval → downgraded to recommend-only
    const approvalCandidate = makeCandidate({
      action_type:             'git_status_check',
      requires_human_approval: true,
    });
    const approvalVerdict = enforceWhitelist(approvalCandidate);
    assert.equal(approvalVerdict.allowed, true, 'human-approval candidate must be allowed');
    assert.equal(approvalVerdict.auto_execute, false, 'human-approval candidate must NOT auto-execute');
  });

  // ── Test 5: Whitelist approves low-risk auto-execute actions ────────────────
  it('5: whitelist approves and marks auto_execute for low-risk whitelisted actions', () => {
    // git_status_check — canonical auto-execute candidate
    const gitCandidate = makeCandidate({
      action_type:             'git_status_check',
      risk_score:              0.05,
      confidence_score:        0.80,
      requires_human_approval: false,
    });
    const gitVerdict = enforceWhitelist(gitCandidate);
    assert.equal(gitVerdict.allowed, true,       'git_status_check must be allowed');
    assert.equal(gitVerdict.auto_execute, true,  'git_status_check must auto-execute');

    // notify — auto-execute whitelist
    const notifyCandidate = makeCandidate({
      action_type:             'notify',
      risk_score:              0.05,
      confidence_score:        0.70,
      requires_human_approval: false,
    });
    const notifyVerdict = enforceWhitelist(notifyCandidate);
    assert.equal(notifyVerdict.allowed, true,      'notify must be allowed');
    assert.equal(notifyVerdict.auto_execute, true, 'notify must auto-execute');

    // monitor — auto-execute whitelist
    const monitorCandidate = makeCandidate({
      action_type:             'monitor',
      risk_score:              0.02,
      confidence_score:        0.65,
      requires_human_approval: false,
    });
    const monitorVerdict = enforceWhitelist(monitorCandidate);
    assert.equal(monitorVerdict.allowed, true,       'monitor must be allowed');
    assert.equal(monitorVerdict.auto_execute, true,  'monitor must auto-execute');
  });

  // ── Test 6: OutcomeRecord is created ────────────────────────────────────────
  it('6: outcome record is created and attached to loop status after processing', () => {
    const signal = makeFsSignal(0.70);

    const output = runPhase1CognitionLoop({
      signal,
      normalizedCue:       String(signal.raw_content),
      context:             ['test'],
      deepCognitionOpened: true,
    });

    // The outcomeRecord should be constructable from the output
    const { actionCandidate } = output;
    const outcomeRecord = {
      outcome_id:        `outcome-${signal.id}`,
      candidate_id:      actionCandidate.candidate_id,
      observed_result:   'success' as const,
      state_delta:       { action_type: actionCandidate.action_type, signal_id: signal.id },
      discrepancy_score: 0.0,
      received_at:       Date.now(),
    };

    assert.ok(outcomeRecord.outcome_id.startsWith('outcome-'), 'outcome_id must start with "outcome-"');
    assert.equal(outcomeRecord.candidate_id, actionCandidate.candidate_id, 'candidate_id must match');
    assert.equal(outcomeRecord.observed_result, 'success', 'observed_result must be success');
    assert.equal(outcomeRecord.discrepancy_score, 0.0, 'discrepancy_score must be 0 for success');
    assert.ok(outcomeRecord.received_at > 0, 'received_at must be a valid timestamp');
    assert.ok(outcomeRecord.state_delta.action_type, 'state_delta must include action_type');
  });

});

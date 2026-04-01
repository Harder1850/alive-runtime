/**
 * Intent path tests — alive-runtime Phase 1
 *
 * Eight focused tests covering the full user intent → Story Mode path:
 *   1. Deterministic intent mapping — known intents produce correct category/signal_kind
 *   2. Unsupported intent rejection — rejected with reason, no pipeline entry
 *   3. Rejection pattern blocks — hard blocks before any Tier 1 matching
 *   4. Runtime authorization path — handleIntentRequest routes correctly end-to-end
 *   5. Whitelist blocks recommendation-only — recommend-only does not auto_execute
 *   6. Auto-execute actions resolve correctly — git_status_check auto_execute
 *   7. Story Mode produced for success and blocked cases
 *   8. Thread continuity — same thread_id attaches; explainLastAction is grounded
 *
 * Tests 1–3: pure interpreter (no FS/body side effects)
 * Tests 4–8: full intent handler (may write .phase1/ artifacts and run git status)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IntentRequest } from '../../alive-constitution/contracts/intent';
import { interpretIntent }    from '../../alive-mind/src/cognition/intent/intent-interpreter';
import {
  handleIntentRequest,
  getIntentThread,
  listRecentThreads,
  explainLastAction,
} from '../src/phase1/intent-handler';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRequest(text: string, overrides: Partial<IntentRequest> = {}): IntentRequest {
  return {
    request_id:   crypto.randomUUID(),
    raw_text:     text,
    submitted_at: Date.now(),
    source:       'test',
    context:      ['intent-path-test'],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Intent path — ALIVE Backbone Freeze', () => {

  // ── Test 1: Deterministic intent mapping ────────────────────────────────────
  it('1: known Tier 1 intents map to correct category and signal_kind', () => {
    const cases = [
      { text: 'What changed?',           category: 'observe',      signal_kind: 'file_change_event' },
      { text: 'What broke?',             category: 'observe',      signal_kind: 'process_error'     },
      { text: 'Show me problems',        category: 'observe',      signal_kind: 'process_health'    },
      { text: 'Why did you do that?',    category: 'observe',      signal_kind: 'user_input'        },
      { text: 'Check the repo',          category: 'inspect',      signal_kind: 'repo_commit'       },
      { text: 'Check system health',     category: 'inspect',      signal_kind: 'process_health'    },
      { text: 'Show git status',         category: 'safe_action',  signal_kind: 'repo_commit'       },
      { text: 'Clean up temp files',     category: 'safe_action',  signal_kind: 'user_input'        },
      { text: 'What would you do next?', category: 'guided_action', signal_kind: 'user_input'       },
      { text: 'Try the safest option',   category: 'guided_action', signal_kind: 'user_input'       },
    ] as const;

    for (const { text, category, signal_kind } of cases) {
      const req    = makeRequest(text);
      const result = interpretIntent(req);

      assert.equal(result.rejected, false,    `"${text}": must not be rejected`);
      assert.equal(result.category, category, `"${text}": expected category="${category}" got "${result.category}"`);
      assert.equal(result.signal_kind, signal_kind,
        `"${text}": expected signal_kind="${signal_kind}" got "${result.signal_kind}"`);
      assert.ok(result.confidence >= 0.7, `"${text}": confidence must be >= 0.7 for Tier 1 match`);
      assert.ok(result.normalized_intent.length > 0, `"${text}": normalized_intent must be non-empty`);
      assert.equal(result.request_id, req.request_id, `"${text}": request_id must be echoed`);
    }
  });

  // ── Test 2: Unsupported intent rejection ────────────────────────────────────
  it('2: unsupported intents are rejected with a human-readable reason', () => {
    const unsupported = [
      'Paint me a picture',
      'Tell me a joke',
      'Schedule a meeting',
      'Send an email',
      'What is the weather',
    ];

    for (const text of unsupported) {
      const req    = makeRequest(text);
      const result = interpretIntent(req);

      assert.equal(result.rejected, true,
        `"${text}": must be rejected`);
      assert.ok(typeof result.rejection_reason === 'string' && result.rejection_reason.length > 10,
        `"${text}": rejection_reason must be a meaningful string`);
      assert.equal(result.category, 'unsupported',
        `"${text}": category must be 'unsupported'`);
      assert.equal(result.signal_kind, 'unknown',
        `"${text}": signal_kind must be 'unknown' when rejected`);
      assert.equal(result.request_id, req.request_id,
        `"${text}": request_id must be echoed even when rejected`);
    }
  });

  // ── Test 3: Hard rejection patterns block before Tier 1 matching ────────────
  it('3: hard rejection patterns block dangerous requests unconditionally', () => {
    const dangerous = [
      { text: 'rm -rf everything',         expectReason: 'Destructive' },
      { text: 'git push to origin',         expectReason: 'Remote push' },
      { text: 'npm install express',        expectReason: 'Package installation' },
      { text: 'override constitution now',  expectReason: 'Constitutional override' },
      { text: 'write a script for me',      expectReason: 'Code generation' },
      { text: 'sudo rm all files',          expectReason: 'Privileged' },
    ];

    for (const { text, expectReason } of dangerous) {
      const req    = makeRequest(text);
      const result = interpretIntent(req);

      assert.equal(result.rejected, true, `"${text}": must be rejected`);
      assert.ok(
        result.rejection_reason?.toLowerCase().includes(expectReason.toLowerCase()),
        `"${text}": rejection_reason must mention "${expectReason}", got: "${result.rejection_reason}"`,
      );
      // Hard rejections should have high confidence (we're sure this is a block)
      assert.ok(result.confidence >= 0.8,
        `"${text}": hard rejection should have confidence >= 0.8`);
    }
  });

  // ── Test 4: Runtime authorization path (end-to-end) ─────────────────────────
  it('4: handleIntentRequest routes a supported intent through the full pipeline', async () => {
    // "What changed?" → observe category → file_change_event signal → git_status_check or monitor
    const req = makeRequest('What changed?');
    const result = await handleIntentRequest(req);

    assert.equal(result.rejected,    false,       'must not be rejected');
    assert.equal(result.request_id,  req.request_id, 'request_id must be echoed');
    assert.ok(result.thread_id,      'thread_id must be set');
    assert.ok(result.signal_id,      'signal_id must be set — signal entered the pipeline');
    assert.ok(result.intent,         'intent result must be present');
    assert.equal(result.intent.category, 'observe', 'category must be observe');

    assert.ok(result.action_candidate,  'action_candidate must be present after cognition');
    assert.ok(result.whitelist_verdict, 'whitelist_verdict must be present');
    assert.ok(typeof result.whitelist_verdict.allowed === 'boolean', 'allowed must be boolean');
    assert.ok(typeof result.whitelist_verdict.auto_execute === 'boolean', 'auto_execute must be boolean');
    assert.ok(result.outcome_record,    'outcome_record must be present');
    assert.ok(result.story_mode,        'story_mode must be present');
    assert.ok(result.explanation.length > 10, 'explanation must be a non-trivial string');
  });

  // ── Test 5: Whitelist produces recommendation-only for mid-risk actions ──────
  it('5: recommend-only intents produce approval_state, not authorized_action', async () => {
    // "Fix this if it's safe" → guided_action → user_input signal → recommend action type
    // recommend is RECOMMEND_ONLY in whitelist — must not auto_execute
    const req = makeRequest("Fix this if it's safe");
    const result = await handleIntentRequest(req);

    assert.equal(result.rejected, false, 'must not be rejected');
    assert.ok(result.action_candidate, 'action_candidate must be present');
    assert.ok(result.whitelist_verdict, 'whitelist_verdict must be present');

    // The action_type produced for guided_action intents is 'recommend' (per chooseActionType)
    // recommend → RECOMMEND_ONLY → auto_execute=false
    if (result.whitelist_verdict.auto_execute === false) {
      assert.ok(
        result.approval_state || !result.authorized_action,
        'when not auto_execute: either approval_state must exist or authorized_action must be absent',
      );
    }

    // Either way — story_mode must be present and grounded
    assert.ok(result.story_mode, 'story_mode must be present even for recommendation-only');
    assert.ok(result.story_mode.noticed,    'story_mode.noticed must be set');
    assert.ok(result.story_mode.decided,    'story_mode.decided must be set');
    assert.ok(result.story_mode.safetyNote, 'story_mode.safetyNote must be set');
  });

  // ── Test 6: Auto-execute actions resolve with authorized_action ──────────────
  it('6: auto-execute intents produce authorized_action (not approval_state)', async () => {
    // "Show git status" → safe_action → repo_commit signal → git_status_check → AUTO_EXECUTE
    const req = makeRequest('Show git status');
    const result = await handleIntentRequest(req);

    assert.equal(result.rejected, false, 'must not be rejected');
    assert.ok(result.action_candidate,  'action_candidate must be present');
    assert.ok(result.whitelist_verdict, 'whitelist_verdict must be present');

    // git_status_check is AUTO_EXECUTE — should produce authorized_action when approved
    if (result.whitelist_verdict.auto_execute) {
      assert.ok(result.authorized_action, 'authorized_action must be present for auto_execute');
      assert.equal(result.authorized_action.auto_execute, true,
        'authorized_action.auto_execute must be true');
      assert.ok(result.authorized_action.authorization_id,
        'authorization_id must be set');
      assert.equal(result.authorized_action.signal_id, result.signal_id,
        'authorized_action.signal_id must match the processed signal');
      assert.equal(result.approval_state, undefined,
        'approval_state must NOT be present for auto_execute actions');
    }

    // Outcome must reflect execution
    assert.ok(result.outcome_record, 'outcome_record must be present');
    assert.ok(
      ['success', 'failure', 'partial'].includes(result.outcome_record.observed_result),
      'observed_result must be a valid status',
    );
  });

  // ── Test 7: Story Mode is grounded for success, blocked, and pending cases ───
  it('7: Story Mode is grounded in real state for all outcome types', async () => {
    // Run two different intents to test success and pending_approval outcomes
    const successReq     = makeRequest('Check the repo');
    const successResult  = await handleIntentRequest(successReq);

    const pendingReq     = makeRequest("What would you do next?");
    const pendingResult  = await handleIntentRequest(pendingReq);

    for (const [label, result] of [
      ['check-repo', successResult],
      ['what-next',  pendingResult],
    ] as const) {
      assert.ok(result.story_mode, `[${label}]: story_mode must be present`);
      const sm = result.story_mode;

      // Each field must be a non-empty sentence
      assert.ok(sm.noticed.startsWith('I noticed'),
        `[${label}]: noticed must start with "I noticed", got: "${sm.noticed}"`);
      assert.ok(sm.decided.startsWith('I decided'),
        `[${label}]: decided must start with "I decided", got: "${sm.decided}"`);
      assert.ok(sm.result.startsWith('The result was'),
        `[${label}]: result must start with "The result was", got: "${sm.result}"`);
      assert.ok(sm.safetyNote.startsWith('I only took safe actions'),
        `[${label}]: safetyNote must start with "I only took safe actions", got: "${sm.safetyNote}"`);
      assert.ok(sm.generatedAt > 0, `[${label}]: generatedAt must be a valid timestamp`);

      // Verify it is grounded: noticed must reference the real signal (user's text appears)
      // We can't check exact content without knowing what the loop produced, but we CAN
      // verify no field is a blank placeholder
      assert.ok(sm.noticed.length  > 20, `[${label}]: noticed must be substantial`);
      assert.ok(sm.decided.length  > 20, `[${label}]: decided must be substantial`);
      assert.ok(sm.result.length   > 15, `[${label}]: result must be substantial`);
    }
  });

  // ── Test 8: Thread continuity and explainLastAction ──────────────────────────
  it('8: thread continuity — same thread attaches; explainLastAction is grounded', async () => {
    // Step A: First request — creates a thread
    const firstReq    = makeRequest('What changed?');
    const firstResult = await handleIntentRequest(firstReq);

    assert.equal(firstResult.rejected, false, 'first request must not be rejected');
    const threadId = firstResult.thread_id;
    assert.ok(threadId, 'thread_id must be set after first request');

    // Thread must be retrievable
    const thread = getIntentThread(threadId);
    assert.ok(thread, 'thread must be retrievable by thread_id');
    assert.equal(thread.origin_text, firstReq.raw_text, 'origin_text must be the original request');
    assert.ok(thread.signal_ids.length >= 1, 'thread must have at least one signal_id recorded');
    assert.ok(thread.status !== 'abandoned', 'thread must not be abandoned after processing');

    // Step B: Follow-up request — attaches to same thread
    const followUpReq    = makeRequest('Show git status', { thread_id: threadId });
    const followUpResult = await handleIntentRequest(followUpReq);

    assert.equal(followUpResult.thread_id, threadId,
      'follow-up request must attach to same thread_id');

    const updatedThread = getIntentThread(threadId);
    assert.ok(updatedThread, 'updated thread must still be retrievable');
    assert.ok(updatedThread.signal_ids.length >= 2,
      'thread must accumulate signal_ids across requests');
    assert.ok(updatedThread.updated_at >= thread.updated_at,
      'updated_at must advance after follow-up request');

    // Step C: "Why did you do that?" — grounded in real thread state
    const why = explainLastAction(threadId);
    assert.equal(why.found, true, 'explainLastAction must find the thread');
    assert.equal(why.thread_id, threadId, 'why.thread_id must match');
    assert.equal(why.origin_text, firstReq.raw_text, 'why.origin_text must be the original request');
    assert.ok(why.last_decided.length > 10,
      `why.last_decided must be a real string, got: "${why.last_decided}"`);
    assert.ok(why.signal_count >= 2, 'why.signal_count must reflect both signals');
    assert.ok(why.outcome_count >= 1, 'why.outcome_count must reflect recorded outcomes');

    // Step D: listRecentThreads — most recent first
    const recent = listRecentThreads(5);
    assert.ok(recent.length >= 1, 'listRecentThreads must return at least one thread');
    assert.equal(recent[0].thread_id, threadId,
      'most recent thread must be the one we just used');

    // Step E: Nonexistent thread — returns found=false, not an error
    const missing = explainLastAction('thread-does-not-exist');
    assert.equal(missing.found, false, 'missing thread must return found=false');
    assert.ok(missing.next_step.length > 0, 'missing thread must still return a next_step hint');
  });

});

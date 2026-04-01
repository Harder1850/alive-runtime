/**
 * Intent Handler — alive-runtime Phase 1
 *
 * Entry point for user-driven plain-language requests.
 * Routes them through the full governed pipeline:
 *   IntentRequest → interpretIntent (mind) → Signal → processPhase1Signal
 *   → whitelist → body execution → thread update → IntentHandlerResult
 *
 * Design rules:
 *   - Never bypasses the existing pipeline (firewall → STG → whitelist → body)
 *   - Runtime is still the choke point — body gets authorized actions only
 *   - Thread continuity is runtime-layer business state (not mind memory)
 *   - "Why did you do that?" path is grounded in real thread state only
 *   - Rejected intents return immediately — no signal, no cognition, no execution
 */

import crypto from "node:crypto";

import type { IntentRequest, IntentResult } from "../../../alive-constitution/contracts/intent";
import type { AuthorizedAction, ApprovalState } from "../../../alive-constitution/contracts/authorized-action";
import type { IntentThread } from "../../../alive-constitution/contracts/intent-thread";
import { makeSignal } from "../../../alive-constitution/contracts/signal";
import type { Signal } from "../../../alive-constitution/contracts/signal";

import { interpretIntent } from "../../../alive-mind/src/cognition/intent/intent-interpreter";

import { processPhase1Signal, getPhase1LoopStatus } from "./phase1-runtime";
import type { ActionCandidate, OutcomeRecord, StoryModeSummary } from "./proving-types";
import type { WhitelistVerdict } from "./action-whitelist";

// ── Result shape ───────────────────────────────────────────────────────────────

export interface IntentHandlerResult {
  /** Echoes IntentRequest.request_id. */
  request_id: string;

  /** Thread this request was attached to or created. */
  thread_id: string;

  /** What the intent interpreter concluded. */
  intent: IntentResult;

  /** The Signal built from the intent and routed through the pipeline. Null if rejected. */
  signal_id: string | null;

  /** ActionCandidate from mind cognition — present when signal was processed. */
  action_candidate?: ActionCandidate;

  /** Whitelist enforcement verdict. Present when action_candidate is present. */
  whitelist_verdict?: WhitelistVerdict;

  /** Created when whitelist approved auto_execute. Present only for approved actions. */
  authorized_action?: AuthorizedAction;

  /** Outcome record from the processing cycle. Present when signal was processed. */
  outcome_record?: OutcomeRecord;

  /**
   * Approval state for actions that require human review before execution.
   * Present when whitelist said RECOMMEND_ONLY with requires_human_approval.
   */
  approval_state?: ApprovalState;

  /** Story Mode summary for non-technical observers. Present after successful processing. */
  story_mode?: StoryModeSummary;

  /** true when the intent was rejected before entering the pipeline. */
  rejected: boolean;

  /** Human-readable reason if rejected. Always present when rejected === true. */
  rejection_reason?: string;

  /** Grounded one-paragraph explanation of what happened. */
  explanation: string;
}

// ── "Why did you do that?" result ─────────────────────────────────────────────

export interface WhyExplanation {
  thread_id: string;
  origin_text: string;
  last_decided: string;
  next_step: string;
  outcome_count: number;
  signal_count: number;
  found: boolean;
}

// ── Thread registry (module-level singleton) ───────────────────────────────────
// Lightweight in-process continuity store. Survives across handleIntentRequest calls.
// Does not replace alive-mind's ThreadStore — that stores cognitive encoding records.
// This stores business-level intent conversation state.

const intentThreads = new Map<string, IntentThread>();

// ── Thread management ──────────────────────────────────────────────────────────

function createThread(intentResult: IntentResult, req: IntentRequest): IntentThread {
  const thread: IntentThread = {
    thread_id:        `thread-${req.request_id}`,
    intent_category:  intentResult.category,
    started_at:       req.submitted_at,
    updated_at:       Date.now(),
    signal_ids:       [],
    outcome_ids:      [],
    status:           "active",
    origin_text:      req.raw_text,
  };
  intentThreads.set(thread.thread_id, thread);
  return thread;
}

function attachOrCreateThread(req: IntentRequest, intentResult: IntentResult): IntentThread {
  if (req.thread_id) {
    const existing = intentThreads.get(req.thread_id);
    if (existing) {
      const updated: IntentThread = { ...existing, updated_at: Date.now(), status: "active" };
      intentThreads.set(req.thread_id, updated);
      return updated;
    }
  }
  return createThread(intentResult, req);
}

function updateThread(thread: IntentThread, updates: Partial<IntentThread>): IntentThread {
  const updated: IntentThread = { ...thread, ...updates, updated_at: Date.now() };
  intentThreads.set(thread.thread_id, updated);
  return updated;
}

// ── Signal builder ─────────────────────────────────────────────────────────────

function buildSignalFromIntent(req: IntentRequest, intent: IntentResult): Signal {
  return makeSignal({
    id:              crypto.randomUUID(),
    source:          "system_api",
    kind:            intent.signal_kind !== "unknown" ? intent.signal_kind : "user_input",
    raw_content:     req.raw_text,
    timestamp:       req.submitted_at,
    // guided_action is highest urgency — user is asking for next step
    urgency:         intent.category === "guided_action" ? 0.75
                   : intent.category === "observe"       ? 0.65
                   : 0.50,
    novelty:         0.60,   // user requests are always somewhat novel
    confidence:      intent.confidence,
    quality_score:   intent.confidence,
    threat_flag:     false,
    firewall_status: "cleared",  // intent requests are user-initiated and already validated
    payload: {
      intent_request_id: req.request_id,
      intent_category:   intent.category,
      normalized_intent: intent.normalized_intent,
      thread_id:         req.thread_id ?? null,
      ...intent.parameters,
    },
  });
}

// ── AuthorizedAction builder ───────────────────────────────────────────────────

function buildAuthorizedAction(
  candidate: ActionCandidate,
  verdict: { reason: string },
  signalId: string,
): AuthorizedAction {
  return {
    authorization_id:   `auth-${candidate.candidate_id}-${Date.now()}`,
    candidate_id:       candidate.candidate_id,
    action_type:        candidate.action_type,
    authorized_at:      Date.now(),
    auto_execute:       true,
    executor_hint:      candidate.rationale.slice(0, 200),
    authorization_reason: verdict.reason,
    signal_id:          signalId,
  };
}

// ── ApprovalState builder ──────────────────────────────────────────────────────

function buildApprovalState(
  candidate: ActionCandidate,
  threadId: string,
  reason: string,
): ApprovalState {
  return {
    approval_id:     `approval-${candidate.candidate_id}-${Date.now()}`,
    candidate_id:    candidate.candidate_id,
    thread_id:       threadId,
    action_summary:  `${candidate.action_type}: ${candidate.rationale.slice(0, 120)}`,
    approval_reason: reason,
    requested_at:    Date.now(),
    status:          "pending",
    ttl_ms:          300_000,  // 5 minutes
  };
}

// ── Explanation builder ────────────────────────────────────────────────────────
// Grounded — each clause maps to a real field. No fabricated reasoning.

function buildExplanation(
  intent: IntentResult,
  storyMode: StoryModeSummary | undefined,
  rejected: boolean,
  rejectionReason?: string,
): string {
  if (rejected) {
    return `Request not processed: ${rejectionReason ?? "unsupported intent."}`;
  }
  if (storyMode) {
    // Three story sentences give a grounded summary: what happened, what was decided, result
    return [storyMode.noticed, storyMode.decided, storyMode.result]
      .filter(Boolean)
      .join(" ");
  }
  return `Processed intent "${intent.normalized_intent}" (category: ${intent.category}).`;
}

// ── Main entry point ───────────────────────────────────────────────────────────

export async function handleIntentRequest(
  req: IntentRequest,
): Promise<IntentHandlerResult> {

  // ── [1] Interpret the plain-language request ───────────────────────────────
  const intent = interpretIntent(req);

  // ── [2] Reject unsupported intents — no signal, no cognition ──────────────
  if (intent.rejected) {
    return {
      request_id:       req.request_id,
      thread_id:        `thread-${req.request_id}`,
      intent,
      signal_id:        null,
      rejected:         true,
      rejection_reason: intent.rejection_reason,
      explanation:      `Request not processed: ${intent.rejection_reason ?? "unsupported intent."}`,
    };
  }

  // ── [3] Create or attach to intent thread ──────────────────────────────────
  let thread = attachOrCreateThread(req, intent);

  // ── [4] Build signal and route through the governed pipeline ───────────────
  const signal = buildSignalFromIntent(req, intent);
  thread = updateThread(thread, { signal_ids: [...thread.signal_ids, signal.id] });

  // Flag explicit task / user request so the cognition loop opens deep cognition
  const isExplicitTask = intent.category === "safe_action";
  const isUserRequest  = intent.category === "guided_action" || intent.category === "observe";

  await processPhase1Signal({
    signal,
    context:      req.context ?? [],
    explicitTask: isExplicitTask,
    userRequest:  isUserRequest,
  });

  // ── [5] Read results from updated loop status ──────────────────────────────
  // processPhase1Signal writes to the module-level status singleton.
  const loopStatus      = getPhase1LoopStatus();
  const actionCandidate = loopStatus.actionCandidate;
  const whitelistVerdict = loopStatus.whitelistVerdict as WhitelistVerdict | undefined;
  const outcomeRecord   = loopStatus.lastOutcomeRecord;
  const storyMode       = loopStatus.storyMode;

  // ── [6] Build AuthorizedAction or ApprovalState ────────────────────────────
  let authorizedAction: AuthorizedAction | undefined;
  let approvalState:    ApprovalState    | undefined;

  if (actionCandidate && whitelistVerdict) {
    if (whitelistVerdict.auto_execute && whitelistVerdict.allowed) {
      // Auto-executed — record what was authorized
      authorizedAction = buildAuthorizedAction(actionCandidate, whitelistVerdict, signal.id);
    } else if (whitelistVerdict.allowed && !whitelistVerdict.auto_execute) {
      // Recommendation-only — human review required
      approvalState = buildApprovalState(actionCandidate, thread.thread_id, whitelistVerdict.reason);
    }
  }

  // ── [7] Update thread continuity ──────────────────────────────────────────
  const outcomeUpdates: Partial<IntentThread> = {
    status:       approvalState ? "pending_approval" : "resolved",
    last_decided: storyMode?.decided,
    next_step:    loopStatus.demoExplanation?.next_step,
  };
  if (outcomeRecord) {
    outcomeUpdates.outcome_ids = [...thread.outcome_ids, outcomeRecord.outcome_id];
  }
  thread = updateThread(thread, outcomeUpdates);

  // ── [8] Return result ──────────────────────────────────────────────────────
  return {
    request_id:        req.request_id,
    thread_id:         thread.thread_id,
    intent,
    signal_id:         signal.id,
    action_candidate:  actionCandidate,
    whitelist_verdict: whitelistVerdict,
    authorized_action: authorizedAction,
    outcome_record:    outcomeRecord,
    approval_state:    approvalState,
    story_mode:        storyMode,
    rejected:          false,
    explanation:       buildExplanation(intent, storyMode, false),
  };
}

// ── Thread accessors ───────────────────────────────────────────────────────────

export function getIntentThread(threadId: string): IntentThread | undefined {
  return intentThreads.get(threadId);
}

export function listRecentThreads(limit = 10): IntentThread[] {
  return [...intentThreads.values()]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, limit);
}

// ── "Why did you do that?" ─────────────────────────────────────────────────────
// Grounded answer path — reads only real thread state.

export function explainLastAction(threadId?: string): WhyExplanation {
  const thread = threadId
    ? intentThreads.get(threadId)
    : listRecentThreads(1)[0];

  if (!thread) {
    return {
      thread_id:     threadId ?? "(none)",
      origin_text:   "",
      last_decided:  "",
      next_step:     "No recent activity to explain.",
      outcome_count: 0,
      signal_count:  0,
      found:         false,
    };
  }

  return {
    thread_id:     thread.thread_id,
    origin_text:   thread.origin_text,
    last_decided:  thread.last_decided ?? "No decision recorded yet.",
    next_step:     thread.next_step    ?? "No next step recorded.",
    outcome_count: thread.outcome_ids.length,
    signal_count:  thread.signal_ids.length,
    found:         true,
  };
}

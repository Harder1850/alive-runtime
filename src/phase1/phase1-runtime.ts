import fs from "node:fs/promises";
import path from "node:path";

import type { Signal } from "../../../alive-constitution/contracts/signal";
import {
  getPhase1MemorySnapshot,
  getPhase1StudioMemoryBridgeSnapshot,
  pushPhase1Outcome,
  runPhase1CognitionLoop,
  type Phase1CognitionOutput,
  type ActionCandidate,
} from "../../../alive-mind/src/spine/phase1-cognition-loop";

import { enforceWhitelist, type WhitelistVerdict } from "./action-whitelist";
import {
  mapSourceType,
  confidenceTone,
  type ProvidedSignal,
  type ActionCandidate as RuntimeActionCandidate,
  type OutcomeRecord,
  type DemoExplanation,
  type StoryModeSummary,
} from "./proving-types";
import {
  executeProvingAction,
  type ProvingActionType,
} from "../../../alive-body/src/actuators/proving-executor";

// ── Loop status shape ─────────────────────────────────────────────────────────

export interface Phase1LoopStatus {
  mode: "baseline" | "deep";
  deepCognitionOpened?: boolean;
  lastSignal?: { id: string; kind: string; source: string; raw: string; ts: number };
  providedSignal?: ProvidedSignal;
  triageDecision?: { novelty: number; relevance: number; contradictionCandidate: boolean; openedDeep: boolean };
  lastCandidateAction?: string;
  lastCandidateSummary?: string;
  lastSummary?: string;
  lastReasoningSummary?: string;
  actionCandidate?: RuntimeActionCandidate;
  whitelistVerdict?: { allowed: boolean; auto_execute: boolean; reason: string };
  demoExplanation?: DemoExplanation;
  lastOutcome?: { success: boolean; note: string; timestamp: number };
  lastOutcomeRecord?: OutcomeRecord;
  storyMode?: StoryModeSummary;
  stageTimestamps?: Record<string, number>;
  updatedAt?: number;
  warnings?: string[];
  errors?: string[];
}

// ── File paths ────────────────────────────────────────────────────────────────

const phase1Dir      = path.resolve(__dirname, "../../.phase1");
const loopStatusFile = path.join(phase1Dir, "loop-status.json");
const memoryStatusFile = path.join(phase1Dir, "memory-snapshot.json");

const status: Phase1LoopStatus = { mode: "baseline" };

// ── Signal classification helpers ─────────────────────────────────────────────

function noveltyOf(signal: Signal): number {
  const n = signal.novelty ?? 0;
  if (n > 0) return n;
  const raw = String(signal.raw_content ?? "").toLowerCase();
  return raw.includes("new") || raw.includes("unexpected") ? 0.8 : 0.35;
}

function relevanceOf(signal: Signal): number {
  const urgency = signal.urgency ?? 0.4;
  const quality = signal.quality_score ?? 0.6;
  return Math.max(0, Math.min(1, urgency * 0.6 + quality * 0.4));
}

function contradictionCandidate(signal: Signal): boolean {
  const raw = String(signal.raw_content ?? "").toLowerCase();
  return raw.includes("contradiction") || raw.includes("mismatch") || raw.includes("failed");
}

export function shouldOpenDeepCognition(input: {
  signal: Signal;
  explicitTask?: boolean;
  userRequest?: boolean;
}): boolean {
  const novelty      = noveltyOf(input.signal);
  const relevance    = relevanceOf(input.signal);
  const contradiction = contradictionCandidate(input.signal);
  return Boolean(input.explicitTask || input.userRequest || contradiction || novelty >= 0.65 || relevance >= 0.7);
}

// ── ProvidedSignal builder ────────────────────────────────────────────────────

function buildProvidedSignal(signal: Signal): ProvidedSignal {
  const payload = signal.payload
    ? JSON.stringify(signal.payload).slice(0, 200)
    : String(signal.raw_content ?? "").slice(0, 200);

  return {
    signal_id:   signal.id,
    source_type: mapSourceType(signal.source),
    event_type:  signal.kind,
    observed_at: signal.timestamp,
    quality_score: signal.quality_score ?? 1.0,
    payload_ref: payload,
    summary:     `${signal.source}/${signal.kind}: ${String(signal.raw_content ?? "").slice(0, 100)}`,
    thread_hint: null,
  };
}

// ── DemoExplanation builder ───────────────────────────────────────────────────
// Every field is grounded in real runtime/mind state — no fabricated reasoning.

function buildDemoExplanation(
  signal: Signal,
  output: Phase1CognitionOutput,
  verdict: WhitelistVerdict,
  execOutput: string | null,
): DemoExplanation {
  const { actionCandidate, deepCognitionOpened, recalledItems } = output;
  const tone = confidenceTone(actionCandidate.confidence_score);

  let notice: string;
  let reason: string;
  let next_step: string | undefined;

  if (!verdict.allowed) {
    notice    = `Signal received (${signal.kind}) — no action taken.`;
    reason    = verdict.reason;
    next_step = "Review the signal manually if it seems important.";
  } else if (verdict.auto_execute && execOutput !== null) {
    notice    = `${actionCandidate.action_type.replace(/_/g, " ")} executed automatically.`;
    reason    = actionCandidate.rationale;
    next_step = execOutput.slice(0, 140);
  } else {
    notice    = `Recommendation: ${actionCandidate.action_type.replace(/_/g, " ")}.`;
    reason    = actionCandidate.rationale;
    next_step = "Review recommendation and decide whether to act.";
  }

  if (deepCognitionOpened && recalledItems.length > 0) {
    reason += ` (${recalledItems.length} memory items informed this decision.)`;
  }

  return { notice, reason, confidence_tone: tone, next_step };
}

// ── OutcomeRecord builder ─────────────────────────────────────────────────────

function buildOutcomeRecord(
  candidate: ActionCandidate,
  execResult: { success: boolean; output: string; executed: boolean } | null,
  signalId: string,
): OutcomeRecord {
  const success  = execResult?.success ?? true;
  const executed = execResult?.executed ?? false;

  return {
    outcome_id:        `outcome-${signalId}-${Date.now()}`,
    candidate_id:      candidate.candidate_id,
    observed_result:   executed ? (success ? "success" : "failure") : "partial",
    state_delta: {
      action_type:  candidate.action_type,
      executed,
      output:       execResult?.output?.slice(0, 300) ?? "recommendation-only",
      signal_id:    signalId,
    },
    discrepancy_score: success ? 0.0 : 0.4,
    received_at:       Date.now(),
  };
}

// ── StoryMode builder ─────────────────────────────────────────────────────────
// Translates technical state into plain language a non-technical user understands.
// Uses only real data — the five sentences map directly to real fields.

function buildStoryMode(
  signal: Signal,
  output: Phase1CognitionOutput,
  verdict: WhitelistVerdict,
  outcomeRecord: OutcomeRecord,
): StoryModeSummary {
  const { actionCandidate, recalledItems, deepCognitionOpened } = output;
  const raw = String(signal.raw_content ?? "").slice(0, 100);

  // "I noticed..."
  // Grounded in: signal.source, signal.kind, signal.raw_content
  const signalLabel = signal.kind.replace(/_/g, " ");
  const noticed = `I noticed a ${signalLabel} from ${signal.source}: "${raw}".`;

  // "It looked like..."
  // Grounded in: deepCognitionOpened, recalledItems.length, actionCandidate.rationale
  const depthNote = deepCognitionOpened
    ? `I looked deeper and found ${recalledItems.length} related memories.`
    : `I made a quick check — no prior memories were closely related.`;
  // Take the descriptive clause before "—", strip metadata markers like "(N memory items recalled)" and "[deep cognition]"
  const rationaleCore = actionCandidate.rationale.split("—")[0]
    .replace(/\s*\(\d+ memory items? recalled\)/g, "")
    .replace(/\s*\[.*?\]/g, "")
    .trim();
  const lookedLike = `${depthNote} ${rationaleCore || actionCandidate.rationale.slice(0, 100)}.`.replace(/\.\.$/, ".");

  // "I decided to..."
  // Grounded in: actionCandidate.action_type, verdict.auto_execute, verdict.reason
  const actionLabel = actionCandidate.action_type.replace(/_/g, " ");
  const executionNote = verdict.auto_execute
    ? `I ran it automatically because it was low-risk (risk score: ${actionCandidate.risk_score.toFixed(2)}).`
    : `I did not run it automatically — I recorded it as a recommendation for you to review.`;
  const decided = `I decided to ${actionLabel}. ${executionNote}`;

  // "The result was..."
  // Grounded in: outcomeRecord.observed_result, outcomeRecord.state_delta.output
  const execOutput = typeof outcomeRecord.state_delta.output === "string"
    ? outcomeRecord.state_delta.output.slice(0, 120)
    : null;
  const resultLabel = outcomeRecord.observed_result === "success"
    ? "successful"
    : outcomeRecord.observed_result === "partial"
      ? "recorded as a recommendation (not executed)"
      : outcomeRecord.observed_result;
  const result = execOutput
    ? `The result was ${resultLabel}: ${execOutput}.`
    : `The result was ${resultLabel}.`;

  // "I only took safe actions..."
  // Grounded in: verdict.reason, actionCandidate.risk_score, actionCandidate.reversibility_score
  const safetyNote =
    `I only took safe actions. ` +
    `${verdict.reason}. ` +
    `Reversibility: ${(actionCandidate.reversibility_score * 100).toFixed(0)}% ` +
    `(${actionCandidate.reversibility_score >= 0.9 ? "fully reversible" : actionCandidate.reversibility_score >= 0.5 ? "mostly reversible" : "limited reversibility"}).`;

  return { noticed, lookedLike, decided, result, safetyNote, generatedAt: Date.now() };
}

// ── Main processing function ──────────────────────────────────────────────────

export async function processPhase1Signal(input: {
  signal: Signal;
  context?: string[];
  explicitTask?: boolean;
  userRequest?: boolean;
}): Promise<Phase1CognitionOutput> {
  const { signal, context = [] } = input;
  const novelty      = noveltyOf(signal);
  const relevance    = relevanceOf(input.signal);
  const contradiction = contradictionCandidate(signal);
  const deep         = shouldOpenDeepCognition(input);

  // ── [1] Cognition ───────────────────────────────────────────────────────────
  const output = runPhase1CognitionLoop({
    signal,
    normalizedCue: String(signal.raw_content ?? ""),
    context,
    deepCognitionOpened: deep,
  });

  const { actionCandidate } = output;

  // ── [2] Whitelist enforcement ───────────────────────────────────────────────
  const verdict = enforceWhitelist(actionCandidate);

  // ── [3] Body execution (if approved for auto-execute) ──────────────────────
  let execResult: ReturnType<typeof executeProvingAction> | null = null;

  if (verdict.allowed && verdict.auto_execute) {
    try {
      execResult = executeProvingAction(
        actionCandidate.action_type as ProvingActionType,
        actionCandidate.rationale,
        actionCandidate.support_refs,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      execResult = {
        action_type: actionCandidate.action_type as ProvingActionType,
        success: false,
        output: `Executor error: ${msg}`,
        executed: true,
      };
    }
  }

  // ── [4] Build proving-level artifacts ──────────────────────────────────────
  const providedSignal   = buildProvidedSignal(signal);
  const demoExplanation  = buildDemoExplanation(signal, output, verdict, execResult?.output ?? null);
  const outcomeRecord    = buildOutcomeRecord(actionCandidate, execResult, signal.id);

  // Convert mind's ActionCandidate to runtime's ActionCandidate shape (same fields, different import path)
  const runtimeCandidate: RuntimeActionCandidate = {
    candidate_id:           actionCandidate.candidate_id,
    action_type:            actionCandidate.action_type,
    rationale:              actionCandidate.rationale,
    confidence_score:       actionCandidate.confidence_score,
    risk_score:             actionCandidate.risk_score,
    reversibility_score:    actionCandidate.reversibility_score,
    requires_human_approval: actionCandidate.requires_human_approval,
    support_refs:           actionCandidate.support_refs,
  };

  // ── [5] Update status ───────────────────────────────────────────────────────
  status.mode                  = deep ? "deep" : "baseline";
  status.deepCognitionOpened   = output.deepCognitionOpened;
  status.lastSignal            = {
    id:     signal.id,
    kind:   signal.kind,
    source: signal.source,
    raw:    String(signal.raw_content ?? "").slice(0, 300),
    ts:     signal.timestamp,
  };
  status.providedSignal        = providedSignal;
  status.triageDecision        = { novelty, relevance, contradictionCandidate: contradiction, openedDeep: deep };
  status.lastCandidateAction   = output.candidateAction.type;
  status.lastCandidateSummary  =
    output.candidateAction.type === "display_text"
      ? (output.candidateAction as { type: "display_text"; payload: string }).payload.slice(0, 280)
      : `write_file`;
  status.lastSummary           = output.interpretedSummary;
  status.lastReasoningSummary  = output.reasoningSummary;
  status.actionCandidate       = runtimeCandidate;
  status.whitelistVerdict      = { allowed: verdict.allowed, auto_execute: verdict.auto_execute, reason: verdict.reason };
  status.demoExplanation       = demoExplanation;
  status.lastOutcomeRecord     = outcomeRecord;
  status.storyMode             = buildStoryMode(signal, output, verdict, outcomeRecord);
  status.stageTimestamps       = {
    signalReceivedAt:  signal.timestamp,
    loopProcessedAt:   Date.now(),
  };
  status.updatedAt = Date.now();

  await persistPhase1Artifacts();
  return output;
}

// ── Outcome recording ─────────────────────────────────────────────────────────

export async function pushPhase1RuntimeOutcome(input: {
  signalId: string;
  success: boolean;
  note: string;
  timestamp?: number;
}): Promise<void> {
  const ts = input.timestamp ?? Date.now();
  pushPhase1Outcome({ signalId: input.signalId, success: input.success, note: input.note, timestamp: ts });
  status.lastOutcome = { success: input.success, note: input.note, timestamp: ts };
  status.stageTimestamps = {
    ...(status.stageTimestamps ?? {}),
    outcomeRecordedAt: ts,
  };
  status.updatedAt = ts;
  await persistPhase1Artifacts();
}

// ── Accessors ─────────────────────────────────────────────────────────────────

export function getPhase1LoopStatus(): Phase1LoopStatus {
  return { ...status };
}

export function getPhase1MemoryStatus() {
  const raw    = getPhase1MemorySnapshot();
  const bridge = getPhase1StudioMemoryBridgeSnapshot();

  return {
    ...raw,
    workingMemorySample:  bridge.workingMemorySample,
    recentEpisodesSample: bridge.recentEpisodesSample,
    referenceItemSample:  bridge.referenceItemSample,
    threadSummarySample:  bridge.threadSummarySample,
    outcomeBufferSample:  bridge.outcomeBufferSample,
    structuralNodeSample: bridge.structuralNodeSample,
    associationSample:    bridge.associationSample,
    readOnly:     true,
    generatedAt:  Date.now(),
  };
}

// ── Artifact persistence ──────────────────────────────────────────────────────

export async function persistPhase1Artifacts(): Promise<void> {
  await fs.mkdir(phase1Dir, { recursive: true });
  await fs.writeFile(loopStatusFile,   JSON.stringify(getPhase1LoopStatus(),   null, 2), "utf-8");
  await fs.writeFile(memoryStatusFile, JSON.stringify(getPhase1MemoryStatus(), null, 2), "utf-8");
}

export function getPhase1ArtifactPaths() {
  return { loopStatusFile, memoryStatusFile };
}

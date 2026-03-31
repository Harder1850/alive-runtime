import fs from "node:fs/promises";
import path from "node:path";

import type { Signal } from "../../../alive-constitution/contracts/signal";
import {
  getPhase1MemorySnapshot,
  getPhase1StudioMemoryBridgeSnapshot,
  pushPhase1Outcome,
  runPhase1CognitionLoop,
  type Phase1CognitionOutput,
} from "../../../alive-mind/src/spine/phase1-cognition-loop";

export interface Phase1LoopStatus {
  mode: "baseline" | "deep";
  deepCognitionOpened?: boolean;
  lastSignal?: { id: string; kind: string; source: string; raw: string; ts: number };
  triageDecision?: { novelty: number; relevance: number; contradictionCandidate: boolean; openedDeep: boolean };
  lastCandidateAction?: string;
  lastCandidateSummary?: string;
  lastSummary?: string;
  lastReasoningSummary?: string;
  lastOutcome?: { success: boolean; note: string; timestamp: number };
  stageTimestamps?: Record<string, number>;
  updatedAt?: number;
  warnings?: string[];
  errors?: string[];
}

const phase1Dir = path.resolve(__dirname, "../../.phase1");
const loopStatusFile = path.join(phase1Dir, "loop-status.json");
const memoryStatusFile = path.join(phase1Dir, "memory-snapshot.json");

const status: Phase1LoopStatus = { mode: "baseline" };

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
  const novelty = noveltyOf(input.signal);
  const relevance = relevanceOf(input.signal);
  const contradiction = contradictionCandidate(input.signal);
  return Boolean(input.explicitTask || input.userRequest || contradiction || novelty >= 0.65 || relevance >= 0.7);
}

export async function processPhase1Signal(input: {
  signal: Signal;
  context?: string[];
  explicitTask?: boolean;
  userRequest?: boolean;
}): Promise<Phase1CognitionOutput> {
  const { signal, context = [] } = input;
  const novelty = noveltyOf(signal);
  const relevance = relevanceOf(signal);
  const contradiction = contradictionCandidate(signal);
  const deep = shouldOpenDeepCognition(input);

  const output = runPhase1CognitionLoop({
    signal,
    normalizedCue: String(signal.raw_content ?? ""),
    context,
    deepCognitionOpened: deep,
  });

  status.mode = deep ? "deep" : "baseline";
  status.deepCognitionOpened = output.deepCognitionOpened;
  status.lastSignal = {
    id: signal.id,
    kind: signal.kind,
    source: signal.source,
    raw: String(signal.raw_content ?? "").slice(0, 300),
    ts: signal.timestamp,
  };
  status.triageDecision = {
    novelty,
    relevance,
    contradictionCandidate: contradiction,
    openedDeep: deep,
  };
  status.lastCandidateAction = output.candidateAction.type;
  status.lastCandidateSummary =
    output.candidateAction.type === "display_text"
      ? output.candidateAction.payload.slice(0, 280)
      : `write_file ${output.candidateAction.filename}`;
  status.lastSummary = output.interpretedSummary;
  status.lastReasoningSummary = output.reasoningSummary;
  status.stageTimestamps = {
    signalReceivedAt: signal.timestamp,
    loopProcessedAt: Date.now(),
  };
  status.updatedAt = Date.now();

  await persistPhase1Artifacts();
  return output;
}

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

export function getPhase1LoopStatus(): Phase1LoopStatus {
  return { ...status };
}

export function getPhase1MemoryStatus() {
  const raw = getPhase1MemorySnapshot();
  const bridge = getPhase1StudioMemoryBridgeSnapshot();

  return {
    ...raw,
    workingMemorySample: bridge.workingMemorySample,
    recentEpisodesSample: bridge.recentEpisodesSample,
    referenceItemSample: bridge.referenceItemSample,
    threadSummarySample: bridge.threadSummarySample,
    outcomeBufferSample: bridge.outcomeBufferSample,
    structuralNodeSample: bridge.structuralNodeSample,
    associationSample: bridge.associationSample,
    readOnly: true,
    generatedAt: Date.now(),
  };
}

export async function persistPhase1Artifacts(): Promise<void> {
  await fs.mkdir(phase1Dir, { recursive: true });
  await fs.writeFile(loopStatusFile, JSON.stringify(getPhase1LoopStatus(), null, 2), "utf-8");
  await fs.writeFile(memoryStatusFile, JSON.stringify(getPhase1MemoryStatus(), null, 2), "utf-8");
}

export function getPhase1ArtifactPaths() {
  return { loopStatusFile, memoryStatusFile };
}

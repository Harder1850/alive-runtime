/**
 * Proving-scenario types — alive-runtime Phase 1
 *
 * These types live at the runtime boundary. They are NOT constitution contracts
 * (which are locked). They are the richer proving-scenario shapes used for:
 *   - Studio artifact visibility
 *   - Whitelist enforcement decisions
 *   - Outcome recording
 *   - Human-readable explanation generation
 *
 * Flow:
 *   Constitution Signal → phase1-runtime → ProvidedSignal (display wrapper)
 *   Phase1CognitionOutput.actionCandidate → ActionCandidate (richer than constitution Action)
 *   whitelist enforcement → WhitelistVerdict
 *   execution result → OutcomeRecord
 *   all of the above → DemoExplanation (grounded human-readable summary)
 */

// ── Signal display wrapper ─────────────────────────────────────────────────────
// Maps the internal constitution Signal to a display-friendly shape for
// Studio visibility and artifacts. Never used inside the cognition pipeline.

export type ProvidedSignalSourceType =
  | 'filesystem'
  | 'system'
  | 'process'
  | 'command'
  | 'git';

export interface ProvidedSignal {
  signal_id: string;
  source_type: ProvidedSignalSourceType;
  event_type: string;
  observed_at: number;
  quality_score: number;
  payload_ref: string;   // stringified summary of signal.payload or raw_content
  summary: string;
  thread_hint?: string | null;
}

// ── ActionCandidate ────────────────────────────────────────────────────────────
// The mind's richer intermediate output — a candidate for what to do next.
// This is NOT a constitution Action. The runtime translates it into a
// constitution Action for body execution, or records it as recommendation-only.

export type ActionCandidateType =
  | 'ignore'
  | 'monitor'
  | 'notify'
  | 'recommend'
  | 'safe_file_edit'
  | 'safe_command_run'
  | 'cleanup_temp'
  | 'git_status_check';

export interface ActionCandidate {
  candidate_id: string;
  action_type: ActionCandidateType;
  rationale: string;
  confidence_score: number;      // 0.0–1.0
  risk_score: number;            // 0.0–1.0  (lower = safer)
  reversibility_score: number;   // 0.0–1.0  (higher = more reversible)
  requires_human_approval: boolean;
  support_refs: string[];        // signal IDs, memory refs, rule IDs
}

// ── OutcomeRecord ──────────────────────────────────────────────────────────────
// Records what actually happened after a candidate was executed or recommended.

export interface OutcomeRecord {
  outcome_id: string;
  candidate_id: string;
  thread_id?: string;
  observed_result: 'success' | 'failure' | 'partial' | 'unknown';
  state_delta: Record<string, unknown>;
  discrepancy_score: number;   // 0.0 = outcome matched expectation, 1.0 = total mismatch
  received_at: number;
}

// ── DemoExplanation ────────────────────────────────────────────────────────────
// Human-readable summary for Studio display.
// Every field is grounded in real runtime/mind state — no fabricated reasoning.

export type ConfidenceTone = 'low' | 'medium' | 'high';

export interface DemoExplanation {
  notice: string;             // one-line summary of what happened
  reason: string;             // why this action was chosen / recommended
  confidence_tone: ConfidenceTone;
  next_step?: string;         // what a human should consider doing next
}

// ── StoryModeSummary ───────────────────────────────────────────────────────────
// Human-readable narrative for non-technical observers.
// Every sentence is grounded in a real data field — nothing is invented.
// Used by Studio's StoryModePanel.

export interface StoryModeSummary {
  noticed: string;      // "I noticed..." — what signal arrived
  lookedLike: string;   // "It looked like..." — what cognition concluded
  decided: string;      // "I decided to..." — action chosen + whitelist outcome
  result: string;       // "The result was..." — execution outcome
  safetyNote: string;   // "I only took safe actions..." — whitelist confirmation
  generatedAt: number;  // epoch ms when this summary was built
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Map constitution SignalSource to ProvidedSignalSourceType. */
export function mapSourceType(source: string): ProvidedSignalSourceType {
  switch (source) {
    case 'filesystem': return 'filesystem';
    case 'github':     return 'git';
    case 'telemetry':  return 'system';
    case 'process':    return 'process';
    case 'system_api': return 'command';
    default:           return 'system';
  }
}

/** Derive a confidence tone from a 0.0–1.0 score. */
export function confidenceTone(score: number): ConfidenceTone {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

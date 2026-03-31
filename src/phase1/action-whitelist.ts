/**
 * Action Whitelist — alive-runtime Phase 1
 *
 * The runtime is the choke point. No action reaches the body without passing
 * through this whitelist. The body must not reinterpret or override these decisions.
 *
 * Whitelist tiers:
 *   AUTO_EXECUTE   — allowed AND low-risk enough to run without human approval
 *   RECOMMEND_ONLY — allowed but recorded as recommendation; human decides
 *   BLOCKED        — disallowed entirely (no action, no recommendation)
 *
 * Additional guards applied to AUTO_EXECUTE candidates:
 *   - risk_score > 0.5          → downgrade to RECOMMEND_ONLY
 *   - requires_human_approval   → downgrade to RECOMMEND_ONLY
 *   - safe_file_edit/cleanup_temp without demo-path support_ref → RECOMMEND_ONLY
 */

import type { ActionCandidate, ActionCandidateType } from './proving-types';

// ── Verdict ────────────────────────────────────────────────────────────────────

export interface WhitelistVerdict {
  allowed: boolean;
  auto_execute: boolean;   // true = runtime will call body executor immediately
  reason: string;
}

// ── Tier definitions ───────────────────────────────────────────────────────────

/** Low-risk actions runtime may run immediately without human approval. */
const AUTO_EXECUTE_TYPES = new Set<ActionCandidateType>([
  'git_status_check',   // read-only repository inspection
  'notify',             // display-only notification
  'monitor',            // passive observation, no side effects
]);

/** Actions that are allowed but must remain advisory — never auto-executed. */
const RECOMMEND_ONLY_TYPES = new Set<ActionCandidateType>([
  'recommend',          // advisory by design
  'safe_file_edit',     // scoped write — requires demo-path check before promotion
  'safe_command_run',   // command execution — requires explicit approval
  'cleanup_temp',       // deletion — scoped but still irreversible without backup
]);

/** Actions that produce no useful output — silently recorded, no execution. */
const NO_ACTION_TYPES = new Set<ActionCandidateType>([
  'ignore',
]);

// ── Demo-path guard ────────────────────────────────────────────────────────────

/**
 * Returns true when the candidate's support_refs indicate it targets the
 * explicitly allowed demo sandbox path (alive-web/ or a named demo marker).
 * Used to promote safe_file_edit / cleanup_temp to AUTO_EXECUTE.
 */
function isInDemoPath(candidate: ActionCandidate): boolean {
  const refs = candidate.support_refs.join(' ').toLowerCase();
  return (
    refs.includes('alive-web') ||
    refs.includes('cleanup_temp_demo') ||
    refs.includes('demo-path')
  );
}

// ── Main enforcement function ──────────────────────────────────────────────────

export function enforceWhitelist(candidate: ActionCandidate): WhitelistVerdict {
  const { action_type, risk_score, requires_human_approval, confidence_score } = candidate;

  // ── NO_ACTION tier ──────────────────────────────────────────────────────────
  if (NO_ACTION_TYPES.has(action_type)) {
    return {
      allowed: false,
      auto_execute: false,
      reason: `action_type '${action_type}': no action needed — recorded silently`,
    };
  }

  // ── AUTO_EXECUTE tier ───────────────────────────────────────────────────────
  if (AUTO_EXECUTE_TYPES.has(action_type)) {
    // Downgrade: explicit human approval requested
    if (requires_human_approval) {
      return {
        allowed: true,
        auto_execute: false,
        reason: `action_type '${action_type}' is auto-execute whitelisted but requires_human_approval=true — recommendation-only`,
      };
    }
    // Downgrade: risk too high for auto-execution
    if (risk_score > 0.5) {
      return {
        allowed: true,
        auto_execute: false,
        reason: `action_type '${action_type}' is auto-execute whitelisted but risk_score=${risk_score.toFixed(2)} > 0.5 — recommendation-only`,
      };
    }
    // Downgrade: confidence too low to trust auto-execution
    if (confidence_score < 0.35) {
      return {
        allowed: true,
        auto_execute: false,
        reason: `action_type '${action_type}' is auto-execute whitelisted but confidence_score=${confidence_score.toFixed(2)} < 0.35 — recommendation-only`,
      };
    }
    return {
      allowed: true,
      auto_execute: true,
      reason: `action_type '${action_type}' cleared for auto-execution (risk=${risk_score.toFixed(2)}, confidence=${confidence_score.toFixed(2)})`,
    };
  }

  // ── RECOMMEND_ONLY tier ─────────────────────────────────────────────────────
  if (RECOMMEND_ONLY_TYPES.has(action_type)) {
    // Promote safe_file_edit and cleanup_temp to auto-execute if demo-path and low risk
    if (
      (action_type === 'safe_file_edit' || action_type === 'cleanup_temp') &&
      isInDemoPath(candidate) &&
      risk_score <= 0.3 &&
      !requires_human_approval
    ) {
      return {
        allowed: true,
        auto_execute: true,
        reason: `action_type '${action_type}' promoted to auto-execute: demo-path confirmed, risk=${risk_score.toFixed(2)}`,
      };
    }
    return {
      allowed: true,
      auto_execute: false,
      reason: `action_type '${action_type}' is recommendation-only`,
    };
  }

  // ── Unknown type — block ────────────────────────────────────────────────────
  return {
    allowed: false,
    auto_execute: false,
    reason: `action_type '${action_type}' is not on the proving-scenario whitelist`,
  };
}

// ── Risk metadata ──────────────────────────────────────────────────────────────

/** Canonical risk scores per action type. Used by the mind layer when building candidates. */
export const ACTION_RISK_SCORES: Record<ActionCandidateType, number> = {
  ignore:          0.00,
  monitor:         0.02,
  notify:          0.05,
  git_status_check: 0.05,
  recommend:       0.10,
  safe_file_edit:  0.25,
  cleanup_temp:    0.20,
  safe_command_run: 0.35,
};

/** Canonical reversibility scores per action type. */
export const ACTION_REVERSIBILITY_SCORES: Record<ActionCandidateType, number> = {
  ignore:          1.00,
  monitor:         1.00,
  notify:          1.00,
  git_status_check: 1.00,
  recommend:       1.00,
  safe_file_edit:  0.80,   // prior version can be restored
  cleanup_temp:    0.40,   // deletion is hard to reverse without backup
  safe_command_run: 0.50,
};

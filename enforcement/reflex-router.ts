/**
 * Reflex Router — Autonomic fast-path for threat signals.
 *
 * When a Signal arrives with `threat_flag: true`, OR when its raw_content
 * matches a pattern in threat-dictionary.json, the runtime MUST bypass
 * the STG queue entirely and immediately emit a hardcoded reflex Action.
 * This mirrors biological autonomic reflexes: no deliberation, no queueing.
 *
 * Architecture:
 *   threat signal → reflex-router → immediate Action (skips STG + mind)
 *   normal signal → reflex-router → queued for STG evaluation
 *
 * Invariant: Emergency override never suppresses the reflex path.
 * (alive-constitution/invariants/emergency-bounds.ts — EMERGENCY_ALLOWS_CONSTITUTION_OVERRIDE = false)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import type { Signal } from '../../alive-constitution/contracts/signal';
import type { Action } from '../../alive-constitution/contracts/action';

export interface RoutingResult {
  /** Present when a threat was detected and the reflex fires immediately. */
  readonly reflexAction: Action | undefined;
  /** Signals that were placed into the normal STG queue for deliberation. */
  readonly queued: readonly Signal[];
  /** True if the autonomic fast-path was triggered, bypassing the STG queue. */
  readonly bypassed: boolean;
}

/** The hardcoded reflex Action emitted on threat detection. */
const THREAT_REFLEX_ACTION: Action = {
  type: 'display_text',
  payload: 'THREAT DETECTED: Emergency reflex protocol activated. Entering safe state.',
};

// ---------------------------------------------------------------------------
// Threat dictionary — loaded from enforcement/threat-dictionary.json
// ---------------------------------------------------------------------------
function loadThreatDictionary(): readonly string[] {
  const jsonPath = join(__dirname, 'threat-dictionary.json');
  if (existsSync(jsonPath)) {
    try {
      const raw = readFileSync(jsonPath, 'utf-8');
      return JSON.parse(raw) as string[];
    } catch {
      // Fall through to empty list on parse error
    }
  }
  return [];
}

const THREAT_PATTERNS: readonly string[] = loadThreatDictionary();

/**
 * Returns true if the signal's raw_content contains any threat dictionary pattern.
 * Patterns are matched case-insensitively.
 */
function matchesThreatDictionary(signal: Signal): boolean {
  if (THREAT_PATTERNS.length === 0) return false;
  const content = String(signal.raw_content ?? '').toLowerCase();
  return THREAT_PATTERNS.some((pattern) => content.includes(pattern.toLowerCase()));
}

/**
 * Route a batch of incoming signals with priority handling.
 *
 * If any signal carries `threat_flag: true`, OR if any signal's content
 * matches the threat dictionary, the entire queue is preempted:
 * no signals are forwarded to the STG and the reflex action fires immediately.
 *
 * If no threat is detected, all signals are placed in the queue for normal
 * STG → mind → enforcement → body processing.
 */
export function routeWithPriority(signals: readonly Signal[]): RoutingResult {
  const threatSignal = signals.find(
    (s) => s.threat_flag === true || matchesThreatDictionary(s),
  );

  if (threatSignal) {
    // AUTONOMIC FAST-PATH: preempt the entire queue and emit reflex immediately.
    return {
      reflexAction: THREAT_REFLEX_ACTION,
      queued: [],
      bypassed: true,
    };
  }

  return {
    reflexAction: undefined,
    queued: signals,
    bypassed: false,
  };
}

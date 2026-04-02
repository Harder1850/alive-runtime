/**
 * Reflex Router — Priority-based bypass for immediate threat response.
 *
 * When a signal carries a threat_flag or matches a critical keyword pattern,
 * the router emits a pre-wired reflex action without consulting the brain.
 * This is the "spinal cord" layer — fast, deterministic, and unconditional.
 *
 * Invariant: Reflex actions MUST be reversible or status-only.
 * The brain can always override a reflex on the next cycle.
 *
 * LOCKDOWN: The reflex bypass path is completely disabled.
 * routeWithPriority() returns { reflexAction: null, bypassed: false } when
 * isReflexPathPermitted() is false, so no signal can bypass the brain via
 * the reflex path during LOCKDOWN.
 */

import type { Signal } from '../../../alive-constitution/contracts/signal';
import type { Action }  from '../../../alive-constitution/contracts/action';
import { isReflexPathPermitted } from './lockdown-gate';

// Keywords that mandate an immediate reflex response
const CRITICAL_PATTERNS: readonly RegExp[] = [
  /intruder\s*alert/i,
  /perimeter\s*breach/i,
  /hull\s*breach/i,
  /fire\s*detected/i,
  /man\s*overboard/i,
  /mayday/i,
];

export interface ReflexResult {
  /** The pre-wired action to execute immediately */
  reflexAction: Action | null;
  /** True when the reflex router is handling this signal (brain bypassed) */
  bypassed: boolean;
}

/**
 * Route a batch of signals by priority.
 * Returns the highest-priority reflex action found, or null if none triggered.
 *
 * Returns { reflexAction: null, bypassed: false } immediately if the reflex
 * path is disabled (e.g. during LOCKDOWN).
 */
export function routeWithPriority(signals: Signal[]): ReflexResult {
  // LOCKDOWN guard — reflex bypass is disabled when the system is locked down.
  if (!isReflexPathPermitted()) {
    console.warn('[REFLEX-ROUTER] Reflex path disabled — system not in NORMAL mode');
    return { reflexAction: null, bypassed: false };
  }

  for (const signal of signals) {
    const reflex = evaluateReflex(signal);
    if (reflex.bypassed) return reflex;
  }
  return { reflexAction: null, bypassed: false };
}

function evaluateReflex(signal: Signal): ReflexResult {
  const content = String(signal.raw_content ?? '');

  // Priority 1: explicit threat flag from body layer
  if (signal.threat_flag) {
    // Only bypass for truly critical patterns — not all threat-flagged signals
    if (CRITICAL_PATTERNS.some((re) => re.test(content))) {
      return {
        reflexAction: {
          type: 'display_text',
          payload: `⚡ REFLEX ACTIVATED — "${content.slice(0, 80)}". Engaging emergency protocol. Brain notified.`,
          is_reversible: true,
        },
        bypassed: true,
      };
    }
  }

  return { reflexAction: null, bypassed: false };
}

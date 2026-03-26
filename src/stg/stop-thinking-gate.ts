/**
 * Stop-Thinking Gate (STG) — alive-runtime's cognitive gatekeeper.
 *
 * The STG decides whether a signal is worth spending brain cycles on.
 * Three possible outcomes:
 *   OPEN   — route to full cognitive pipeline (evaluateNovelSignal)
 *   DEFER  — buffer for next cycle (moderate priority, no rush)
 *   DENY   — discard (blocked by firewall, empty, or unimportant noise)
 *
 * The gate enforces per-signal atomic locks to prevent race conditions
 * where burst signals could share an evaluation window.
 */

import type { Signal } from '../../../alive-constitution/contracts/signal';

export type StgResult = 'OPEN' | 'DEFER' | 'DENY';

// ---------------------------------------------------------------------------
// Atomic STG locks — prevent duplicate concurrent evaluation of same signal
// ---------------------------------------------------------------------------

const stgLocks = new Map<string, boolean>();

function acquireSTGLock(signal_id: string): void {
  if (stgLocks.get(signal_id)) {
    throw new Error(
      `STG evaluation conflict: signal ${signal_id} already being evaluated. ` +
      'Possible race condition or burst bypass attempt.',
    );
  }
  stgLocks.set(signal_id, true);
}

function releaseSTGLock(signal_id: string): void {
  stgLocks.delete(signal_id);
}

// ---------------------------------------------------------------------------
// Keyword tables
// ---------------------------------------------------------------------------

/** These signals must always go OPEN — never lazy. */
const FORCE_OPEN_KEYWORDS = [
  'help', 'broke', 'broken', 'emergency', 'how', '?',
  'survival', 'threat', 'warning', 'error', 'fail',
];

/** These signals are worth thinking about but not urgent — DEFER ok. */
const DEFER_KEYWORDS = [
  'later', 'schedule', 'remind', 'log', 'note', 'when',
];

// ---------------------------------------------------------------------------
// STG mark — stamps the signal as brain-approved
// ---------------------------------------------------------------------------

export function markSignalVerified(signal: Signal): Signal {
  return { ...signal, stg_verified: true };
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

export function evaluateSTG(signal: Signal): StgResult {
  const signal_id = signal.id;
  acquireSTGLock(signal_id);

  try {
    console.log(`[STG] Deciding: Reflex vs Brain... (signal="${String(signal.raw_content).slice(0, 60)}")`);

    // Hard DENY: firewall blocked or empty content
    if (signal.firewall_status === 'blocked') return 'DENY';
    if (!String(signal.raw_content ?? '').trim()) return 'DENY';

    const lower = String(signal.raw_content).toLowerCase();

    // Force OPEN: distress, query, threat keywords
    if (FORCE_OPEN_KEYWORDS.some((kw) => lower.includes(kw))) {
      console.log('[STG] Force-OPEN: distress/query keyword detected → routing to Brain');
      return 'OPEN';
    }

    // Threat flag always opens the gate
    if (signal.threat_flag) {
      console.log('[STG] OPEN: threat_flag set');
      return 'OPEN';
    }

    // DEFER: schedulable / low-urgency signals
    if (DEFER_KEYWORDS.some((kw) => lower.includes(kw))) {
      console.log('[STG] DEFER: low-urgency keyword detected');
      return 'DEFER';
    }

    // Default: OPEN (all cleared signals get brain access)
    return 'OPEN';

  } finally {
    releaseSTGLock(signal_id);
  }
}

export function shouldThink(signal: Signal): boolean {
  return !String(signal.raw_content ?? '').toLowerCase().includes('forbidden');
}

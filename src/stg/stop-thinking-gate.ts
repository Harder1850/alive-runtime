/**
 * Stop-Thinking Gate (STG) — alive-runtime's cognitive gatekeeper.
 *
 * Three possible outcomes:
 *   OPEN   — route to full cognitive pipeline
 *   DEFER  — buffer for next cycle (not urgent enough now)
 *   DENY   — discard (blocked by firewall, empty, or vetoed)
 *
 * v12 §9 Resource Allocation — Priority-Based Determinism:
 *   Priority 4 (CRITICAL) : Always OPEN
 *   Priority 3 (HIGH)     : OPEN if battery > 20%
 *   Priority 2 (MEDIUM)   : OPEN if battery > 50% AND system load < 70%
 *   Priority 0-1 (LOW)    : DEFER
 *
 * Keywords override the priority table — distress/query signals are always OPEN.
 */

import type { Signal } from '../../../alive-constitution/contracts/signal';

export type StgResult = 'OPEN' | 'DEFER' | 'DENY';

// ---------------------------------------------------------------------------
// Atomic per-signal locks — prevent duplicate concurrent STG evaluation
// ---------------------------------------------------------------------------

const stgLocks = new Map<string, boolean>();

function acquireSTGLock(id: string): void {
  if (stgLocks.get(id)) throw new Error(`STG lock conflict on signal ${id}`);
  stgLocks.set(id, true);
}

function releaseSTGLock(id: string): void {
  stgLocks.delete(id);
}

// ---------------------------------------------------------------------------
// Keyword overrides
// ---------------------------------------------------------------------------

const FORCE_OPEN_KEYWORDS = [
  'help', 'broke', 'broken', 'emergency', 'how', '?',
  'survival', 'threat', 'warning', 'error', 'fail',
];

// ---------------------------------------------------------------------------
// STG mark — stamps signal as brain-approved
// ---------------------------------------------------------------------------

export function markSignalVerified(signal: Signal): Signal {
  return { ...signal, stg_verified: true };
}

// ---------------------------------------------------------------------------
// Main evaluation — with resource context
// ---------------------------------------------------------------------------

export interface STGContext {
  triagePriority?: number;   // 0–4 from triage service
  batteryPct?: number;       // 0–100 from ASM
  systemLoadPct?: number;    // 0–100 CPU load estimate
}

export function evaluateSTG(signal: Signal, ctx: STGContext = {}): StgResult {
  const { triagePriority = 1, batteryPct = 100, systemLoadPct = 0 } = ctx;

  acquireSTGLock(signal.id);
  try {
    console.log(
      `[STG] priority=${triagePriority} battery=${batteryPct}% load=${systemLoadPct}% ` +
      `signal="${String(signal.raw_content).slice(0, 50)}"`,
    );

    if (signal.firewall_status === 'blocked') return 'DENY';
    if (!String(signal.raw_content ?? '').trim()) return 'DENY';

    const lower = String(signal.raw_content).toLowerCase();
    if (FORCE_OPEN_KEYWORDS.some((kw) => lower.includes(kw))) {
      console.log('[STG] Force-OPEN: distress/query keyword');
      return 'OPEN';
    }

    if (signal.threat_flag) return 'OPEN';

    // Priority-based determinism (v12 §9)
    if (triagePriority >= 4) return 'OPEN';

    if (triagePriority === 3) {
      return batteryPct > 20 ? 'OPEN' : 'DEFER';
    }

    if (triagePriority === 2) {
      return (batteryPct > 50 && systemLoadPct < 70) ? 'OPEN' : 'DEFER';
    }

    // Priority 0-1 → DEFER
    return 'DEFER';

  } finally {
    releaseSTGLock(signal.id);
  }
}

export function shouldThink(signal: Signal): boolean {
  return !String(signal.raw_content ?? '').toLowerCase().includes('forbidden');
}

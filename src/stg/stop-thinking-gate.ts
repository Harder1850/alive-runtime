/**
 * Stop-Thinking Gate (STG) — alive-runtime's cognitive gatekeeper.
 *
 * Three possible outcomes:
 *   OPEN   — route to full cognitive pipeline
 *   DEFER  — buffer for next cycle (not urgent enough now)
 *   DENY   — discard (blocked by firewall, empty, or vetoed)
 *
 * v16 §31.8 Three-Condition Decision Policy (Slice 1 weights):
 *
 *   Pre-checks (before conditions):
 *     • firewall_status === 'blocked' → DENY
 *     • empty raw_content             → DENY
 *     • distress/query keyword        → OPEN (force override)
 *     • threat_flag === true          → OPEN (force override)
 *
 *   Condition 1 — Critical priority override:
 *     triagePriority >= CRITICAL_THRESHOLD (4) → OPEN regardless of resources
 *
 *   Condition 2 — Resource gate (Slice 1 weights):
 *     batteryPct > BATTERY_THRESHOLD (30) AND cpuRisk < CPU_RISK_THRESHOLD (0.7)
 *     → OPEN
 *
 *   Condition 3 — Default:
 *     → DEFER
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

// ---------------------------------------------------------------------------
// Slice 1 weights (v16 §31.8)
// ---------------------------------------------------------------------------

/** Minimum battery percentage required for the resource gate to pass. */
const BATTERY_THRESHOLD = 30;
/** Maximum cpu_risk (0.0–1.0) allowed for the resource gate to pass. */
const CPU_RISK_THRESHOLD = 0.7;
/** Priority level that bypasses all resource checks. */
const CRITICAL_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// STG context
// ---------------------------------------------------------------------------

export interface STGContext {
  triagePriority?: number;   // 0–4 from triage service
  batteryPct?: number;       // 0–100 from ASM (battery_status × 100)
  cpuRisk?: number;          // 0.0–1.0 from ASM cpu_risk (v16 §31.6)
}

export function evaluateSTG(signal: Signal, ctx: STGContext = {}): StgResult {
  const { triagePriority = 1, batteryPct = 100, cpuRisk = 0.0 } = ctx;

  acquireSTGLock(signal.id);
  try {
    console.log(
      `[STG] priority=${triagePriority} battery=${batteryPct}% cpu_risk=${cpuRisk.toFixed(2)} ` +
      `signal="${String(signal.raw_content).slice(0, 50)}"`,
    );

    // Pre-checks
    if (signal.firewall_status === 'blocked') return 'DENY';
    if (!String(signal.raw_content ?? '').trim()) return 'DENY';

    const lower = String(signal.raw_content).toLowerCase();
    if (FORCE_OPEN_KEYWORDS.some((kw) => lower.includes(kw))) {
      console.log('[STG] Force-OPEN: distress/query keyword');
      return 'OPEN';
    }

    if (signal.threat_flag) return 'OPEN';

    // v16 §31.8 — Condition 1: critical priority override
    if (triagePriority >= CRITICAL_THRESHOLD) return 'OPEN';

    // v16 §31.8 — Condition 2: resource gate (Slice 1 weights)
    if (batteryPct > BATTERY_THRESHOLD && cpuRisk < CPU_RISK_THRESHOLD) return 'OPEN';

    // v16 §31.8 — Condition 3: default
    return 'DEFER';

  } finally {
    releaseSTGLock(signal.id);
  }
}

export function shouldThink(signal: Signal): boolean {
  return !String(signal.raw_content ?? '').toLowerCase().includes('forbidden');
}

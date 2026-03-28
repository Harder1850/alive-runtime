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
export declare function markSignalVerified(signal: Signal): Signal;
export interface STGContext {
    triagePriority?: number;
    batteryPct?: number;
    systemLoadPct?: number;
}
export declare function evaluateSTG(signal: Signal, ctx?: STGContext): StgResult;
export declare function shouldThink(signal: Signal): boolean;
//# sourceMappingURL=stop-thinking-gate.d.ts.map
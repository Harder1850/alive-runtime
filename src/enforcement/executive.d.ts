/**
 * Executive Orchestrator — alive-runtime enforcement authority.
 *
 * Sits between Triage and the STG in the v12 pipeline:
 *   CB → Triage → [Executive] → STG → Mind → Body → Experience
 *
 * Responsibilities:
 *   1. Load CONSTITUTION.json and mission.json on startup (cached in memory).
 *   2. Evaluate each signal against constitutional invariants and forbidden patterns.
 *   3. Authorize or VETO the signal before STG evaluation begins.
 *   4. Enforce the Enforcement Integrity Invariant (INV-005).
 *
 * Authority:
 *   - AUTHORIZED  : signal may proceed to STG
 *   - VETOED      : signal blocked — constitutional violation
 *   - FLAGGED     : signal may proceed but carries a warning annotation
 *
 * The Executive reads law — it does not write it.
 * Constitution and mission are source files, not runtime state.
 */
import type { Signal } from '../../../alive-constitution/contracts/signal';
import type { TriageResult } from '../triage/triage-service';
export type ExecutiveVerdict = 'AUTHORIZED' | 'VETOED' | 'FLAGGED';
export interface ExecutiveDecision {
    verdict: ExecutiveVerdict;
    reason: string;
    constitution_ref: string;
    signal_id: string;
    checked_at: number;
}
/**
 * Authorize or veto a signal before it reaches the STG.
 *
 * Checks (in order of severity):
 *   1. Firewall status (INV-006)
 *   2. Source trustworthiness (CONSTITUTION.signal_sources)
 *   3. Forbidden content patterns (CONSTITUTION.forbidden_patterns)
 *   4. Triage flags — critical flag count limit (anomaly detection)
 */
export declare function authorize(signal: Signal, triage: TriageResult): ExecutiveDecision;
/**
 * Expose loaded mission thresholds for STG resource allocation.
 * Returns defaults if mission.json was not found.
 */
export declare function getMissionThresholds(): {
    battery_critical_pct: number;
    battery_low_pct: number;
    cpu_overheat_c: number;
    disk_full_pct: number;
    wind_high_mph: number;
    system_load_high_pct: number;
};
//# sourceMappingURL=executive.d.ts.map
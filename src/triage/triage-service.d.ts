/**
 * Triage Service — alive-runtime's flag classifier.
 *
 * Sits between the CB layer and the STG. Takes a Signal + CB analysis,
 * inspects content, and emits zero or more Flags that downstream
 * processors (STG, brain) use to make routing decisions.
 *
 * Triage is intentionally fast and heuristic. Deep analysis happens
 * in alive-mind. Triage only classifies urgency and routing.
 */
import type { Signal } from '../../../alive-constitution/contracts/signal';
import type { Flag, FlagPriority, FlagRoute } from '../../../alive-constitution/contracts/flag';
import type { CBResult } from '../comparison-baseline/cb-service';
export interface TriageResult {
    flags: Flag[];
    /** Recommended route after considering all flags (highest priority wins) */
    recommendedRoute: FlagRoute;
    /** Highest priority flag raised */
    highestPriority: FlagPriority;
}
export declare function triageSignal(signal: Signal, cb: CBResult): TriageResult;
//# sourceMappingURL=triage-service.d.ts.map
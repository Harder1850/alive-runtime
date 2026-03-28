/**
 * Comparison Baseline (CB) — alive-runtime's fast change detector.
 *
 * The CB maintains a rolling window of signal frequency per source,
 * computes a baseline rate, and flags statistical anomalies.
 *
 * This is the "peripheral nervous system" — it runs before the STG and
 * tags signals with anomaly metadata so the triage layer can decide
 * whether to escalate without needing to parse content.
 *
 * Dual-State Model: CB lives in alive-runtime (fast), ASM lives in
 * alive-mind (authoritative). CB detects change; ASM records truth.
 */
import type { Signal } from '../../../alive-constitution/contracts/signal';
export interface CBResult {
    /** True when this signal's source is firing at anomalous velocity */
    isAnomaly: boolean;
    /** Signals per minute from this source in the current window */
    currentVelocity: number;
    /** Expected signals per minute (rolling 5-minute average) */
    baselineVelocity: number;
    /** How many standard deviations above baseline (0 if not anomalous) */
    zScore: number;
}
/**
 * Record a signal arrival and evaluate whether it represents an anomaly.
 * Mutates the CB state for `signal.source`.
 */
export declare function recordAndEvaluate(signal: Signal): CBResult;
/** Reset the CB for a specific source (for testing / restart). */
export declare function resetSource(source: string): void;
/** Current snapshot of all tracked source windows (for status reporting). */
export declare function getSnapshot(): Record<string, {
    count: number;
    velocityPerMin: number;
}>;
//# sourceMappingURL=cb-service.d.ts.map
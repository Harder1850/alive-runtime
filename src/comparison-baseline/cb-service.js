"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordAndEvaluate = recordAndEvaluate;
exports.resetSource = resetSource;
exports.getSnapshot = getSnapshot;
const WINDOW_MS = 5 * 60000; // 5-minute rolling window
const ANOMALY_MULTIPLIER = 3.0; // spike must be 3× baseline to flag
const MIN_SAMPLES_FOR_BASELINE = 5; // need at least 5 signals to establish baseline
const windows = new Map();
function getWindow(source) {
    let win = windows.get(source);
    if (!win) {
        win = { timestamps: [] };
        windows.set(source, win);
    }
    return win;
}
function pruneOld(win, now) {
    const cutoff = now - WINDOW_MS;
    while (win.timestamps.length > 0 && win.timestamps[0] < cutoff) {
        win.timestamps.shift();
    }
}
/**
 * Record a signal arrival and evaluate whether it represents an anomaly.
 * Mutates the CB state for `signal.source`.
 */
function recordAndEvaluate(signal) {
    const now = Date.now();
    const win = getWindow(signal.source);
    pruneOld(win, now);
    win.timestamps.push(now);
    const count = win.timestamps.length;
    // Not enough data yet — no anomaly determination possible
    if (count < MIN_SAMPLES_FOR_BASELINE) {
        return { isAnomaly: false, currentVelocity: 0, baselineVelocity: 0, zScore: 0 };
    }
    // Split the window into two halves: baseline = older half, current = newer half
    const halfMs = WINDOW_MS / 2;
    const halfCutoff = now - halfMs;
    const baselineCount = win.timestamps.filter((t) => t < halfCutoff).length;
    const currentCount = win.timestamps.filter((t) => t >= halfCutoff).length;
    // Convert to signals/minute
    const baselineVelocity = (baselineCount / (halfMs / 60000));
    const currentVelocity = (currentCount / (halfMs / 60000));
    if (baselineVelocity === 0) {
        // No prior baseline — new source, first burst; flag if >5 signals in new half
        const isAnomaly = currentCount > 5;
        return { isAnomaly, currentVelocity, baselineVelocity: 0, zScore: isAnomaly ? 1 : 0 };
    }
    const zScore = currentVelocity / baselineVelocity;
    const isAnomaly = zScore >= ANOMALY_MULTIPLIER;
    if (isAnomaly) {
        console.log(`[CB] ANOMALY detected on source="${signal.source}": ` +
            `velocity=${currentVelocity.toFixed(1)}/min vs baseline=${baselineVelocity.toFixed(1)}/min ` +
            `(${zScore.toFixed(1)}×)`);
    }
    return { isAnomaly, currentVelocity, baselineVelocity, zScore };
}
/** Reset the CB for a specific source (for testing / restart). */
function resetSource(source) {
    windows.delete(source);
}
/** Current snapshot of all tracked source windows (for status reporting). */
function getSnapshot() {
    const now = Date.now();
    const snapshot = {};
    for (const [source, win] of windows.entries()) {
        pruneOld(win, now);
        const velocityPerMin = win.timestamps.length / (WINDOW_MS / 60000);
        snapshot[source] = { count: win.timestamps.length, velocityPerMin };
    }
    return snapshot;
}
//# sourceMappingURL=cb-service.js.map
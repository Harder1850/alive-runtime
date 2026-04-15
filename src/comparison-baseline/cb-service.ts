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
 *
 * v16 §31.5–§31.6: deltaScore = currentVelocity − baselineVelocity (signed
 * absolute velocity difference). Positive = acceleration, negative = slowdown.
 * Downstream consumers (triage, STG) use deltaScore for weighted urgency
 * calculations without re-deriving it from the two raw velocities.
 */

import type { Signal } from '../../../alive-constitution/contracts';

export interface CBResult {
  /** True when this signal's source is firing at anomalous velocity */
  isAnomaly: boolean;
  /** Signals per minute from this source in the current window */
  currentVelocity: number;
  /** Expected signals per minute (rolling 5-minute average) */
  baselineVelocity: number;
  /** How many standard deviations above baseline (0 if not anomalous) */
  zScore: number;
  /**
   * v16 §31.5 — Signed velocity difference: currentVelocity − baselineVelocity.
   * Positive = signal burst (acceleration), negative = slowdown.
   * Used by downstream stages for weighted urgency without re-derivation.
   */
  deltaScore: number;
}

interface SourceWindow {
  timestamps: number[];  // ring buffer of recent signal arrival times
}

const WINDOW_MS = 5 * 60_000;      // 5-minute rolling window
const ANOMALY_MULTIPLIER = 3.0;    // spike must be 3× baseline to flag
const MIN_SAMPLES_FOR_BASELINE = 5; // need at least 5 signals to establish baseline

const windows = new Map<string, SourceWindow>();

function getWindow(source: string): SourceWindow {
  let win = windows.get(source);
  if (!win) {
    win = { timestamps: [] };
    windows.set(source, win);
  }
  return win;
}

function pruneOld(win: SourceWindow, now: number): void {
  const cutoff = now - WINDOW_MS;
  while (win.timestamps.length > 0 && win.timestamps[0]! < cutoff) {
    win.timestamps.shift();
  }
}

/**
 * Record a signal arrival and evaluate whether it represents an anomaly.
 * Mutates the CB state for `signal.source`.
 */
export function recordAndEvaluate(signal: Signal): CBResult {
  const now = Date.now();
  const win = getWindow(signal.source);

  pruneOld(win, now);
  win.timestamps.push(now);

  const count = win.timestamps.length;

  // Not enough data yet — no anomaly determination possible
  if (count < MIN_SAMPLES_FOR_BASELINE) {
    return { isAnomaly: false, currentVelocity: 0, baselineVelocity: 0, zScore: 0, deltaScore: 0 };
  }

  // Split the window into two halves: baseline = older half, current = newer half
  const halfMs = WINDOW_MS / 2;
  const halfCutoff = now - halfMs;

  const baselineCount = win.timestamps.filter((t) => t < halfCutoff).length;
  const currentCount = win.timestamps.filter((t) => t >= halfCutoff).length;

  // Convert to signals/minute
  const baselineVelocity = (baselineCount / (halfMs / 60_000));
  const currentVelocity = (currentCount / (halfMs / 60_000));

  if (baselineVelocity === 0) {
    // No prior baseline — new source, first burst; flag if >5 signals in new half
    const isAnomaly = currentCount > 5;
    return { isAnomaly, currentVelocity, baselineVelocity: 0, zScore: isAnomaly ? 1 : 0, deltaScore: currentVelocity };
  }

  const zScore = currentVelocity / baselineVelocity;
  const isAnomaly = zScore >= ANOMALY_MULTIPLIER;
  // v16 §31.5: signed velocity difference
  const deltaScore = currentVelocity - baselineVelocity;

  if (isAnomaly) {
    console.log(
      `[CB] ANOMALY detected on source="${signal.source}": ` +
      `velocity=${currentVelocity.toFixed(1)}/min vs baseline=${baselineVelocity.toFixed(1)}/min ` +
      `(${zScore.toFixed(1)}×, delta=${deltaScore.toFixed(1)})`,
    );
  }

  return { isAnomaly, currentVelocity, baselineVelocity, zScore, deltaScore };
}

/** Reset the CB for a specific source (for testing / restart). */
export function resetSource(source: string): void {
  windows.delete(source);
}

/** Current snapshot of all tracked source windows (for status reporting). */
export function getSnapshot(): Record<string, { count: number; velocityPerMin: number }> {
  const now = Date.now();
  const snapshot: Record<string, { count: number; velocityPerMin: number }> = {};
  for (const [source, win] of windows.entries()) {
    pruneOld(win, now);
    const velocityPerMin = win.timestamps.length / (WINDOW_MS / 60_000);
    snapshot[source] = { count: win.timestamps.length, velocityPerMin };
  }
  return snapshot;
}

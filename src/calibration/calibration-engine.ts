/**
 * Calibration Engine — alive-runtime
 * alive-runtime/src/calibration/calibration-engine.ts
 *
 * Runtime governance module. Reads constitution. Enforces law.
 *
 * Receives prediction outcomes and attributes error to source.
 * Adjusts per-channel accuracy scores used by CCE.
 * Updates CB thresholds via runtime feedback path.
 *
 * Lives in alive-runtime — calibration feedback flows through runtime,
 * not through alive-mind directly (v16 §5).
 *
 * Slice 4 implementation.
 */

import type { Signal } from '../../../alive-constitution/contracts/signal';

export type OutcomeType = 'positive' | 'neutral' | 'negative' | 'unknown';

export interface PredictionOutcome {
  signal:             Signal;
  action_type:        string;
  synthesizer_level:  string;
  scored_confidence:  number;
  outcome:            OutcomeType;
  observed_at:        number;
}

export interface ChannelAccuracy {
  channel:           string;
  accuracy:          number;
  total_outcomes:    number;
  positive_outcomes: number;
  last_updated:      number;
}

export interface CalibrationResult {
  channel:               string;
  accuracy_before:       number;
  accuracy_after:        number;
  delta:                 number;
  cb_threshold_adjusted: boolean;
  new_cb_threshold?:     number;
}

const EMA_ALPHA             = 0.15;
const ACCURACY_LOWER_BOUND  = 0.40;
const ACCURACY_UPPER_BOUND  = 0.75;
const CB_DEFAULT_THRESHOLD  = 0.35;
const CB_ADJUSTMENT_RANGE   = 0.15;

const channelAccuracies = new Map<string, ChannelAccuracy>();
const cbThresholds      = new Map<string, number>();

function channelKey(signal: Signal): string { return `${signal.kind}:${signal.source}`; }

function outcomeScore(o: OutcomeType): number {
  return o === 'positive' ? 1.0 : o === 'negative' ? 0.0 : 0.5;
}

function adjustCBThreshold(channel: string, accuracy: number): { adjusted: boolean; threshold: number } {
  const current = cbThresholds.get(channel) ?? CB_DEFAULT_THRESHOLD;
  if (accuracy < ACCURACY_LOWER_BOUND) {
    const nt = Math.max(CB_DEFAULT_THRESHOLD - CB_ADJUSTMENT_RANGE, current - (ACCURACY_LOWER_BOUND - accuracy) * CB_ADJUSTMENT_RANGE * 0.1);
    if (Math.abs(nt - current) > 0.005) { cbThresholds.set(channel, nt); return { adjusted: true, threshold: nt }; }
  } else if (accuracy > ACCURACY_UPPER_BOUND) {
    const nt = Math.min(CB_DEFAULT_THRESHOLD + CB_ADJUSTMENT_RANGE, current + (accuracy - ACCURACY_UPPER_BOUND) * CB_ADJUSTMENT_RANGE * 0.1);
    if (Math.abs(nt - current) > 0.005) { cbThresholds.set(channel, nt); return { adjusted: true, threshold: nt }; }
  }
  return { adjusted: false, threshold: current };
}

export function recordOutcome(outcome: PredictionOutcome): CalibrationResult {
  const key     = channelKey(outcome.signal);
  const score   = outcomeScore(outcome.outcome);
  const channel = channelAccuracies.get(key);
  let before: number, after: number;
  if (!channel) {
    before = 0.5; after = score;
    channelAccuracies.set(key, { channel: key, accuracy: after, total_outcomes: 1, positive_outcomes: outcome.outcome === 'positive' ? 1 : 0, last_updated: Date.now() });
  } else {
    before = channel.accuracy; after = EMA_ALPHA * score + (1 - EMA_ALPHA) * channel.accuracy;
    channelAccuracies.set(key, { ...channel, accuracy: after, total_outcomes: channel.total_outcomes + 1, positive_outcomes: channel.positive_outcomes + (outcome.outcome === 'positive' ? 1 : 0), last_updated: Date.now() });
  }
  const cb = adjustCBThreshold(key, after);
  return { channel: key, accuracy_before: before, accuracy_after: after, delta: after - before, cb_threshold_adjusted: cb.adjusted, new_cb_threshold: cb.adjusted ? cb.threshold : undefined };
}

export function getAccuracy(signal: Signal): number {
  return channelAccuracies.get(channelKey(signal))?.accuracy ?? 0.5;
}

export function getCBThreshold(signal: Signal): number {
  return cbThresholds.get(channelKey(signal)) ?? CB_DEFAULT_THRESHOLD;
}

export function getAllAccuracies(): ChannelAccuracy[] {
  return Array.from(channelAccuracies.values());
}

export function getAllCBThresholds(): Map<string, number> {
  return new Map(cbThresholds);
}

export function clearAll(): void {
  channelAccuracies.clear();
  cbThresholds.clear();
}

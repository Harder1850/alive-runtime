/**
 * Comparison Baseline (CB) — alive-runtime
 * alive-runtime/src/comparison-baseline/cb.ts
 *
 * Fast change detection. Owned by alive-runtime — NOT alive-body.
 *
 * CB detects deviation. ASM defines reality. These are two distinct nodes.
 * CB never writes to ASM. ASM may calibrate CB indirectly through runtime
 * feedback — never through a direct write.
 *
 * Slice 1: ring buffer (16 samples) per channel (kind:source).
 */

import type { Signal } from '../../../../alive-constitution/contracts/signal';

function channelKey(signal: Signal): string {
  return `${signal.kind}:${signal.source}`;
}

const RING_SIZE = 16;

interface ChannelBaseline {
  samples:  number[];
  head:     number;
  count:    number;
  mean:     number;
  variance: number;
}

function makeChannel(): ChannelBaseline {
  return { samples: new Array(RING_SIZE).fill(0), head: 0, count: 0, mean: 0, variance: 0 };
}

const channels = new Map<string, ChannelBaseline>();

function extractNumericValue(signal: Signal): number | null {
  if (signal.payload) {
    for (const key of ['cpu_risk', 'usage_percent', 'value', 'bytes', 'count']) {
      const v = signal.payload[key];
      if (typeof v === 'number' && isFinite(v)) return v;
    }
  }
  const match = String(signal.raw_content ?? '').match(/[\d.]+/);
  if (match) {
    const n = parseFloat(match[0]);
    if (isFinite(n)) return n;
  }
  return null;
}

function updateStats(ch: ChannelBaseline, newValue: number): void {
  ch.count++;
  const delta  = newValue - ch.mean;
  ch.mean     += delta / ch.count;
  const delta2 = newValue - ch.mean;
  ch.variance += delta * delta2;
}

function getStdDev(ch: ChannelBaseline): number {
  if (ch.count < 2) return 0;
  return Math.sqrt(ch.variance / (ch.count - 1));
}

export interface CBResult {
  channel:     string;
  delta:       number;
  deltaScore:  number;
  zScore:      number;
  sampleCount: number;
  signal:      Signal;
}

export function compareBaseline(signal: Signal): CBResult {
  const key   = channelKey(signal);
  const value = extractNumericValue(signal);

  if (!channels.has(key)) channels.set(key, makeChannel());
  const ch = channels.get(key)!;

  let delta = 0, deltaScore = 0, zScore = 0;

  if (value !== null) {
    if (ch.count > 0) {
      delta  = Math.abs(value - ch.mean);
      const stdDev         = getStdDev(ch);
      const normalizedDelta = ch.mean > 0 ? delta / ch.mean : delta;
      deltaScore = Math.min(1.0, Math.tanh(normalizedDelta * 3));
      zScore     = stdDev > 0 ? delta / stdDev : 0;
    } else {
      deltaScore = 1.0;
    }
    ch.samples[ch.head] = value;
    ch.head = (ch.head + 1) % RING_SIZE;
    updateStats(ch, value);
  }

  return { channel: key, delta, deltaScore, zScore, sampleCount: ch.count, signal: { ...signal, novelty: deltaScore } };
}

export function resetChannel(signal: Signal): void {
  channels.delete(channelKey(signal));
}

export function getChannelStats(signal: Signal): { mean: number; stdDev: number; count: number } | null {
  const ch = channels.get(channelKey(signal));
  if (!ch) return null;
  return { mean: ch.mean, stdDev: getStdDev(ch), count: ch.count };
}

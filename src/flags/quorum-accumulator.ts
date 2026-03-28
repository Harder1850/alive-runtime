/**
 * Quorum Accumulator — alive-runtime  (Slice 2, v16 §25)
 *
 * Weak signals (priority 1–2) that individually don't warrant action can
 * accumulate toward a quorum threshold, at which point the system emits a
 * consolidated flag of the dominant class.
 *
 * Algorithm per tick:
 *   1. Accept contributions from active weak flags (priority 1–2 only).
 *   2. Decay the accumulated score by DECAY_RATE (10 %).
 *   3. If score >= THRESHOLD, emit a new flag of the dominant class and reset.
 *
 * This prevents the system from ignoring persistent low-level noise while
 * also preventing a single weak signal from triggering immediate action.
 */

import { createFlag }    from '../../../alive-constitution/contracts/flag';
import type { Flag, FlagClass } from '../../../alive-constitution/contracts/flag';

// ─── Configuration ────────────────────────────────────────────────────────────

const QUORUM_THRESHOLD = 5.0;
const DECAY_RATE       = 0.10;   // 10 % per tick
const WEAK_MAX_PRIORITY = 2;     // flags at priority <= 2 are "weak"
const QUORUM_FLAG_TTL_MS = 30_000;
const QUORUM_SOURCE      = 'runtime/quorum';

// ─── QuorumAccumulator ────────────────────────────────────────────────────────

export class QuorumAccumulator {
  private score  = 0;
  private counts: Record<FlagClass, number> = { threat: 0, anomaly: 0, degradation: 0 };
  private signalId = 'quorum'; // updated to latest contributing signal

  /**
   * Contribute a weak flag to the quorum pool.
   * Flags with priority > WEAK_MAX_PRIORITY are ignored (they route directly).
   */
  add(flag: Flag): void {
    if (flag.priority > WEAK_MAX_PRIORITY) return;
    this.score += flag.priority;
    this.counts[flag.class]++;
    this.signalId = flag.signal_id;
  }

  /**
   * Run one decay + threshold check.
   *
   * Returns a consolidated Flag if quorum is reached, null otherwise.
   * Resets internal state after emission.
   */
  tick(): Flag | null {
    // Apply decay
    this.score *= (1 - DECAY_RATE);

    if (this.score < QUORUM_THRESHOLD) return null;

    // Quorum reached — emit flag of dominant class
    const dominantClass = this.getDominantClass();
    const totalContrib  = this.counts.threat + this.counts.anomaly + this.counts.degradation;

    console.log(
      `[QUORUM] THRESHOLD REACHED  score=${this.score.toFixed(2)} ` +
      `dominant=${dominantClass} contributions=${totalContrib}`,
    );

    const flag = createFlag({
      class:       dominantClass,
      source:      QUORUM_SOURCE,
      signal_id:   this.signalId,
      priority:    3,   // quorum flags elevate to MEDIUM priority
      reason:      `Quorum accumulated: ${totalContrib} weak ${dominantClass} signals (score=${this.score.toFixed(1)})`,
      expires_at:  Date.now() + QUORUM_FLAG_TTL_MS,
      support_ref: this.signalId,
    });

    this.reset();
    return flag;
  }

  /** Current accumulated score (for diagnostics / tests). */
  getScore(): number {
    return this.score;
  }

  private getDominantClass(): FlagClass {
    const entries = Object.entries(this.counts) as [FlagClass, number][];
    return entries.sort((a, b) => b[1] - a[1])[0]![0];
  }

  private reset(): void {
    this.score    = 0;
    this.counts   = { threat: 0, anomaly: 0, degradation: 0 };
    this.signalId = 'quorum';
  }
}

/** Module-level singleton. */
export const quorumAccumulator = new QuorumAccumulator();

/**
 * Flag Store — alive-runtime  (Slice 2, v16 §25)
 *
 * In-memory store for active system flags.
 *
 * Responsibilities:
 *   emit(flag)    — accept a flag, reject exact duplicates
 *   tick()        — purge expired flags; called once per cycle
 *   getActive()   — return non-expired flags sorted by priority (highest first)
 *
 * Anti-noise rule (duplicate rejection):
 *   A flag is considered a duplicate if an unexpired flag already exists with
 *   the same `class`, `source`, AND `reason`. Identical re-emission within the
 *   same expiry window is silently dropped and logged.
 *
 * The store never grows indefinitely: tick() + mandatory expires_at guarantee
 * all flags eventually leave.
 */

import type { Flag } from '../../../alive-constitution/contracts/flag';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EmitResult = 'accepted' | 'duplicate';

// ─── FlagStore ────────────────────────────────────────────────────────────────

export class FlagStore {
  private readonly flags = new Map<string, Flag>();

  /**
   * Attempt to add a flag to the store.
   *
   * Returns:
   *   'accepted'  — flag stored
   *   'duplicate' — an unexpired flag with identical (class, source, reason) exists;
   *                 the new flag is silently dropped
   */
  emit(flag: Flag): EmitResult {
    const now = Date.now();

    for (const existing of this.flags.values()) {
      if (
        existing.class  === flag.class  &&
        existing.source === flag.source &&
        existing.reason === flag.reason &&
        existing.expires_at > now
      ) {
        console.log(
          `[FLAG-STORE] DUPLICATE rejected  class=${flag.class} source=${flag.source} ` +
          `reason="${flag.reason.slice(0, 60)}"`,
        );
        return 'duplicate';
      }
    }

    this.flags.set(flag.id, flag);
    console.log(
      `[FLAG-STORE] ACCEPTED  id=${flag.id.slice(0, 8)} class=${flag.class} ` +
      `source=${flag.source} priority=${flag.priority} ` +
      `reason="${flag.reason.slice(0, 60)}"`,
    );
    return 'accepted';
  }

  /**
   * Purge all flags whose expires_at is in the past.
   * Call once per cycle — at the END of each cycle after all stage processing.
   */
  tick(): void {
    const now    = Date.now();
    let   purged = 0;

    for (const [id, flag] of this.flags.entries()) {
      if (flag.expires_at < now) {
        this.flags.delete(id);
        purged++;
      }
    }

    if (purged > 0) {
      console.log(`[FLAG-STORE] TICK — purged ${purged} expired flag(s); active=${this.flags.size}`);
    }
  }

  /**
   * Return all non-expired flags, sorted by priority descending (highest first).
   */
  getActive(): Flag[] {
    const now = Date.now();
    return [...this.flags.values()]
      .filter((f) => f.expires_at > now)
      .sort((a, b) => b.priority - a.priority);
  }

  /** Number of currently stored flags (including any not-yet-ticked expired ones). */
  size(): number {
    return this.flags.size;
  }

  /** Clear all flags — test/reset use only. */
  clear(): void {
    this.flags.clear();
  }
}

/** Module-level singleton shared across the Slice 2 pipeline. */
export const flagStore = new FlagStore();

/**
 * Flag Emitter — alive-runtime  (Slice 2, v16 §25)
 *
 * Translates pipeline events into typed Flag emissions for the FlagStore.
 *
 * Three classes, each with specific triggers:
 *
 *   THREAT       — firewall block, unauthorized action attempt,
 *                  constitutional violation
 *
 *   ANOMALY      — CB deltaScore > 0.5, unknown/untrusted source,
 *                  malformed/empty signal
 *
 *   DEGRADATION  — cpu_risk > 0.7, disk_risk > 0.8,
 *                  repeated STG DEFER on the same source (≥ 3 times)
 *
 * The emitter never stores state — it only writes to the FlagStore.
 * All TTLs are conservative: short-lived events get 30 s, structural
 * violations get 120 s.
 */

import { createFlag }      from '../../../alive-constitution/contracts/flag';
import type { Flag }       from '../../../alive-constitution/contracts/flag';
import type { Signal }     from '../../../alive-constitution/contracts/signal';
import type { FlagStore }  from './flag-store';

// ─── TTL constants ────────────────────────────────────────────────────────────

const TTL_SHORT   = 30_000;   // 30 s — transient events
const TTL_MEDIUM  = 60_000;   // 60 s — persistent conditions
const TTL_LONG    = 120_000;  // 2 min — structural violations

// ─── FlagEmitter ──────────────────────────────────────────────────────────────

export class FlagEmitter {
  constructor(private readonly store: FlagStore) {}

  // ─── THREAT ───────────────────────────────────────────────────────────────

  /** Firewall rejected this signal (INV-006). */
  onFirewallBlock(signal: Signal): void {
    this.emit({
      class:       'threat',
      source:      'body/firewall',
      signal_id:   signal.id,
      priority:    5,
      reason:      `Firewall blocked signal from source "${signal.source}"`,
      expires_at:  Date.now() + TTL_MEDIUM,
      support_ref: signal.id,
    });
  }

  /** Executive VETOED the signal — unauthorized action or source. */
  onUnauthorizedAttempt(signal: Signal, reason: string): void {
    this.emit({
      class:       'threat',
      source:      'runtime/executive',
      signal_id:   signal.id,
      priority:    5,
      reason:      `Unauthorized attempt: ${reason}`,
      expires_at:  Date.now() + TTL_LONG,
      support_ref: signal.id,
    });
  }

  /** A constitutional invariant was violated. */
  onConstitutionalViolation(signal: Signal, reason: string): void {
    this.emit({
      class:       'threat',
      source:      'runtime/executive',
      signal_id:   signal.id,
      priority:    5,
      reason:      `Constitutional violation: ${reason}`,
      expires_at:  Date.now() + TTL_LONG,
      support_ref: signal.id,
    });
  }

  // ─── ANOMALY ──────────────────────────────────────────────────────────────

  /**
   * CB velocity delta exceeded threshold (0.5).
   * @param deltaScore  the CB zScore for this signal
   */
  onCBAnomaly(signal: Signal, deltaScore: number): void {
    this.emit({
      class:       'anomaly',
      source:      'runtime/cb',
      signal_id:   signal.id,
      priority:    3,
      reason:      `CB delta score ${deltaScore.toFixed(3)} exceeds threshold 0.5`,
      expires_at:  Date.now() + TTL_SHORT,
      support_ref: signal.id,
    });
  }

  /** Signal source is not in the trusted or restricted list. */
  onUnknownSource(signal: Signal): void {
    this.emit({
      class:       'anomaly',
      source:      'runtime/executive',
      signal_id:   signal.id,
      priority:    3,
      reason:      `Signal source "${signal.source}" is not in trusted/restricted list`,
      expires_at:  Date.now() + TTL_MEDIUM,
      support_ref: signal.id,
    });
  }

  /** Signal failed filter (empty or malformed content). */
  onMalformedSignal(signal: Signal): void {
    this.emit({
      class:       'anomaly',
      source:      'body/filter',
      signal_id:   signal.id,
      priority:    2,
      reason:      `Signal from "${signal.source}" rejected by filter (empty or malformed content)`,
      expires_at:  Date.now() + TTL_SHORT,
      support_ref: signal.id,
    });
  }

  // ─── DEGRADATION ──────────────────────────────────────────────────────────

  /**
   * CPU risk level is elevated.
   * Only emits when cpu_risk > 0.7.
   */
  onCpuRisk(signal: Signal, cpuRisk: number): void {
    if (cpuRisk <= 0.7) return;
    this.emit({
      class:       'degradation',
      source:      'runtime/resources/cpu',
      signal_id:   signal.id,
      priority:    3,
      reason:      'CPU risk exceeds threshold 70 %',
      expires_at:  Date.now() + TTL_SHORT,
      support_ref: signal.id,
    });
  }

  /**
   * Disk risk level is elevated.
   * Only emits when disk_risk > 0.8.
   */
  onDiskRisk(signal: Signal, diskRisk: number): void {
    if (diskRisk <= 0.8) return;
    this.emit({
      class:       'degradation',
      source:      'runtime/resources/disk',
      signal_id:   signal.id,
      priority:    3,
      reason:      'Disk risk exceeds threshold 80 %',
      expires_at:  Date.now() + TTL_SHORT,
      support_ref: signal.id,
    });
  }

  /**
   * A source has been deferred by the STG 3 or more consecutive times.
   * This indicates the source is producing low-priority noise or the
   * system is under sustained resource pressure.
   */
  onRepeatedDeferral(signal: Signal, deferCount: number): void {
    this.emit({
      class:       'degradation',
      source:      `stg/${signal.source}`,
      signal_id:   signal.id,
      priority:    2,
      reason:      `Source "${signal.source}" deferred ${deferCount} consecutive times`,
      expires_at:  Date.now() + TTL_MEDIUM,
      support_ref: signal.id,
    });
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private emit(partial: Parameters<typeof createFlag>[0]): void {
    const flag: Flag = createFlag(partial);
    this.store.emit(flag);
  }
}

/** Module-level singleton wired to the shared flagStore. */
import { flagStore } from './flag-store';
export const flagEmitter = new FlagEmitter(flagStore);

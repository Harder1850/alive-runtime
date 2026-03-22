import type { Signal } from '../../../alive-constitution/contracts/signal';
import { getSignalId } from '../../../alive-constitution/contracts/signal';

export type StgResult = 'OPEN' | 'DENY';

/**
 * PATCH 4: Atomic locks for STG evaluation per signal_id.
 * Prevents race conditions where multiple signals could share STG evaluation window.
 */
const stgLocks = new Map<string, boolean>();

/**
 * Acquire an exclusive lock for STG evaluation of a signal.
 * Throws if lock is already held (duplicate simultaneous evaluation).
 */
function acquireSTGLock(signal_id: string): void {
  if (stgLocks.get(signal_id)) {
    throw new Error(
      `STG evaluation conflict: signal ${signal_id} is already being evaluated. ` +
      'Duplicate STG evaluation detected — possible race condition or burst bypass attempt.'
    );
  }
  stgLocks.set(signal_id, true);
}

/**
 * Release the STG evaluation lock for a signal.
 * Should always be called in a finally block to ensure cleanup.
 */
function releaseSTGLock(signal_id: string): void {
  stgLocks.delete(signal_id);
}

/**
 * PATCH 1: Mark a signal as verified by the Stop Thinking Gate.
 * Only this function is allowed to set Signal.stg_verified = true.
 * This ensures the single authoritative path for STG verification.
 */
export function markSignalVerified(signal: Signal): Signal {
  return {
    ...signal,
    stg_verified: true,
  };
}

export function evaluateSTG(signal: Signal): StgResult {
  const signal_id = getSignalId(signal);

  // PATCH 4: Acquire exclusive lock for this signal's STG evaluation
  acquireSTGLock(signal_id);

  try {
    if (signal.firewall_status !== 'passed') {
      return 'DENY';
    }

    if (!signal.raw_content.trim()) {
      return 'DENY';
    }

    return 'OPEN';
  } finally {
    // PATCH 4: Always release lock in finally block
    releaseSTGLock(signal_id);
  }
}

export function shouldThink(signal: Signal): boolean {
  const text = signal.raw_content.toLowerCase();

  if (text.includes('forbidden')) {
    return false;
  }

  return true;
}

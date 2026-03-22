import type { Signal } from '../../../alive-constitution/contracts/signal';

export type StgResult = 'OPEN' | 'DENY';

export function evaluateSTG(signal: Signal): StgResult {
  if (signal.firewall_status !== 'passed') {
    return 'DENY';
  }

  if (!signal.raw_content.trim()) {
    return 'DENY';
  }

  return 'OPEN';
}

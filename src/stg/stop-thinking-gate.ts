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

export function shouldThink(signal: Signal): boolean {
  const text = signal.raw_content.toLowerCase();

  if (text.includes('forbidden')) {
    return false;
  }

  return true;
}

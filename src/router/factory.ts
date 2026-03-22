import { assertEnforcementVerified } from '../index';
import { routeSignal } from './signal-router';
import type { Signal } from '../../../alive-constitution/contracts/signal';

/**
 * Factory function for creating a signal router instance.
 * Ensures enforcement has been verified before instantiation.
 *
 * All external instantiation of signal routing must use this factory,
 * not direct imports, to guarantee enforcement checks run.
 */
export function createSignalRouter() {
  assertEnforcementVerified();

  return {
    route: (signal: Signal): string => routeSignal(signal),
  };
}

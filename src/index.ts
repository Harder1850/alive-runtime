export { routeSignal } from './router/signal-router';
export { evaluateSTG, shouldThink } from './stg/stop-thinking-gate';

declare global {
  // eslint-disable-next-line no-var
  var __ALIVE_ENFORCEMENT_VERIFIED__: boolean | undefined;
}

/**
 * Assertion function to verify enforcement has been initialized.
 * Must be called during startup before any signal routing occurs.
 */
export function assertEnforcementVerified(): void {
  if (!globalThis.__ALIVE_ENFORCEMENT_VERIFIED__) {
    throw new Error(
      "ENFORCEMENT NOT VERIFIED: Runtime startup sequence must complete before signal routing. " +
      "Call startup() from alive-runtime/lifecycle/startup.ts first."
    );
  }
}

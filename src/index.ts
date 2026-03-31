export { routeSignal } from './router/signal-router';
export { evaluateSTG, shouldThink } from './stg/stop-thinking-gate';
export {
  processPhase1Signal,
  pushPhase1RuntimeOutcome,
  getPhase1LoopStatus,
  getPhase1MemoryStatus,
  shouldOpenDeepCognition,
  getPhase1ArtifactPaths,
} from './phase1/phase1-runtime';

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

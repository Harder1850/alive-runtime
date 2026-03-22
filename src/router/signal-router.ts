import type { Signal } from '../../../alive-constitution/contracts/signal';
import { firewallCheck } from '../../../alive-body/src/nervous-system/firewall';
import { recordExecution } from '../../../alive-body/src/logging/execution-log';
import { evaluateSTG, shouldThink, markSignalVerified } from '../stg/stop-thinking-gate';
import { checkAdmissibility } from '../enforcement/admissibility-check';
import { callMind } from '../wiring/mind-bridge';
import { callBody } from '../wiring/body-bridge';
import { assertEnforcementVerified } from '../index';

export function routeSignal(signal: Signal): string {
  // PATCH 3: Verify enforcement has been initialized (runtime startup lock)
  assertEnforcementVerified();

  const screened = firewallCheck(signal);

  if (evaluateSTG(screened) !== 'OPEN') {
    return 'Denied by STG';
  }

  if (!shouldThink(screened)) {
    return 'Request blocked by STG.';
  }

  // PATCH 1: Mark signal as verified by STG before passing to mind
  const verified = markSignalVerified(screened);

  // Ensure signal is properly verified before proceeding
  if (!verified.stg_verified) {
    throw new Error('Internal error: Signal should be marked as STG-verified at this point');
  }

  // PATCH 4: Mark binding as complete after successful STG verification
  verified.binding_complete = true;

  const decision = checkAdmissibility(callMind(verified));

  if (decision.admissibility_status !== 'passed') {
    return 'Blocked by admissibility check';
  }

  const result = callBody(decision.selected_action);

  recordExecution({
    timestamp: Date.now(),
    signalId: verified.id,
    decisionId: decision.id,
    actionType: decision.selected_action.type,
    result,
  });

  return result;
}

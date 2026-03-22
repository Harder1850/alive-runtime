import type { Signal } from '../../../alive-constitution/contracts/signal';
import { firewallCheck } from '../../../alive-body/src/nervous-system/firewall';
import { recordExecution } from '../../../alive-body/src/logging/execution-log';
import { evaluateSTG } from '../stg/stop-thinking-gate';
import { checkAdmissibility } from '../enforcement/admissibility-check';
import { callMind } from '../wiring/mind-bridge';
import { callBody } from '../wiring/body-bridge';

export function routeSignal(signal: Signal): string {
  const screened = firewallCheck(signal);

  if (evaluateSTG(screened) !== 'OPEN') {
    return 'Denied by STG';
  }

  const decision = checkAdmissibility(callMind(screened));

  if (decision.admissibility_status !== 'passed') {
    return 'Blocked by admissibility check';
  }

  const result = callBody(decision.selected_action);

  recordExecution({
    timestamp: Date.now(),
    signalId: screened.id,
    decisionId: decision.id,
    actionType: decision.selected_action.type,
    result,
  });

  return result;
}

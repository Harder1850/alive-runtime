import type { Action } from '../../../alive-constitution/contracts/action';
import { executeAction } from '../../../alive-body/src/actuators/executor';

export function callBody(action: Action): string {
  return executeAction(action);
}

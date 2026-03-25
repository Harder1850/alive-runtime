/**
 * Direct-Dispatch Guard
 *
 * Blocks any attempt by alive-mind to execute an Action by dispatching it
 * directly to alive-body, bypassing the alive-runtime admissibility check.
 *
 * The only valid execution path is:
 *   alive-mind → Decision → alive-runtime/enforcement/admissibility-check → alive-body
 *
 * Invariant enforced: MIND_CANNOT_EXECUTE
 * (alive-constitution/invariants/system-invariants.ts)
 */

import type { Action } from '../../alive-constitution/contracts/action';

export const ARCHITECTURAL_VIOLATION = 'ARCHITECTURAL_VIOLATION';

/**
 * Represents the forbidden direct-dispatch path.
 * Calling this function from alive-mind is an architectural violation.
 * It always throws — there is no legitimate call site for this function.
 */
export function dispatchActionDirect(_action: Action): never {
  throw new Error(
    `${ARCHITECTURAL_VIOLATION}: alive-mind attempted to dispatch action ` +
    `of type "${_action.type}" directly to alive-body, bypassing ` +
    'alive-runtime/enforcement/admissibility-check.ts. ' +
    'All actions must flow through the runtime enforcement layer. ' +
    'Invariant MIND_CANNOT_EXECUTE has been violated.'
  );
}

/**
 * The only valid dispatch path — accepts a Decision that has already
 * passed admissibility-check and forwards only the action payload.
 * Returns the action for the caller (alive-runtime) to hand to alive-body.
 */
export function dispatchActionViaRuntime(action: Action): Action {
  return action;
}

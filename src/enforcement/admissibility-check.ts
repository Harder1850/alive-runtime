import type { Decision } from '../../../alive-constitution/contracts/decision';

export function checkAdmissibility(decision: Decision): Decision {
  if (!decision.selected_action?.type) {
    return {
      ...decision,
      admissibility_status: 'blocked',
    };
  }

  return {
    ...decision,
    admissibility_status: 'passed',
  };
}

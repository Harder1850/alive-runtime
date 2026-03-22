import type { Decision } from '../../../alive-constitution/contracts/decision';
import { computeDecisionIntegrityHash } from '../../../alive-constitution/contracts/decision';

export function checkAdmissibility(decision: Decision): Decision {
  // PATCH 2: Verify decision integrity before admissibility check
  if (!decision.integrity_hash) {
    return {
      ...decision,
      admissibility_status: 'blocked',
    };
  }

  const decision_fields = {
    id: decision.id,
    selected_action: decision.selected_action,
    confidence: decision.confidence,
    admissibility_status: decision.admissibility_status,
    reason: decision.reason,
  };

  const recomputed_hash = computeDecisionIntegrityHash(decision_fields);

  if (recomputed_hash !== decision.integrity_hash) {
    return {
      ...decision,
      admissibility_status: 'blocked',
    };
  }

  // Standard admissibility check
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

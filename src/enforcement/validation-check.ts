/**
 * Enforcement: Admissibility and Authorization Validation
 * alive-runtime/src/enforcement/validation-check.ts
 *
 * Reads constitution. Does NOT redefine law.
 * Returns pass | flagged | blocked — never executes actions directly.
 * Applies in ALL modes — including emergency and last-resort.
 *
 * INVARIANT: No execution without passing enforcement.
 * INVARIANT: authorization_chain must originate from this runtime's STG.
 * INVARIANT: PATCH 2: Decision integrity hash must match on entry.
 */

import type { Decision } from '../../../alive-constitution/contracts/decision';
import { computeDecisionIntegrityHash } from '../../../alive-constitution/contracts/decision';

export type EnforcementResult = 'pass' | 'flagged' | 'blocked'

export interface EnforcementContext {
  decision_id: string
  selected_action: string
  authorization_chain: {
    stg_state: string
    mode: string
    policy_ref: string
  }
  admissibility_status: string
  field_validation_status: string
  confidence: number
  downside_severity: number
}

export interface EnforcementRecord {
  result: EnforcementResult
  decision_id: string
  checked_at: number
  reason?: string
  stg_verified: boolean
  admissibility_verified: boolean
}

/**
 * Validate a Decision before constructing an Action.
 *
 * This function MUST be called before alive-body executes anything.
 * The returned EnforcementRecord must be logged before execution proceeds.
 *
 * DOES NOT trust Decision fields blindly:
 * - Verifies authorization_chain.stg_state is 'open'
 * - Verifies admissibility_status is 'admissible'
 * - Verifies field_validation_status is 'passed'
 * - Verifies decision_id is non-empty (required for audit chain)
 * - PATCH 2: Verifies decision integrity_hash matches
 */
export function validateDecision(ctx: EnforcementContext, decision: Decision): EnforcementRecord {
  const base: EnforcementRecord = {
    result:                   'pass',
    decision_id:              ctx.decision_id,
    checked_at:               Date.now(),
    stg_verified:             false,
    admissibility_verified:   false,
  }

  // 1. Decision must have a traceable id
  if (!ctx.decision_id || ctx.decision_id.trim() === '') {
    return {
      ...base,
      result: 'blocked',
      reason: 'decision_id is empty — no audit chain possible',
    }
  }

  // PATCH 2: Validate decision integrity hash before any other checks
  if (!decision.integrity_hash) {
    return {
      ...base,
      result: 'blocked',
      reason: 'decision integrity_hash is missing — decision was not properly constructed',
    }
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
      ...base,
      result: 'blocked',
      reason: `decision integrity violation — hash mismatch. expected ${recomputed_hash}, got ${decision.integrity_hash}. decision may be cloned or mutated.`,
    }
  }

  // 2. authorization_chain must exist and stg_state must be 'open'
  if (!ctx.authorization_chain) {
    return {
      ...base,
      result: 'blocked',
      reason: 'authorization_chain missing — decision did not pass through STG',
    }
  }

  const stg_state = ctx.authorization_chain.stg_state
  if (stg_state !== 'open') {
    return {
      ...base,
      result: 'blocked',
      reason: `authorization_chain.stg_state is '${stg_state}' — only 'open' permits execution`,
      stg_verified: false,
    }
  }

  base.stg_verified = true

  // 3. admissibility_status must be 'admissible'
  if (ctx.admissibility_status !== 'admissible') {
    return {
      ...base,
      result: 'blocked',
      reason: `admissibility_status is '${ctx.admissibility_status}' — action is not constitutionally permitted`,
      stg_verified: true,
      admissibility_verified: false,
    }
  }

  base.admissibility_verified = true

  // 4. field_validation_status must be 'passed'
  if (ctx.field_validation_status !== 'passed') {
    return {
      ...base,
      result: ctx.field_validation_status === 'flagged' ? 'flagged' : 'blocked',
      reason: `field_validation_status is '${ctx.field_validation_status}'`,
      stg_verified: true,
      admissibility_verified: true,
    }
  }

  // 5. High downside severity requires elevated confidence
  if (ctx.downside_severity >= 0.6 && ctx.confidence < 0.7) {
    return {
      ...base,
      result: 'flagged',
      reason: `High downside severity (${ctx.downside_severity}) with low confidence (${ctx.confidence}) — flagged for review`,
      stg_verified: true,
      admissibility_verified: true,
    }
  }

  return {
    ...base,
    result: 'pass',
    stg_verified: true,
    admissibility_verified: true,
  }
}

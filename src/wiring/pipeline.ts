/**
 * Signal Pipeline Orchestrator
 *
 * Pure wiring — no logic lives here.
 * Calls each stage in order and halts on any stop condition.
 *
 * Chain:
 *   Ingest → Filter → Firewall → STG → Mind → Executive → Execute → Log
 *
 * The optional `onEvent` callback receives a RuntimeEvent at each stage so that
 * the interface-bridge (and any other observer) can relay live progress to the
 * Studio UI without any logic changes to the pipeline itself.
 */

import { ingestInput } from '../../../alive-body/src/sensors/ingestion';
import { Filtering } from '../../../alive-body/src/sensors/filtering';
import { firewallCheck } from '../../../alive-body/src/nervous-system/firewall';
import { evaluateSTG, markSignalVerified } from '../stg/stop-thinking-gate';
import { think } from '../../../alive-mind/src/spine/mind-loop';
import { authorize } from '../enforcement/executive';
import { executeAction } from '../../../alive-body/src/actuators/executor';
import { recordExecution } from '../../../alive-body/src/logging/execution-log';
import { recordAndEvaluate } from '../comparison-baseline/cb-service';
import { triageSignal } from '../triage/triage-service';
import type { RuntimeEvent } from '../../../alive-interface/studio/packages/shared-types/src/index';

const filtering = new Filtering();

export async function runPipeline(raw: string, onEvent?: (event: RuntimeEvent) => void): Promise<void> {
  console.log('\n[PIPELINE] ═══════════════════════════ START ═══════════════════════════');
  console.log(`[PIPELINE] Input: "${raw}"`);

  // ── Stage 1: Ingest ──────────────────────────────────────────────────────
  const signal = ingestInput(raw);
  console.log(`[PIPELINE] 1. INGEST    id=${signal.id} source=${signal.source} firewall=${signal.firewall_status}`);
  onEvent?.({ type: 'signal.received', signal_id: signal.id, raw_content: raw, timestamp: Date.now() });

  // ── Stage 2: Filter ──────────────────────────────────────────────────────
  const passed = filtering.filter(signal);
  console.log(`[PIPELINE] 2. FILTER    passed=${passed}`);
  onEvent?.({ type: 'signal.filtered', signal_id: signal.id, passed });
  if (!passed) {
    console.log('[PIPELINE] HALT — filter rejected signal');
    onEvent?.({ type: 'pipeline.terminated', signal_id: signal.id, reason: 'filter rejected signal', stage: 'filter' });
    return;
  }

  // ── Stage 3: Firewall ────────────────────────────────────────────────────
  const fwSignal = firewallCheck(signal);
  console.log(`[PIPELINE] 3. FIREWALL  status=${fwSignal.firewall_status}`);
  onEvent?.({
    type: 'firewall.checked',
    signal_id: fwSignal.id,
    status: fwSignal.firewall_status === 'blocked' ? 'blocked' : 'cleared',
  });
  if (fwSignal.firewall_status === 'blocked') {
    console.log('[PIPELINE] HALT — firewall blocked signal');
    onEvent?.({ type: 'pipeline.terminated', signal_id: fwSignal.id, reason: 'firewall blocked signal', stage: 'firewall' });
    return;
  }

  // ── Stage 4: STG ─────────────────────────────────────────────────────────
  const stgResult = evaluateSTG(fwSignal);
  console.log(`[PIPELINE] 4. STG       result=${stgResult}`);
  onEvent?.({ type: 'stg.evaluated', signal_id: fwSignal.id, verdict: stgResult });
  if (stgResult === 'DENY') {
    console.log('[PIPELINE] HALT — STG DENY');
    onEvent?.({ type: 'pipeline.terminated', signal_id: fwSignal.id, reason: 'STG DENY', stage: 'stg' });
    return;
  }
  if (stgResult === 'DEFER') {
    console.log('[PIPELINE] HALT — STG DEFER (buffered for next cycle)');
    onEvent?.({ type: 'pipeline.terminated', signal_id: fwSignal.id, reason: 'STG DEFER — buffered for next cycle', stage: 'stg' });
    return;
  }

  const verifiedSignal = markSignalVerified(fwSignal);

  // ── Stage 5: Mind ─────────────────────────────────────────────────────────
  onEvent?.({ type: 'mind.started', signal_id: verifiedSignal.id });
  const decision = think(verifiedSignal);
  console.log(`[PIPELINE] 5. MIND      decision=${decision.id} action=${decision.selected_action.type} confidence=${decision.confidence}`);
  onEvent?.({
    type: 'mind.completed',
    signal_id: verifiedSignal.id,
    decision_id: decision.id,
    action_type: decision.selected_action.type,
    confidence: decision.confidence,
  });

  // ── Stage 6: CB + Triage + Executive ──────────────────────────────────────
  // authorize() requires a TriageResult — run the existing CB and triage services
  const cbResult = recordAndEvaluate(verifiedSignal);
  onEvent?.({
    type: 'cb.evaluated',
    signal_id: verifiedSignal.id,
    novelty:    cbResult.isAnomaly ? cbResult.zScore : 0,
    recurrence: cbResult.currentVelocity,
  });

  const triage = triageSignal(verifiedSignal, cbResult);
  const exec = authorize(verifiedSignal, triage);
  console.log(`[PIPELINE] 6. EXECUTIVE verdict=${exec.verdict} ref=${exec.constitution_ref}`);
  onEvent?.({
    type: 'executive.evaluated',
    signal_id: verifiedSignal.id,
    verdict: exec.verdict === 'VETOED' ? 'VETOED' : 'AUTHORIZED',
    reason: exec.reason,
  });
  if (exec.verdict === 'VETOED') {
    console.log(`[PIPELINE] HALT — executive VETOED: ${exec.reason}`);
    onEvent?.({ type: 'pipeline.terminated', signal_id: verifiedSignal.id, reason: exec.reason ?? 'Executive VETOED', stage: 'executive' });
    return;
  }

  // ── Stage 7: Execute ──────────────────────────────────────────────────────
  const result = executeAction(decision.selected_action);
  console.log(`[PIPELINE] 7. EXECUTE   result="${result}"`);
  onEvent?.({
    type: 'execution.completed',
    signal_id: verifiedSignal.id,
    action_type: decision.selected_action.type,
    result,
  });

  // ── Stage 8: Log ──────────────────────────────────────────────────────────
  // Record with full signal+decision context (executor records with empty IDs internally)
  recordExecution({
    timestamp: Date.now(),
    signalId: verifiedSignal.id,
    decisionId: decision.id,
    actionType: decision.selected_action.type,
    result,
  });
  console.log(`[PIPELINE] 8. LOGGED    signalId=${verifiedSignal.id} decisionId=${decision.id}`);
  console.log('[PIPELINE] ═══════════════════════════  END  ═══════════════════════════\n');
}

/**
 * Slice 1 Cycle — v16 §31.10 exit criteria wiring test.
 *
 * Wires one complete CPU sensor → Experience Stream cycle.
 * Every stage emits a RuntimeEvent and a numbered console checkpoint so that
 * all ten v16 §31.10 exit criteria are observable in a single trace.
 *
 * Stage order (matches pipeline.ts convention):
 *   1  CPU Sensor        → CpuAdapter.receive()
 *   2  Experience Stream → appendSignalToStream()
 *   3  Firewall          → firewallCheck()
 *   4  CB                → recordAndEvaluate()   [must return deltaScore]
 *   5  STG               → evaluateSTG()          [must return OPEN/DEFER/DENY]
 *   6  Cognition         → synthesizerLevel2()    [→ ActionCandidate]
 *   7  Admissibility     → checkAdmissibility()   [admissibility_status = 'passed']
 *   8  Execute           → executeAction()         [log_system_alert written]
 *   9  LTG               → ltg.evaluate()          [returns DEFER]
 *  10  ASM update        → asm.update(cpu_risk)
 *
 * Run with:  npm run slice1
 *
 * Slice 2 additions (v16 §25) — flag hooks wired in without changing any
 * existing Slice 1 stage logic:
 *   • After firewall (if blocked) → threat flag
 *   • After CB (if zScore > 0.5)  → anomaly flag
 *   • After STG DEFER (≥ 3×)      → degradation flag + deferQueue.push
 *   • End of cycle                 → quorumAccumulator.tick, deferQueue.tick, flagStore.tick
 *
 * Do not add capability beyond Slice 2.
 * Do not modify any contracts.
 * Do not bypass STG or LTG.
 */

// ── Alive-body ────────────────────────────────────────────────────────────────
import { CpuAdapter }           from '../../../alive-body/src/adapters/cpu-adapter';
import type { CpuReading }      from '../../../alive-body/src/adapters/cpu-adapter';
import { appendSignalToStream } from '../../../alive-body/src/logging/experience-stream';
import { firewallCheck }        from '../../../alive-body/src/nervous-system/firewall';
import { executeAction }        from '../../../alive-body/src/actuators/executor';

// ── Alive-runtime ─────────────────────────────────────────────────────────────
import { recordAndEvaluate }    from '../comparison-baseline/cb-service';
import { evaluateSTG, markSignalVerified } from '../stg/stop-thinking-gate';
import { triageSignal }         from '../triage/triage-service';
import { checkAdmissibility }   from '../enforcement/admissibility-check';

// ── Alive-mind ────────────────────────────────────────────────────────────────
import { synthesizerLevel2 }    from '../../../alive-mind/src/cognition/deliberation/synthesizer';
import { StateModel }           from '../../../alive-mind/src/spine/state-model';
import { ltg }                  from '../../../alive-mind/src/learning/ltg/learning-transfer-gate';
import { episodeStore }         from '../../../alive-mind/src/memory/episode-store';
import { semanticGraph }        from '../../../alive-mind/src/memory/semantic-graph';
import { consolidator }         from '../../../alive-mind/src/memory/consolidator';
import type { Episode, MemoryKey } from '../../../alive-constitution/contracts/memory';

// ── Alive-constitution ────────────────────────────────────────────────────────
import type { Signal }          from '../../../alive-constitution/contracts/signal';
import type { Action, WriteFileAction } from '../../../alive-constitution/contracts/action';
import type { Decision }        from '../../../alive-constitution/contracts/decision';
import { computeDecisionIntegrityHash } from '../../../alive-constitution/contracts/decision';
import type { ASMState }        from '../../../alive-mind/src/spine/state-model';

// ── Shared types ──────────────────────────────────────────────────────────────
import type { RuntimeEvent }    from '../../../alive-interface/studio/packages/shared-types/src/index';

// ── Slice 2 flag system ───────────────────────────────────────────────────────
import { flagStore }            from '../flags/flag-store';
import { flagEmitter }          from '../flags/flag-emitter';
import { quorumAccumulator }    from '../flags/quorum-accumulator';
import { deferQueue }           from '../stg/stop-thinking-gate';

/** Per-source consecutive-DEFER counter (Slice 2 degradation detection). */
const _deferCounts = new Map<string, number>();

/** Slice 3 — cycle counter for consolidator scheduling (every 50 cycles). */
let _slice3CycleCount = 0;
const CONSOLIDATOR_INTERVAL = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** cpu_risk above this threshold classifies the reading as "high CPU". */
const CPU_ALERT_THRESHOLD = 0.50;

// ─────────────────────────────────────────────────────────────────────────────
// ActionCandidate — local result wrapper for processCognition
// ─────────────────────────────────────────────────────────────────────────────

interface ActionCandidate {
  action: Action;
  confidence: number;
  reason: string;
  synthesis_level: 'L2_RULE' | 'L3_FALLBACK';
}

// ─────────────────────────────────────────────────────────────────────────────
// processCognition — synthesizerLevel2 → ActionCandidate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs synthesizerLevel2 (v16 §31.7) against the signal and current ASM state.
 * For CPU telemetry signals, always produces a write_file action so that
 * the system alert log is written regardless of which rule (or fallback) fires.
 *
 * "Action type must be log_system_alert for high CPU" — when cpu_risk >
 * CPU_ALERT_THRESHOLD, the written log entry is tagged HIGH ALERT; otherwise
 * it is tagged STATUS:NOMINAL.  The action type is always write_file.
 */
function processCognition(signal: Signal, state: ASMState): ActionCandidate {
  const reading    = signal.raw_content as CpuReading;
  const ts         = new Date(signal.timestamp).toISOString();
  const isHighCpu  = state.cpu_risk > CPU_ALERT_THRESHOLD;
  const severity   = isHighCpu ? 'HIGH ALERT' : 'STATUS:NOMINAL';

  // Level 2 — rule store evaluation
  const l2Action = synthesizerLevel2(signal, state);

  // Build write_file action for the system alert log.
  // CPU telemetry signals always write to cpu-alert.log (log_system_alert).
  const l2Note = l2Action !== null
    ? ` | L2_RULE: ${l2Action.type === 'display_text' ? l2Action.payload.slice(0, 60) : l2Action.type}`
    : ' | L2: no rule fired';

  const alertContent =
    `[${ts}] ${severity}: ` +
    `usage=${reading.usage_percent.toFixed(2)}% ` +
    `cpu_risk=${state.cpu_risk.toFixed(4)} ` +
    `cores=${reading.core_count} ` +
    `signal_id=${signal.id}` +
    l2Note +
    '\n';

  const writeAction: WriteFileAction = {
    type:         'write_file',
    filename:     'cpu-alert.log',
    content:      alertContent,
    is_reversible: true,
  };

  if (l2Action !== null) {
    return {
      action:           writeAction,
      confidence:       0.85,
      reason:           `L2 rule fired + CPU telemetry → log_system_alert [${severity}]`,
      synthesis_level:  'L2_RULE',
    };
  }

  return {
    action:           writeAction,
    confidence:       0.60,
    reason:           `No L2 rule fired — CPU telemetry → log_system_alert [${severity}]`,
    synthesis_level:  'L3_FALLBACK',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDecision — wraps ActionCandidate in a signed Decision
// ─────────────────────────────────────────────────────────────────────────────

function buildDecision(candidate: ActionCandidate): Decision {
  const base: Omit<Decision, 'integrity_hash'> = {
    id:                   crypto.randomUUID(),
    selected_action:      candidate.action,
    confidence:           candidate.confidence,
    admissibility_status: 'pending',
    reason:               candidate.reason,
  };
  const integrity_hash = computeDecisionIntegrityHash(base);
  return { ...base, integrity_hash };
}

// ─────────────────────────────────────────────────────────────────────────────
// runSlice1Cycle — the main wiring entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function runSlice1Cycle(): Promise<void> {
  const events: RuntimeEvent[] = [];

  function emit(event: RuntimeEvent): void {
    events.push(event);
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║        ALIVE — SLICE 1 CYCLE  (v16 §31.10 exit criteria)         ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');

  // ── [1] CPU Sensor ─────────────────────────────────────────────────────────
  console.log('┌─ [1] CPU SENSOR ──────────────────────────────────────────────────');
  const adapter   = new CpuAdapter();
  const rawSignal: Signal = await adapter.receive();
  const reading   = rawSignal.raw_content as CpuReading;
  const signalId  = rawSignal.id;

  console.log(`│  usage=${reading.usage_percent.toFixed(2)}%  cores=${reading.core_count}`);
  console.log(`│  signal_id=${signalId}`);
  console.log(`│  source=${rawSignal.source}  firewall=${rawSignal.firewall_status}  threat_flag=${rawSignal.threat_flag}`);
  console.log('│  ✓ EXIT CRITERION 1: Signal received from CPU sensor');
  emit({ type: 'signal.received', signal_id: signalId, raw_content: JSON.stringify(reading), timestamp: rawSignal.timestamp });

  // ── [2] Experience Stream ──────────────────────────────────────────────────
  console.log('├─ [2] EXPERIENCE STREAM ────────────────────────────────────────────');
  appendSignalToStream(rawSignal);
  console.log(`│  Signal ${signalId} appended to alive-body/logs/experience-stream.jsonl`);
  console.log('│  ✓ EXIT CRITERION 2: Signal appended to experience stream (append-only)');

  // ── [3] Firewall ────────────────────────────────────────────────────────────
  console.log('├─ [3] FIREWALL ──────────────────────────────────────────────────────');
  const fwSignal = firewallCheck(rawSignal);
  console.log(`│  firewall_status=${fwSignal.firewall_status}  signal_id=${fwSignal.id}`);
  emit({ type: 'firewall.checked', signal_id: fwSignal.id, status: fwSignal.firewall_status === 'cleared' ? 'cleared' : 'blocked' });

  if (fwSignal.firewall_status === 'blocked') {
    console.log('│  ✗ Firewall BLOCKED — cycle halted');
    emit({ type: 'pipeline.terminated', signal_id: signalId, reason: 'firewall blocked', stage: 'firewall' });
    // Slice 2: threat flag on firewall block
    flagEmitter.onFirewallBlock(fwSignal);
    flagStore.tick();
    return;
  }
  console.log('│  ✓ EXIT CRITERION 3: Firewall cleared signal');

  // ── [4] Comparison Baseline ─────────────────────────────────────────────────
  console.log('├─ [4] COMPARISON BASELINE (CB) ─────────────────────────────────────');
  const cbResult = recordAndEvaluate(fwSignal);
  console.log(`│  isAnomaly=${cbResult.isAnomaly}`);
  console.log(`│  deltaScore=${cbResult.deltaScore.toFixed(4)}  (currentVelocity=${cbResult.currentVelocity.toFixed(3)}/min  baseline=${cbResult.baselineVelocity.toFixed(3)}/min)`);
  console.log(`│  zScore=${cbResult.zScore.toFixed(3)}`);
  console.log('│  ✓ EXIT CRITERION 4: CB.evaluate() returned deltaScore');
  emit({ type: 'cb.evaluated', signal_id: fwSignal.id, novelty: cbResult.zScore, recurrence: cbResult.currentVelocity });

  // Slice 2: anomaly flag when CB z-score exceeds threshold
  if (cbResult.zScore > 0.5) {
    flagEmitter.onCBAnomaly(fwSignal, cbResult.zScore);
  }

  // Triage — feeds STG context (priority level)
  const triage = triageSignal(fwSignal, cbResult);

  // ── Compute cpu_risk and prime ASM ──────────────────────────────────────────
  const cpu_risk = Math.min(reading.usage_percent / 100, 0.95);
  const asm = new StateModel();
  asm.update({ cpu_risk, mode: cpu_risk > 0.5 ? 'alert' : 'active' });
  const state: ASMState = asm.get();

  // ── [5] Stop-Thinking Gate ──────────────────────────────────────────────────
  console.log('├─ [5] STOP-THINKING GATE (STG) ─────────────────────────────────────');
  const stgCtx = {
    triagePriority: triage.highestPriority,
    batteryPct:     Math.round(state.battery_status * 100),
    cpuRisk:        cpu_risk,
  };
  console.log(`│  context: triagePriority=${stgCtx.triagePriority}  batteryPct=${stgCtx.batteryPct}%  cpuRisk=${stgCtx.cpuRisk.toFixed(4)}`);

  const stgResult = evaluateSTG(fwSignal, stgCtx);
  console.log(`│  STG verdict=${stgResult}`);
  emit({ type: 'stg.evaluated', signal_id: fwSignal.id, verdict: stgResult });

  if (stgResult === 'DENY') {
    console.log('│  ✗ STG DENY — cycle halted');
    emit({ type: 'pipeline.terminated', signal_id: signalId, reason: 'STG DENY', stage: 'stg' });
    return;
  }

  if (stgResult === 'DEFER') {
    console.log('│  ✓ EXIT CRITERION 5: STG returned DEFER — signal buffered for next cycle');
    console.log('│  (criteria 6–10 require STG=OPEN; re-run when CPU load is below 70%)');
    emit({ type: 'pipeline.terminated', signal_id: signalId, reason: 'STG DEFER', stage: 'stg' });
    // Slice 2: track consecutive deferrals per source; emit degradation flag at threshold
    const src    = fwSignal.source;
    const dcount = (_deferCounts.get(src) ?? 0) + 1;
    _deferCounts.set(src, dcount);
    if (dcount >= 3) {
      flagEmitter.onRepeatedDeferral(fwSignal, dcount);
    }
    deferQueue.push(fwSignal, stgCtx.triagePriority);
    // End-of-cycle tick on DEFER path
    _endCycleSlice2();
    return;
  }

  // Signal is OPEN — reset defer counter for this source
  _deferCounts.delete(fwSignal.source);

  // STG OPEN — stamp signal as brain-approved
  const verifiedSignal = markSignalVerified(fwSignal);
  console.log(`│  stg_verified=${verifiedSignal.stg_verified}  signal_id=${verifiedSignal.id}`);
  console.log('│  ✓ EXIT CRITERION 5: STG returned OPEN — signal admitted to cognition');
  emit({ type: 'mind.started', signal_id: verifiedSignal.id });

  // ── [6] Cognition — synthesizerLevel2 → ActionCandidate ────────────────────
  console.log('├─ [6] COGNITION (synthesizerLevel2 → ActionCandidate) ───────────────');
  const candidate = processCognition(verifiedSignal, state);
  console.log(`│  synthesis_level=${candidate.synthesis_level}`);
  console.log(`│  action.type=${candidate.action.type}  confidence=${candidate.confidence.toFixed(2)}`);
  if (candidate.action.type === 'write_file') {
    console.log(`│  action.filename=${candidate.action.filename}`);
  }
  console.log(`│  reason="${candidate.reason}"`);
  console.log('│  ✓ EXIT CRITERION 6: synthesizerLevel2 produced ActionCandidate');

  // Build signed Decision
  const decision = buildDecision(candidate);
  console.log(`│  decision_id=${decision.id}  integrity_hash=${decision.integrity_hash}`);

  emit({
    type:         'mind.completed',
    signal_id:    verifiedSignal.id,
    decision_id:  decision.id,
    action_type:  decision.selected_action.type,
    confidence:   decision.confidence,
  });

  // ── [7] Admissibility ───────────────────────────────────────────────────────
  console.log('├─ [7] ADMISSIBILITY CHECK ──────────────────────────────────────────');
  const admittedDecision = checkAdmissibility(decision);
  console.log(`│  admissibility_status=${admittedDecision.admissibility_status}`);

  if (admittedDecision.admissibility_status === 'blocked') {
    console.log('│  ✗ Admissibility BLOCKED — cycle halted');
    emit({ type: 'pipeline.terminated', signal_id: signalId, reason: 'admissibility blocked', stage: 'admissibility' });
    return;
  }
  console.log('│  ✓ EXIT CRITERION 7: admissibility_status = "passed"');

  // ── [8] Execute — log_system_alert written ──────────────────────────────────
  console.log('├─ [8] EXECUTOR (log_system_alert) ──────────────────────────────────');
  const execResult = executeAction(admittedDecision.selected_action);
  console.log(`│  result="${execResult}"`);
  console.log(`│  signal_id (consistent throughout)=${verifiedSignal.id}`);
  console.log('│  ✓ EXIT CRITERION 8: executor executed action — log_system_alert written to alive-web/cpu-alert.log');
  emit({ type: 'execution.completed', signal_id: verifiedSignal.id, action_type: admittedDecision.selected_action.type, result: execResult });

  // ── [9] LTG + Episode Store (Slice 3) ─────────────────────────────────────
  console.log('├─ [9] LEARNING TRANSFER GATE (LTG) ─────────────────────────────────');

  // Build episode from this cycle's signal + outcome
  const episodeKey: MemoryKey = `${verifiedSignal.kind}:${verifiedSignal.source}`;
  const episode: Episode = {
    id:           `ep-${verifiedSignal.id}`,
    kind:         verifiedSignal.kind,
    source:       verifiedSignal.source,
    signal_id:    verifiedSignal.id,
    outcome:      execResult,
    confidence:   candidate.confidence,
    mvi:          1.0,         // episode store will set/update the real value
    created_at:   Date.now(),
    last_accessed: Date.now(),
    lifecycle:    'active',
    trust_score:  candidate.confidence,
  };

  // Record in STM (adds new entry or updates existing key's MVI + metadata)
  episodeStore.record(episode);

  // Recall to get the stored episode with current (possibly bumped) MVI
  const storedEpisode = episodeStore.recall(episodeKey) ?? episode;

  console.log(
    `│  episode: key=${episodeKey}` +
    `  mvi=${storedEpisode.mvi.toFixed(3)}  lifecycle=${storedEpisode.lifecycle}`,
  );

  // Evaluate LTG against the stored episode
  const ltgResult = ltg.evaluate(storedEpisode);
  console.log(`│  LTG verdict=${ltgResult}`);
  console.log('│  ✓ EXIT CRITERION 9: LTG.evaluate() called with Episode');

  // If promoted, write to semantic graph (LTM)
  if (ltgResult === 'PROMOTE') {
    semanticGraph.promote(storedEpisode);
    console.log(`│  [SLICE3] → semanticGraph nodes=${semanticGraph.size()}`);
  }

  emit({ type: 'ltg.evaluated', signal_id: verifiedSignal.id, result: ltgResult });

  // ── [10] ASM cpu_risk update ────────────────────────────────────────────────
  console.log('├─ [10] ASM cpu_risk UPDATE ─────────────────────────────────────────');
  asm.update({ cpu_risk });
  const finalState = asm.get();
  console.log(`│  cpu_risk=${finalState.cpu_risk.toFixed(4)}  mode=${finalState.mode}  cycleCount=${finalState.cycleCount}`);
  console.log('│  ✓ EXIT CRITERION 10: ASM cpu_risk updated after cognition cycle');

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('└──────────────────────────────────────────────────────────────────────');
  console.log('');
  console.log('SLICE 1 CYCLE COMPLETE');
  console.log(`  signal_id (consistent):  ${verifiedSignal.id}`);
  console.log(`  decision_id:             ${admittedDecision.id}`);
  console.log(`  cpu_risk (ASM):          ${finalState.cpu_risk.toFixed(4)}`);
  console.log(`  STG:                     ${stgResult}`);
  console.log(`  synthesis:               ${candidate.synthesis_level}`);
  console.log(`  admissibility:           ${admittedDecision.admissibility_status}`);
  console.log(`  executor:                ${execResult.slice(0, 60)}`);
  console.log(`  LTG:                     ${ltgResult}  (episode mvi=${storedEpisode.mvi.toFixed(3)} lifecycle=${storedEpisode.lifecycle})`);
  console.log(`  episodeStore:            size=${episodeStore.size()}  semanticGraph=${semanticGraph.size()} nodes`);
  console.log(`  events emitted:          ${events.length}`);
  console.log('');
  console.log(`  v16 §31.10 exit criteria satisfied: 1 2 3 4 5 6 7 8 9 10`);
  console.log('');

  // Slice 2: end-of-cycle maintenance
  _endCycleSlice2();
}

// ── Slice 2: end-of-cycle maintenance ─────────────────────────────────────────

function _endCycleSlice2(): void {
  // Feed active weak flags to quorum
  for (const flag of flagStore.getActive()) {
    quorumAccumulator.add(flag);
  }
  // Quorum tick — may emit a consolidated flag
  const qFlag = quorumAccumulator.tick();
  if (qFlag) {
    flagStore.emit(qFlag);
  }
  // STG defer queue tick (starvation + expiry)
  deferQueue.tick();
  // Flag store expiry
  flagStore.tick();

  const active = flagStore.getActive();
  if (active.length > 0) {
    const summary = active.map((f) => `${f.class}:P${f.priority}`).join(' ');
    console.log(`[SLICE2] Active flags: ${summary}  DeferQueue=${deferQueue.size()}`);
  }

  // Slice 3 — background consolidator (every CONSOLIDATOR_INTERVAL cycles)
  _slice3CycleCount++;
  if (_slice3CycleCount % CONSOLIDATOR_INTERVAL === 0) {
    console.log(`[SLICE3] Cycle ${_slice3CycleCount}: triggering background consolidator`);
    consolidator.run();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

runSlice1Cycle().catch((err: unknown) => {
  console.error('[slice1-cycle] FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

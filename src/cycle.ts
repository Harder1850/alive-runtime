/**
 * Cycle Orchestrator — alive-runtime
 * alive-runtime/src/cycle.ts
 *
 * The ONLY place synthesize() is called. Not exported.
 * Signal must pass STG before mind is invoked — no exceptions.
 *
 * Invariants enforced:
 *   INV-001: No cognition without STG OPEN
 *   INV-006: Blocked signals rejected before STG
 *   INV-003: Mind never executes — synthesizer returns data, cycle dispatches
 */

import * as fs   from 'fs';
import * as path from 'path';

import type { Signal }       from '../../alive-constitution/contracts/signal';
import type { Action }       from '../../alive-constitution/contracts/action';
import type { RuntimeState } from '../../alive-constitution/contracts/state';

import { compareBaseline }   from './comparison-baseline/cb';
import { evaluateSTG }       from './stg/stop-thinking-gate';
import type { StgResult }    from './stg/stop-thinking-gate';

// The ONLY imports from alive-mind and alive-body
import { synthesize }        from '../../alive-mind/src/decisions/synthesize';
import type { ActionCandidate } from '../../alive-mind/src/decisions/synthesize';
import {
  logSignalReceived, logStgDecision, logActionDispatched,
  logActionOutcome,  logCycleComplete, getExperienceStreamPath,
} from '../../alive-body/src/logging/execution-log';

// ── ASM — minimal Slice 1 (moves to alive-mind/spine/state-model.ts in Slice 3)

interface ASMState {
  cpu_risk:    number;
  disk_risk:   number;
  mode:        RuntimeState['mode'];
  cycleCount:  number;
  lastUpdated: number;
}

const asm: ASMState = {
  cpu_risk: 0, disk_risk: 0, mode: 'idle', cycleCount: 0, lastUpdated: Date.now(),
};

function getASM(): ASMState { return { ...asm }; }
function updateASM(patch: Partial<ASMState>): void {
  Object.assign(asm, patch, { lastUpdated: Date.now() });
}

// ── LTG stub — always DEFER in Slice 1

type LTGVerdict = 'PROMOTE' | 'DEFER' | 'DISCARD';
function evaluateLTG(_c: ActionCandidate, _s: Signal): LTGVerdict { return 'DEFER'; }

// ── Admissibility check

type AdmissibilityStatus = 'pass' | 'flagged' | 'blocked';
interface AdmissibilityResult { status: AdmissibilityStatus; reason: string; }

function checkAdmissibility(candidate: ActionCandidate): AdmissibilityResult {
  if (candidate.risk > 0.9)        return { status: 'blocked', reason: 'Risk too high' };
  if (candidate.confidence < 0.1)  return { status: 'blocked', reason: 'Confidence too low' };
  if (candidate.action.type === 'write_file') {
    if (candidate.action.filename.includes('..'))
      return { status: 'blocked', reason: 'Path traversal forbidden' };
    if (candidate.action.filename.startsWith('/'))
      return { status: 'blocked', reason: 'Absolute path forbidden' };
    const PROTECTED = ['system-invariants', 'alive-constitution', 'alive-runtime'];
    if (PROTECTED.some(p => candidate.action.type === 'write_file' && candidate.action.filename.includes(p)))
      return { status: 'blocked', reason: 'Write to protected file forbidden' };
  }
  return { status: 'pass', reason: 'All checks passed' };
}

// ── Executor

const ALIVE_WEB_DIR = path.resolve(__dirname, '../../alive-web');

function executeAction(action: Action): { success: boolean; detail: string } {
  try {
    if (action.type === 'display_text') {
      console.log(`[EXECUTOR] display_text: ${action.payload}`);
      return { success: true, detail: `Displayed: ${action.payload.slice(0, 80)}` };
    }
    if (action.type === 'write_file') {
      if (!fs.existsSync(ALIVE_WEB_DIR)) fs.mkdirSync(ALIVE_WEB_DIR, { recursive: true });
      const filePath = path.join(ALIVE_WEB_DIR, action.filename);
      fs.appendFileSync(filePath, action.content, { encoding: 'utf8' });
      console.log(`[EXECUTOR] FILE_WRITTEN: ${filePath}`);
      return { success: true, detail: `Written to ${action.filename}` };
    }
    return { success: false, detail: `Unknown action type` };
  } catch (err) {
    return { success: false, detail: `Execution error: ${err instanceof Error ? err.message : err}` };
  }
}

// ── Cycle result

export interface CycleResult {
  signal_id:          string;
  stg_result:         StgResult;
  stg_reason:         string;
  synthesizer_level?: string;
  rule_matched?:      string;
  admissibility?:     AdmissibilityStatus;
  executed:           boolean;
  execution_detail?:  string;
  ltg_verdict?:       LTGVerdict;
  asm_after:          ASMState;
  experience_stream:  string;
}

// ── Main cycle — the ONLY entry point for cognition

export async function runCycle(signal: Signal): Promise<CycleResult> {
  const startTime = Date.now();

  if (signal.firewall_status !== 'cleared') {
    return {
      signal_id: signal.id, stg_result: 'DENY',
      stg_reason: `Firewall status '${signal.firewall_status}' — rejected before STG`,
      executed: false, asm_after: getASM(), experience_stream: getExperienceStreamPath(),
    };
  }

  // Step 1 — Log signal
  logSignalReceived(signal.id, {
    kind: signal.kind, source: signal.source,
    urgency: signal.urgency, confidence: signal.confidence,
    raw_content: String(signal.raw_content).slice(0, 200),
  });

  // Step 2 — CB
  const cbResult = compareBaseline(signal);
  const signalWithNovelty = cbResult.signal;
  console.log(`[CB] channel=${cbResult.channel} deltaScore=${cbResult.deltaScore.toFixed(4)} zScore=${cbResult.zScore.toFixed(3)}`);

  // Step 3 — STG
  const currentASM = getASM();
  const stgContext = {
    triagePriority: signal.urgency > 0.8 ? 4 : signal.urgency > 0.5 ? 2 : 1,
    batteryPct:     currentASM.mode === 'emergency' ? 20 : 100,
    cpuRisk:        currentASM.cpu_risk,
  };
  const stgResult = evaluateSTG(signalWithNovelty, stgContext);

  if (signal.kind === 'cpu_utilization' && signal.payload?.cpu_risk !== undefined) {
    updateASM({ cpu_risk: signal.payload.cpu_risk as number, mode: 'active' });
  }

  const stgReason =
    stgResult === 'OPEN'  ? `urgency=${signal.urgency.toFixed(2)} cpu_risk=${currentASM.cpu_risk.toFixed(2)} → authorized` :
    stgResult === 'DEFER' ? `cpu_risk=${currentASM.cpu_risk.toFixed(2)} ≥ 0.7 → deferred` :
    'pre-check failed';

  logStgDecision(signal.id, stgResult, stgReason, { cpu_risk: currentASM.cpu_risk, urgency: signal.urgency });
  console.log(`[STG] ${stgResult} — ${stgReason}`);

  if (stgResult !== 'OPEN') {
    return {
      signal_id: signal.id, stg_result: stgResult, stg_reason: stgReason,
      executed: false, asm_after: getASM(), experience_stream: getExperienceStreamPath(),
    };
  }

  // Step 4 — Cognition (ONLY call to alive-mind)
  const verifiedSignal: Signal = { ...signalWithNovelty, stg_verified: true };
  let candidate: ActionCandidate;
  try {
    const synthesis = synthesize(verifiedSignal);
    candidate = synthesis.candidate;
    console.log(`[COGNITION] level=${candidate.level} reason="${candidate.reason.slice(0, 80)}" confidence=${candidate.confidence.toFixed(2)}`);
  } catch (err) {
    console.error(`[COGNITION] Synthesis error: ${err}`);
    return {
      signal_id: signal.id, stg_result: 'OPEN', stg_reason: stgReason,
      executed: false, asm_after: getASM(), experience_stream: getExperienceStreamPath(),
    };
  }

  // Step 5 — Admissibility
  const admissibility = checkAdmissibility(candidate);
  console.log(`[ADMISSIBILITY] ${admissibility.status} — ${admissibility.reason}`);
  if (admissibility.status === 'blocked') {
    return {
      signal_id: signal.id, stg_result: 'OPEN', stg_reason: stgReason,
      synthesizer_level: candidate.level, admissibility: 'blocked',
      executed: false, asm_after: getASM(), experience_stream: getExperienceStreamPath(),
    };
  }

  // Step 6 — Execute
  logActionDispatched(signal.id, candidate.id, candidate.action.type, { level: candidate.level });
  const outcome = executeAction(candidate.action);
  logActionOutcome(signal.id, candidate.id, outcome.success, outcome.detail);

  // Step 7 — LTG
  const ltgVerdict = evaluateLTG(candidate, verifiedSignal);
  console.log(`[LTG] ${ltgVerdict}`);

  // Step 8 — ASM update
  updateASM({ cycleCount: asm.cycleCount + 1 });
  const finalASM = getASM();
  console.log(`[ASM] cpu_risk=${finalASM.cpu_risk.toFixed(4)} mode=${finalASM.mode} cycleCount=${finalASM.cycleCount}`);

  // Step 9 — Cycle record to Experience Stream
  logCycleComplete(signal.id, {
    duration_ms: Date.now() - startTime,
    signal_kind: signal.kind, signal_urgency: signal.urgency,
    stg: stgResult, synthesizer_level: candidate.level,
    rule_matched: candidate.level === 'rule' ? candidate.reason : undefined,
    admissibility: admissibility.status,
    action_type: candidate.action.type,
    executed: outcome.success, ltg: ltgVerdict,
    asm_cpu_risk: finalASM.cpu_risk, asm_cycle_count: finalASM.cycleCount,
  });

  return {
    signal_id: signal.id, stg_result: 'OPEN', stg_reason: stgReason,
    synthesizer_level: candidate.level,
    rule_matched: candidate.level === 'rule' ? candidate.reason : undefined,
    admissibility: admissibility.status,
    executed: outcome.success, execution_detail: outcome.detail,
    ltg_verdict: ltgVerdict, asm_after: finalASM,
    experience_stream: getExperienceStreamPath(),
  };
}

export function getSystemState(): ASMState { return getASM(); }

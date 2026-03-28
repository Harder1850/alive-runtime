/**
 * Slice 2 Demo — alive-runtime  (v16 §25)
 *
 * Runs 5 consecutive cycles with injected varying CPU/disk loads to
 * demonstrate the full Slice 2 flag system:
 *
 *   Cycle 1 — nominal load (cpu 20%)        → pipeline OPEN, no flags
 *   Cycle 2 — high CPU (cpu 80%)            → STG DEFER + degradation flag emitted
 *   Cycle 3 — high CPU again (cpu 85%)      → DEFER again; duplicate degradation rejected
 *   Cycle 4 — high CPU third time (cpu 90%) → DEFER 3rd time; repeated-deferral flag
 *   Cycle 5 — nominal (cpu 15%)             → OPEN; flag store tick purges expired flags
 *
 * Also demonstrates:
 *   • STG queue: deferred items accumulate then are promoted / expire
 *   • Quorum: weak flags accumulate toward threshold and decay
 *
 * Run with:  npm run slice2
 */

import { ingestInput }         from '../../../alive-body/src/sensors/ingestion';
import { Filtering }           from '../../../alive-body/src/sensors/filtering';
import { firewallCheck }       from '../../../alive-body/src/nervous-system/firewall';
import { evaluateSTG,
         markSignalVerified,
         deferQueue }          from '../stg/stop-thinking-gate';
import { think }               from '../../../alive-mind/src/spine/mind-loop';
import { authorize }           from '../enforcement/executive';
import { executeAction }       from '../../../alive-body/src/actuators/executor';
import { recordExecution }     from '../../../alive-body/src/logging/execution-log';
import { recordAndEvaluate }   from '../comparison-baseline/cb-service';
import { triageSignal }        from '../triage/triage-service';
import { flagStore }           from '../flags/flag-store';
import { flagEmitter }         from '../flags/flag-emitter';
import { quorumAccumulator }   from '../flags/quorum-accumulator';

// ---------------------------------------------------------------------------
// Cycle runner
// ---------------------------------------------------------------------------

const filtering   = new Filtering();
const deferCounts = new Map<string, number>();

interface DemoOptions {
  cpuRisk:    number;   // 0.0–1.0 injected into STG context
  diskRisk:   number;   // 0.0–1.0
  batteryPct: number;
  label:      string;
}

async function runDemoCycle(raw: string, opts: DemoOptions): Promise<void> {
  const { cpuRisk, diskRisk, batteryPct, label } = opts;

  console.log('');
  console.log(`┌── CYCLE: ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}`);
  console.log(`│   input="${raw}"  cpu=${(cpuRisk*100).toFixed(0)}%  disk=${(diskRisk*100).toFixed(0)}%  battery=${batteryPct}%`);

  // Stage 1: Ingest
  const signal = ingestInput(raw);

  // Resource degradation checks
  flagEmitter.onCpuRisk(signal, cpuRisk);
  flagEmitter.onDiskRisk(signal, diskRisk);

  // Stage 2: Filter
  const passed = filtering.filter(signal);
  if (!passed) {
    console.log('│   HALT — filter rejected signal');
    flagEmitter.onMalformedSignal(signal);
    endCycle();
    return;
  }

  // Stage 3: Firewall
  const fwSignal = firewallCheck(signal);
  if (fwSignal.firewall_status === 'blocked') {
    console.log('│   HALT — firewall blocked');
    flagEmitter.onFirewallBlock(fwSignal);
    endCycle();
    return;
  }

  // Stage 4: CB
  const cbResult = recordAndEvaluate(fwSignal);
  if (cbResult.zScore > 0.5) {
    flagEmitter.onCBAnomaly(fwSignal, cbResult.zScore);
  }

  // Stage 5: Triage
  const triage = triageSignal(fwSignal, cbResult);

  // Stage 6: STG
  const stgResult = evaluateSTG(fwSignal, {
    triagePriority: triage.highestPriority,
    batteryPct,
    cpuRisk,
  });

  if (stgResult === 'DENY') {
    console.log('│   HALT — STG DENY');
    endCycle();
    return;
  }

  if (stgResult === 'DEFER') {
    const src    = fwSignal.source;
    const count  = (deferCounts.get(src) ?? 0) + 1;
    deferCounts.set(src, count);
    console.log(`│   STG DEFER — source="${src}" consecutive=${count}`);
    if (count >= 3) {
      flagEmitter.onRepeatedDeferral(fwSignal, count);
    }
    deferQueue.push(fwSignal, triage.highestPriority);
    endCycle();
    return;
  }

  // OPEN path
  deferCounts.delete(fwSignal.source);
  const verifiedSignal = markSignalVerified(fwSignal);
  const decision = think(verifiedSignal);
  const exec     = authorize(verifiedSignal, triage);

  if (exec.verdict === 'VETOED') {
    console.log(`│   HALT — executive VETOED: ${exec.reason}`);
    flagEmitter.onConstitutionalViolation(verifiedSignal, exec.reason);
    endCycle();
    return;
  }

  const result = executeAction(decision.selected_action);
  console.log(`│   ✓ EXECUTED  action=${decision.selected_action.type}  result="${result.slice(0, 60)}"`);

  recordExecution({
    timestamp:  Date.now(),
    signalId:   verifiedSignal.id,
    decisionId: decision.id,
    actionType: decision.selected_action.type,
    result,
  });

  endCycle();
}

function endCycle(): void {
  // Feed weak flags to quorum accumulator
  for (const flag of flagStore.getActive()) {
    quorumAccumulator.add(flag);
  }
  const qFlag = quorumAccumulator.tick();
  if (qFlag) {
    const result = flagStore.emit(qFlag);
    console.log(`│   [QUORUM] ${result} class=${qFlag.class} score→threshold`);
  }

  deferQueue.tick();
  flagStore.tick();

  // Status summary
  const active = flagStore.getActive();
  const qSize  = deferQueue.size();
  console.log(`│   ─── End-of-cycle: activeFlags=${active.length}  deferQueue=${qSize}  quorumScore=${quorumAccumulator.getScore().toFixed(2)}`);
  if (active.length > 0) {
    for (const f of active) {
      console.log(`│       ${f.class.padEnd(12)} P${f.priority}  ${f.source.padEnd(25)} "${f.reason.slice(0, 55)}"`);
    }
  }
  console.log('└' + '─'.repeat(66));
}

// ---------------------------------------------------------------------------
// Demo sequence
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║          ALIVE — SLICE 2 DEMO  (v16 §25 Flag System)            ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  Demonstrating: flag emission · duplicate rejection             ║');
  console.log('║                 expiry enforcement · STG queue behaviour        ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  const cycles: Array<{ raw: string; opts: DemoOptions }> = [
    {
      raw: 'nominal telemetry ping',
      opts: { cpuRisk: 0.20, diskRisk: 0.30, batteryPct: 90, label: '1/5 NOMINAL  (cpu=20%)' },
    },
    {
      raw: 'system health check',
      opts: { cpuRisk: 0.80, diskRisk: 0.50, batteryPct: 85, label: '2/5 HIGH-CPU (cpu=80%)  → expect DEFER + degradation flag' },
    },
    {
      raw: 'system health check',
      opts: { cpuRisk: 0.85, diskRisk: 0.50, batteryPct: 82, label: '3/5 HIGH-CPU (cpu=85%)  → expect DEFER + duplicate rejected' },
    },
    {
      raw: 'system health check',
      opts: { cpuRisk: 0.90, diskRisk: 0.82, batteryPct: 79, label: '4/5 HIGH-CPU+DISK (cpu=90%, disk=82%)  → 3rd DEFER + repeated-deferral flag' },
    },
    {
      raw: 'nominal telemetry ping',
      opts: { cpuRisk: 0.15, diskRisk: 0.30, batteryPct: 77, label: '5/5 RECOVERY (cpu=15%)  → OPEN, flag expiry tick' },
    },
  ];

  for (const { raw, opts } of cycles) {
    await runDemoCycle(raw, opts);
    // Brief pause between cycles so timestamps differ (expiry logic is time-based)
    await new Promise((r) => setTimeout(r, 50));
  }

  // Final report
  console.log('');
  console.log('════════════════════════ SLICE 2 DEMO COMPLETE ═══════════════════════');
  const finalFlags = flagStore.getActive();
  console.log(`  Active flags remaining : ${finalFlags.length}`);
  console.log(`  DeferQueue size        : ${deferQueue.size()}`);
  console.log(`  Quorum score           : ${quorumAccumulator.getScore().toFixed(3)}`);
  if (finalFlags.length > 0) {
    console.log('  Flag details:');
    for (const f of finalFlags) {
      const ttlSec = ((f.expires_at - Date.now()) / 1000).toFixed(0);
      console.log(`    [${f.class}] P${f.priority} source=${f.source} ttl=${ttlSec}s "${f.reason.slice(0, 65)}"`);
    }
  }
  console.log('');
}

main().catch((err: unknown) => {
  console.error('[slice2-demo] FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

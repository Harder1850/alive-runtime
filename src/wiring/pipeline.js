"use strict";
/**
 * Signal Pipeline Orchestrator
 *
 * Pure wiring — no logic lives here.
 * Calls each stage in order and halts on any stop condition.
 *
 * Chain:
 *   Ingest → Filter → Firewall → STG → Mind → Executive → Execute → Log
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPipeline = runPipeline;
const ingestion_1 = require("../../../alive-body/src/sensors/ingestion");
const filtering_1 = require("../../../alive-body/src/sensors/filtering");
const firewall_1 = require("../../../alive-body/src/nervous-system/firewall");
const stop_thinking_gate_1 = require("../stg/stop-thinking-gate");
const mind_loop_1 = require("../../../alive-mind/src/spine/mind-loop");
const executive_1 = require("../enforcement/executive");
const executor_1 = require("../../../alive-body/src/actuators/executor");
const execution_log_1 = require("../../../alive-body/src/logging/execution-log");
const cb_service_1 = require("../comparison-baseline/cb-service");
const triage_service_1 = require("../triage/triage-service");
const filtering = new filtering_1.Filtering();
function runPipeline(raw) {
    console.log('\n[PIPELINE] ═══════════════════════════ START ═══════════════════════════');
    console.log(`[PIPELINE] Input: "${raw}"`);
    // ── Stage 1: Ingest ──────────────────────────────────────────────────────
    const signal = (0, ingestion_1.ingestInput)(raw);
    console.log(`[PIPELINE] 1. INGEST    id=${signal.id} source=${signal.source} firewall=${signal.firewall_status}`);
    // ── Stage 2: Filter ──────────────────────────────────────────────────────
    const passed = filtering.filter(signal);
    console.log(`[PIPELINE] 2. FILTER    passed=${passed}`);
    if (!passed) {
        console.log('[PIPELINE] HALT — filter rejected signal');
        return;
    }
    // ── Stage 3: Firewall ────────────────────────────────────────────────────
    const fwSignal = (0, firewall_1.firewallCheck)(signal);
    console.log(`[PIPELINE] 3. FIREWALL  status=${fwSignal.firewall_status}`);
    if (fwSignal.firewall_status === 'blocked') {
        console.log('[PIPELINE] HALT — firewall blocked signal');
        return;
    }
    // ── Stage 4: STG ─────────────────────────────────────────────────────────
    const stgResult = (0, stop_thinking_gate_1.evaluateSTG)(fwSignal);
    console.log(`[PIPELINE] 4. STG       result=${stgResult}`);
    if (stgResult === 'DENY') {
        console.log('[PIPELINE] HALT — STG DENY');
        return;
    }
    if (stgResult === 'DEFER') {
        console.log('[PIPELINE] HALT — STG DEFER (buffered for next cycle)');
        return;
    }
    const verifiedSignal = (0, stop_thinking_gate_1.markSignalVerified)(fwSignal);
    // ── Stage 5: Mind ─────────────────────────────────────────────────────────
    const decision = (0, mind_loop_1.think)(verifiedSignal);
    console.log(`[PIPELINE] 5. MIND      decision=${decision.id} action=${decision.selected_action.type} confidence=${decision.confidence}`);
    // ── Stage 6: Executive ────────────────────────────────────────────────────
    // authorize() requires a TriageResult — run the existing triage service
    const cbResult = (0, cb_service_1.recordAndEvaluate)(verifiedSignal);
    const triage = (0, triage_service_1.triageSignal)(verifiedSignal, cbResult);
    const exec = (0, executive_1.authorize)(verifiedSignal, triage);
    console.log(`[PIPELINE] 6. EXECUTIVE verdict=${exec.verdict} ref=${exec.constitution_ref}`);
    if (exec.verdict === 'VETOED') {
        console.log(`[PIPELINE] HALT — executive VETOED: ${exec.reason}`);
        return;
    }
    // ── Stage 7: Execute ──────────────────────────────────────────────────────
    const result = (0, executor_1.executeAction)(decision.selected_action);
    console.log(`[PIPELINE] 7. EXECUTE   result="${result}"`);
    // ── Stage 8: Log ──────────────────────────────────────────────────────────
    // Record with full signal+decision context (executor records with empty IDs internally)
    (0, execution_log_1.recordExecution)({
        timestamp: Date.now(),
        signalId: verifiedSignal.id,
        decisionId: decision.id,
        actionType: decision.selected_action.type,
        result,
    });
    console.log(`[PIPELINE] 8. LOGGED    signalId=${verifiedSignal.id} decisionId=${decision.id}`);
    console.log('[PIPELINE] ═══════════════════════════  END  ═══════════════════════════\n');
}
//# sourceMappingURL=pipeline.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeSignal = routeSignal;
const firewall_1 = require("../../../alive-body/src/nervous-system/firewall");
const execution_log_1 = require("../../../alive-body/src/logging/execution-log");
const stop_thinking_gate_1 = require("../stg/stop-thinking-gate");
const admissibility_check_1 = require("../enforcement/admissibility-check");
const mind_bridge_1 = require("../wiring/mind-bridge");
const body_bridge_1 = require("../wiring/body-bridge");
const index_1 = require("../index");
function routeSignal(signal) {
    // PATCH 3: Verify enforcement has been initialized (runtime startup lock)
    (0, index_1.assertEnforcementVerified)();
    const screened = (0, firewall_1.firewallCheck)(signal);
    if ((0, stop_thinking_gate_1.evaluateSTG)(screened) !== 'OPEN') {
        return 'Denied by STG';
    }
    if (!(0, stop_thinking_gate_1.shouldThink)(screened)) {
        return 'Request blocked by STG.';
    }
    // PATCH 1: Mark signal as verified by STG before passing to mind
    const verified = (0, stop_thinking_gate_1.markSignalVerified)(screened);
    // Ensure signal is properly verified before proceeding
    if (!verified.stg_verified) {
        throw new Error('Internal error: Signal should be marked as STG-verified at this point');
    }
    const decision = (0, admissibility_check_1.checkAdmissibility)((0, mind_bridge_1.callMind)(verified));
    if (decision.admissibility_status !== 'passed') {
        return 'Blocked by admissibility check';
    }
    const result = (0, body_bridge_1.callBody)(decision.selected_action);
    (0, execution_log_1.logActionDispatched)(verified.id, decision.id, decision.selected_action.type);
    (0, execution_log_1.logActionOutcome)(verified.id, decision.id, true, result);
    return result;
}

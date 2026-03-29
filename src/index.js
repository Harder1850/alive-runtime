"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldThink = exports.evaluateSTG = exports.routeSignal = void 0;
exports.assertEnforcementVerified = assertEnforcementVerified;
var signal_router_1 = require("./router/signal-router");
Object.defineProperty(exports, "routeSignal", { enumerable: true, get: function () { return signal_router_1.routeSignal; } });
var stop_thinking_gate_1 = require("./stg/stop-thinking-gate");
Object.defineProperty(exports, "evaluateSTG", { enumerable: true, get: function () { return stop_thinking_gate_1.evaluateSTG; } });
Object.defineProperty(exports, "shouldThink", { enumerable: true, get: function () { return stop_thinking_gate_1.shouldThink; } });
/**
 * Assertion function to verify enforcement has been initialized.
 * Must be called during startup before any signal routing occurs.
 */
function assertEnforcementVerified() {
    if (!globalThis.__ALIVE_ENFORCEMENT_VERIFIED__) {
        throw new Error("ENFORCEMENT NOT VERIFIED: Runtime startup sequence must complete before signal routing. " +
            "Call startup() from alive-runtime/lifecycle/startup.ts first.");
    }
}

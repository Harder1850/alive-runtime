"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callMind = callMind;
const mind_loop_1 = require("../../../alive-mind/src/spine/mind-loop");
function callMind(signal) {
    return (0, mind_loop_1.think)(signal);
}

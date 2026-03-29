"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callBody = callBody;
const executor_1 = require("../../../alive-body/src/actuators/executor");
function callBody(action) {
    return (0, executor_1.executeAction)(action);
}

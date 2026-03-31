import { makeSignal, type Signal } from "../../../alive-constitution/contracts/signal";
import { readBattery } from "../../../alive-body/src/sensors/system-info";

import {
  processPhase1Signal,
  pushPhase1RuntimeOutcome,
  getPhase1ArtifactPaths,
  getPhase1LoopStatus,
} from "./phase1-runtime";

function mkFsSignal(filePath: string): Signal {
  return makeSignal({
    id: crypto.randomUUID(),
    source: "filesystem",
    kind: "file_change_event",
    raw_content: `fs changed: ${filePath}`,
    timestamp: Date.now(),
    urgency: 0.55,
    confidence: 0.82,
    quality_score: 0.86,
    threat_flag: false,
    firewall_status: "cleared",
    novelty: 0.6,
  });
}

function mkSystemSignal(percent: number): Signal {
  return makeSignal({
    id: crypto.randomUUID(),
    source: "telemetry",
    kind: "process_health",
    raw_content: `battery ${percent}%`,
    timestamp: Date.now(),
    urgency: percent < 30 ? 0.8 : 0.45,
    confidence: 0.9,
    quality_score: 0.9,
    threat_flag: percent < 20,
    firewall_status: "cleared",
    novelty: percent < 25 ? 0.75 : 0.35,
  });
}

async function run(): Promise<void> {
  console.log("[phase1] proving scenario: workstation assistant");

  const battery = await readBattery();
  const signals: Signal[] = [
    mkFsSignal("C:/Users/mikeh/dev/ALIVE/alive-repos/alive-runtime/src/main.ts"),
    mkSystemSignal(battery.percent),
    makeSignal({
      id: crypto.randomUUID(),
      source: "system_api",
      kind: "user_input",
      raw_content: "Please summarize what changed and suggest next safe action",
      timestamp: Date.now(),
      urgency: 0.7,
      confidence: 0.95,
      quality_score: 0.95,
      threat_flag: false,
      firewall_status: "cleared",
      novelty: 0.7,
    }),
  ];

  for (const signal of signals) {
    const result = await processPhase1Signal({
      signal,
      context: ["workstation", "phase1-demo"],
      userRequest: signal.kind === "user_input",
      explicitTask: signal.kind === "user_input",
    });

    const note = `${result.interpretedSummary} | candidate=${result.candidateAction.type} | deep=${result.deepCognitionOpened}`;
    await pushPhase1RuntimeOutcome({ signalId: signal.id, success: true, note, timestamp: Date.now() });
    console.log(`[phase1] processed ${signal.kind} -> ${result.candidateAction.type}`);
  }

  const artifacts = getPhase1ArtifactPaths();
  console.log("[phase1] complete");
  console.log(`[phase1] loop status: ${JSON.stringify(getPhase1LoopStatus(), null, 2)}`);
  console.log(`[phase1] artifacts written:\n  - ${artifacts.loopStatusFile}\n  - ${artifacts.memoryStatusFile}`);
}

run().catch((error) => {
  console.error("[phase1] proving scenario failed", error);
  process.exit(1);
});

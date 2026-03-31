/**
 * Proving Scenario — alive-runtime Phase 1
 *
 * Demonstrates the full end-to-end path:
 *   body signal → runtime triage → mind cognition → whitelist enforcement
 *   → body execution or recommendation → outcome record → Studio artifacts
 *
 * Signals used (in order):
 *   1. file_change_event  — filesystem change detected in alive-repos
 *   2. process_health     — system health / battery reading
 *   3. repo_commit        — simulated git event (triggers git_status_check)
 *   4. user_input         — explicit user request (triggers recommendation)
 *   5. process_error      — simulated error signal (triggers notify, tests notify path)
 *
 * Run with:  npm run phase1:prove
 */

import { makeSignal, type Signal } from "../../../alive-constitution/contracts/signal";
import { readBattery }             from "../../../alive-body/src/sensors/system-info";
import { firewallCheck }           from "../../../alive-body/src/nervous-system/firewall";

import {
  processPhase1Signal,
  pushPhase1RuntimeOutcome,
  getPhase1ArtifactPaths,
  getPhase1LoopStatus,
} from "./phase1-runtime";

// ── Signal factories ──────────────────────────────────────────────────────────

function mkFsChangeSignal(filePath: string): Signal {
  return makeSignal({
    id:              crypto.randomUUID(),
    source:          "filesystem",
    kind:            "file_change_event",
    raw_content:     `fs changed: ${filePath}`,
    payload:         { file_path: filePath, event_type: "change" },
    timestamp:       Date.now(),
    urgency:         0.55,
    confidence:      0.90,
    quality_score:   0.90,
    threat_flag:     false,
    firewall_status: "cleared",
    novelty:         0.65,   // above deep-cognition threshold → git_status_check
  });
}

function mkSystemHealthSignal(batteryPercent: number): Signal {
  const lowBattery = batteryPercent < 30;
  return makeSignal({
    id:              crypto.randomUUID(),
    source:          "telemetry",
    kind:            "process_health",
    raw_content:     `system health: battery ${batteryPercent}%`,
    payload:         { battery_percent: batteryPercent, low_battery: lowBattery },
    timestamp:       Date.now(),
    urgency:         lowBattery ? 0.75 : 0.40,
    confidence:      0.92,
    quality_score:   0.92,
    threat_flag:     batteryPercent < 10,
    firewall_status: "cleared",
    novelty:         lowBattery ? 0.70 : 0.30,
  });
}

function mkRepoEventSignal(): Signal {
  return makeSignal({
    id:              crypto.randomUUID(),
    source:          "github",
    kind:            "repo_commit",
    raw_content:     "new commit on main: feat: add phase1 proving scenario",
    payload:         { branch: "main", message: "feat: add phase1 proving scenario" },
    timestamp:       Date.now(),
    urgency:         0.60,
    confidence:      0.95,
    quality_score:   0.95,
    threat_flag:     false,
    firewall_status: "cleared",
    novelty:         0.70,
  });
}

function mkUserInputSignal(text: string): Signal {
  return makeSignal({
    id:              crypto.randomUUID(),
    source:          "system_api",
    kind:            "user_input",
    raw_content:     text,
    timestamp:       Date.now(),
    urgency:         0.70,
    confidence:      0.98,
    quality_score:   0.98,
    threat_flag:     false,
    firewall_status: "cleared",
    novelty:         0.72,
  });
}

function mkProcessErrorSignal(errorText: string): Signal {
  return makeSignal({
    id:              crypto.randomUUID(),
    source:          "process",
    kind:            "process_error",
    raw_content:     `process error: ${errorText}`,
    payload:         { error: errorText },
    timestamp:       Date.now(),
    urgency:         0.65,
    confidence:      0.88,
    quality_score:   0.88,
    threat_flag:     false,
    firewall_status: "cleared",
    novelty:         0.68,
  });
}

// ── Demo runner ───────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║         ALIVE — Phase 1 Proving Scenario                        ║");
  console.log("║  body → runtime → mind → whitelist → body → outcome → Studio    ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");

  // Read real battery state from the host machine
  const battery = await readBattery();
  console.log(`[setup] battery: ${battery.percent}% charging=${battery.isCharging} hasBattery=${battery.hasBattery}`);
  console.log("");

  // Define the proving signals
  const signalDefs: Array<{ label: string; signal: Signal; context: string[]; userRequest?: boolean; explicitTask?: boolean }> = [
    {
      label:   "1. Filesystem change event",
      signal:  firewallCheck(mkFsChangeSignal("alive-repos/alive-runtime/src/phase1/proving-scenario.ts")),
      context: ["workstation", "phase1-demo"],
    },
    {
      label:   "2. System health / battery",
      signal:  firewallCheck(mkSystemHealthSignal(battery.percent)),
      context: ["workstation", "phase1-demo"],
    },
    {
      label:   "3. Git repo event (commit)",
      signal:  firewallCheck(mkRepoEventSignal()),
      context: ["workstation", "phase1-demo", "git"],
    },
    {
      label:        "4. User input (explicit task)",
      signal:       firewallCheck(mkUserInputSignal("Summarize what changed and recommend next safe action")),
      context:      ["workstation", "phase1-demo"],
      userRequest:  true,
      explicitTask: true,
    },
    {
      label:   "5. Process error signal",
      signal:  firewallCheck(mkProcessErrorSignal("npm build failed: TypeScript error in alive-mind")),
      context: ["workstation", "phase1-demo"],
    },
  ];

  let allSuccess = true;

  for (const def of signalDefs) {
    console.log(`┌─ ${def.label}`);

    // Firewall gate — body responsibility
    if (def.signal.firewall_status === "blocked") {
      console.log(`│  ✗ Firewall BLOCKED — signal dropped`);
      console.log("└──────────────────────────────────────────────────────────────────");
      console.log("");
      continue;
    }

    console.log(`│  signal_id=${def.signal.id}`);
    console.log(`│  kind=${def.signal.kind}  source=${def.signal.source}  novelty=${def.signal.novelty?.toFixed(2)}`);

    try {
      // ── Runtime processes the signal ────────────────────────────────────────
      const result = await processPhase1Signal({
        signal:       def.signal,
        context:      def.context,
        userRequest:  def.userRequest,
        explicitTask: def.explicitTask,
      });

      const loop = getPhase1LoopStatus();

      console.log(`│  mode=${loop.mode}  deepCognition=${result.deepCognitionOpened}`);
      console.log(`│  action_type=${loop.actionCandidate?.action_type ?? "—"}`);
      console.log(`│  confidence=${loop.actionCandidate?.confidence_score?.toFixed(3) ?? "—"}  risk=${loop.actionCandidate?.risk_score?.toFixed(2) ?? "—"}`);
      console.log(`│  whitelist: allowed=${loop.whitelistVerdict?.allowed}  auto_execute=${loop.whitelistVerdict?.auto_execute}`);
      console.log(`│  whitelist reason: ${loop.whitelistVerdict?.reason ?? "—"}`);
      console.log(`│  explanation: ${loop.demoExplanation?.notice ?? "—"}`);
      console.log(`│  next_step: ${loop.demoExplanation?.next_step ?? "—"}`);

      // ── Record outcome ───────────────────────────────────────────────────────
      const note =
        `${result.interpretedSummary.slice(0, 100)} | ` +
        `action=${loop.actionCandidate?.action_type} | ` +
        `auto_execute=${loop.whitelistVerdict?.auto_execute} | ` +
        `deep=${result.deepCognitionOpened}`;

      await pushPhase1RuntimeOutcome({
        signalId:  def.signal.id,
        success:   true,
        note,
        timestamp: Date.now(),
      });

      console.log(`│  ✓ Outcome recorded`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`│  ✗ Error processing signal: ${msg}`);
      allSuccess = false;
    }

    console.log("└──────────────────────────────────────────────────────────────────");
    console.log("");
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const artifacts = getPhase1ArtifactPaths();
  const finalLoop = getPhase1LoopStatus();

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  PROVING SCENARIO COMPLETE                                       ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  Last signal:       ${finalLoop.lastSignal?.kind ?? "—"} from ${finalLoop.lastSignal?.source ?? "—"}`);
  console.log(`  Last action:       ${finalLoop.actionCandidate?.action_type ?? "—"}`);
  console.log(`  Deep cognition:    ${finalLoop.deepCognitionOpened ?? false}`);
  console.log(`  Whitelist verdict: allowed=${finalLoop.whitelistVerdict?.allowed}  auto_execute=${finalLoop.whitelistVerdict?.auto_execute}`);
  console.log(`  Explanation:       ${finalLoop.demoExplanation?.notice ?? "—"}`);
  console.log(`  Confidence:        ${finalLoop.demoExplanation?.confidence_tone ?? "—"}`);
  console.log(`  Last outcome:      ${finalLoop.lastOutcome?.note?.slice(0, 80) ?? "—"}`);
  console.log("");
  console.log("  Artifacts written:");
  console.log(`    ${artifacts.loopStatusFile}`);
  console.log(`    ${artifacts.memoryStatusFile}`);
  console.log("");
  console.log(`  Status:  ${allSuccess ? "✓ ALL SIGNALS PROCESSED" : "⚠ SOME SIGNALS ERRORED (see above)"}`);
  console.log("");
  console.log("  Studio visibility:");
  console.log("    npm run demo:studio   → open http://localhost:5173");
  console.log("    npm run demo:inspect  → print artifact summary");
  console.log("");
}

run().catch((err: unknown) => {
  console.error("[phase1:prove] FATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

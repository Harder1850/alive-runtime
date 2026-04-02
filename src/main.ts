/**
 * ALIVE Runtime — Autonomous Command Center v12
 *
 * Pipeline: Sense → CB → Triage → Executive → STG → Mind → Admissibility → Body → Experience
 * WebSocket: ws://localhost:7070  (alive-host-ui)
 *
 * Proactive heartbeats:
 *   Terrain   — every  5 min : read full environment snapshot, enter SURVIVAL_MODE if threats detected
 *   Status    — every  5 min : write alive-web/status.json (dashboard poll target)
 *   Log       — every 60 min : append one-line vessel summary to alive-web/captains-log.json
 */

import { WebSocketServer, WebSocket } from 'ws';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { makeSignal, type Signal } from '../../alive-constitution/contracts/signal';
import type { Action } from '../../alive-constitution/contracts/action';
import { routeWithPriority } from '../enforcement/reflex-router';
import { callMind } from './wiring/mind-bridge';
import { callBodyGated } from './wiring/body-bridge';
import { evaluateNovelSignal } from '../../alive-mind/src/decisions/reasoning-engine';
import { StateModel } from '../../alive-mind/src/spine/state-model';
import { readEnvironment } from '../../alive-body/src/sensors/environment';
import type { EnvironmentSnapshot } from '../../alive-body/src/sensors/environment';
import { appendLogEntry } from '../../alive-body/src/tools/captains-log';
import { recordAndEvaluate } from './comparison-baseline/cb-service';
import { triageSignal } from './triage/triage-service';
import { authorize } from './enforcement/executive';
import { appendExperience } from '../../alive-mind/src/memory/experience-stream';
import { runPipeline } from './wiring/pipeline';

const ALIVE_WEB = join('C:', 'Users', 'mikeh', 'dev', 'ALIVE', 'alive-repos', 'alive-web');

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const stateModel = new StateModel();
let lastEnv: EnvironmentSnapshot | null = null;

// ---------------------------------------------------------------------------
// Mock telemetry tick sensor
// ---------------------------------------------------------------------------

let tickCount = 0;
const MOCK_PAYLOADS = [
  'telemetry nominal', 'battery at 82%', 'ambient noise detected',
  'system api heartbeat', 'peer_bot status ping',
];

function sense(): Signal {
  tickCount++;
  const isThreat = tickCount % 5 === 0;
  return makeSignal({
    id: crypto.randomUUID(),
    source: 'telemetry',
    kind: 'process_health',
    raw_content: isThreat
      ? 'INTRUDER ALERT — perimeter breach detected'
      : MOCK_PAYLOADS[(tickCount - 1) % MOCK_PAYLOADS.length],
    timestamp: Date.now(),
    urgency: isThreat ? 0.95 : 0.35,
    confidence: 0.9,
    quality_score: 0.9,
    threat_flag: isThreat,
    firewall_status: 'cleared',
    perceived_at: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Inline STG — Priority-Based Determinism (v12 §9 Resource Allocation)
//
// Priority 4 (CRITICAL) : Always OPEN
// Priority 3 (HIGH)     : OPEN if battery > 20%
// Priority 2 (MEDIUM)   : OPEN if battery > 50% AND system load < 70%
// Priority 0-1 (LOW)    : DEFER to next heartbeat cycle
// ---------------------------------------------------------------------------

const FORCE_OPEN_KEYWORDS = ['help', 'broke', 'broken', 'emergency', 'how', '?', 'survival', 'threat', 'warning'];

function evaluateSTG(
  signal: Signal,
  triagePriority: number = 1,
  batteryPct: number = 100,
  systemLoadPct: number = 0,
): 'OPEN' | 'DEFER' | 'DENY' {
  console.log(`[STG] Deciding: priority=${triagePriority} battery=${batteryPct}% load=${systemLoadPct}% signal="${String(signal.raw_content).slice(0, 50)}"`);

  // Hard DENY: firewall rejected or empty content
  if (signal.firewall_status !== 'cleared') return 'DENY';
  if (!String(signal.raw_content ?? '').trim()) return 'DENY';

  const lower = String(signal.raw_content).toLowerCase();

  // Force-OPEN overrides priority table for distress/query keywords
  if (FORCE_OPEN_KEYWORDS.some((kw) => lower.includes(kw))) {
    console.log('[STG] Force-OPEN: distress/query keyword');
    return 'OPEN';
  }

  // Priority-based deterministic resource allocation (v12 §9)
  if (triagePriority >= 4) {
    // CRITICAL — always open, no resource check
    console.log('[STG] OPEN: priority=CRITICAL');
    return 'OPEN';
  }

  if (triagePriority === 3) {
    // HIGH — open if battery above critical threshold (20%)
    if (batteryPct > 20) {
      console.log('[STG] OPEN: priority=HIGH, battery sufficient');
      return 'OPEN';
    }
    console.log('[STG] DEFER: priority=HIGH but battery critically low');
    return 'DEFER';
  }

  if (triagePriority === 2) {
    // MEDIUM — open if battery healthy AND system not overloaded
    if (batteryPct > 50 && systemLoadPct < 70) {
      console.log('[STG] OPEN: priority=MEDIUM, resources sufficient');
      return 'OPEN';
    }
    console.log('[STG] DEFER: priority=MEDIUM, resource constraints');
    return 'DEFER';
  }

  // LOW (0-1) — always DEFER, not worth brain cycles
  console.log('[STG] DEFER: priority=LOW');
  return 'DEFER';
}

// ---------------------------------------------------------------------------
// Admissibility
// ---------------------------------------------------------------------------

function checkAdmissibility(action: Action): boolean {
  switch (action.type) {
    case 'display_text': return typeof action.payload === 'string';
    case 'write_file':   return typeof action.filename === 'string' && typeof action.content === 'string';
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Autonomous Teacher invocation (heartbeat-triggered)
// ---------------------------------------------------------------------------

async function invokeTeacherAutonomously(raw_content: string, label: string): Promise<Action | null> {
  console.log(`[ALIVE] ⚡ AUTONOMOUS TRIGGER: ${label}`);
  const signal: Signal = makeSignal({
    id: crypto.randomUUID(),
    source: 'system_api',
    kind: 'process_error',
    raw_content,
    timestamp: Date.now(),
    urgency: 0.95,
    confidence: 0.95,
    quality_score: 0.95,
    threat_flag: true,
    firewall_status: 'cleared',
    perceived_at: Date.now(),
  });
  try {
    const action = await evaluateNovelSignal(signal, stateModel.get());
    if (checkAdmissibility(action)) {
      const execResult = callBodyGated(action, signal.id);
      console.log(`[ALIVE] ✅ Teacher acted (${action.type}): ${execResult.result.slice(0, 100)}`);
      appendExperience(signal, action, { stg_result: 'OPEN', was_reflex: false, flags_raised: 1 });
      return action;
    }
  } catch (err) {
    console.error(`[ALIVE] Teacher invocation failed (${label}):`, err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// PILLAR 2 — Terrain Heartbeat (every 5 min)
// ---------------------------------------------------------------------------

const TERRAIN_INTERVAL_MS = 5 * 60_000;

async function terrainHeartbeat(): Promise<void> {
  console.log('[TERRAIN] Reading environment snapshot...');
  let env: EnvironmentSnapshot;
  try {
    env = await readEnvironment();
    lastEnv = env;
  } catch (err) {
    console.error('[TERRAIN] readEnvironment failed:', err);
    return;
  }

  const { weather, battery, cpu, disk, threats, survivalMode } = env;

  console.log(
    `[TERRAIN] weather="${weather.description}" wind=${weather.windspeedMph}mph ` +
    `temp=${weather.tempC}°C | battery=${battery.percent}% charging=${battery.isCharging} ` +
    `| cpu=${cpu.tempC}°C | disk=${disk.usedPercent}% | SURVIVAL=${survivalMode}`,
  );

  writeStatusJson(env);

  if (!survivalMode) return;

  const activeThreats: string[] = [];
  if (threats.lowBattery)   activeThreats.push(`battery critically low at ${battery.percent}% and NOT charging`);
  if (threats.highWind)     activeThreats.push(`high winds at ${weather.windspeedMph} mph`);
  if (threats.heavyRain)    activeThreats.push(`heavy rain / storm (${weather.description})`);
  if (threats.highCpuTemp)  activeThreats.push(`CPU overheating at ${cpu.tempC}°C`);
  if (threats.diskNearFull) activeThreats.push(`disk nearly full at ${disk.usedPercent}%`);

  await invokeTeacherAutonomously(
    `SURVIVAL_MODE ACTIVATED. Active threats: ${activeThreats.join('; ')}. ` +
    `Current conditions — weather: ${weather.description}, wind: ${weather.windspeedMph}mph, ` +
    `outside temp: ${weather.tempC}°C, battery: ${battery.percent}% (charging=${battery.isCharging}), ` +
    `CPU temp: ${cpu.tempC}°C, disk used: ${disk.usedPercent}%. ` +
    `Write survival-data.json with the active threats and a Sun Tzu Nine Situations strategic defense plan.`,
    `SURVIVAL_MODE [${activeThreats.join(' | ')}]`,
  );
}

// ---------------------------------------------------------------------------
// PILLAR 4 — Captain's Log Heartbeat (every 60 min)
// ---------------------------------------------------------------------------

const LOG_INTERVAL_MS = 60 * 60_000;

async function captainsLogHeartbeat(): Promise<void> {
  const env = lastEnv ?? await readEnvironment().catch(() => null);
  if (!env) { console.warn('[LOG] No environment data — skipping log entry.'); return; }

  const mode = env.survivalMode ? 'SURVIVAL' : 'NOMINAL';
  const threats = Object.entries(env.threats)
    .filter(([, v]) => v).map(([k]) => k).join(', ') || 'none';

  const summary =
    `[${mode}] ${env.weather.description}, ${env.weather.windspeedMph}mph wind, ` +
    `${env.weather.tempC}°C outside; battery ${env.battery.percent}% ` +
    `(${env.battery.isCharging ? 'charging' : 'on battery'}); ` +
    `CPU ${env.cpu.tempC < 0 ? 'N/A' : env.cpu.tempC + '°C'}; ` +
    `disk ${env.disk.usedPercent}% used. Active threats: ${threats}.`;

  appendLogEntry(env, summary);
}

// ---------------------------------------------------------------------------
// status.json writer — dashboard poll target
// ---------------------------------------------------------------------------

function writeStatusJson(env: EnvironmentSnapshot): void {
  try {
    mkdirSync(ALIVE_WEB, { recursive: true });
    writeFileSync(join(ALIVE_WEB, 'status.json'), JSON.stringify(env, null, 2), 'utf-8');
  } catch (err) {
    console.error('[STATUS] Failed to write status.json:', err);
  }
}

// ---------------------------------------------------------------------------
// Tick — 1-second background telemetry loop
// v12 Pipeline: Sense → CB → Triage → Executive → STG → Mind → Body → Experience
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const signal = sense();
  const ts = new Date().toISOString();
  const prefix = `[${ts}] TICK ${String(tickCount).padStart(3, '0')}`;

  // Step 1: CB — detect velocity anomalies
  const cbResult = recordAndEvaluate(signal);

  // Step 2: Triage — classify signal and raise flags
  const triage = triageSignal(signal, cbResult);

  // Step 3: Reflex — bypass brain for critical patterns (before executive overhead)
  const { reflexAction, bypassed } = routeWithPriority([signal]);
  if (bypassed && reflexAction) {
    const reflexExec = callBodyGated(reflexAction, signal.id);
    console.log(`${prefix} | ⚡ REFLEX | "${String(signal.raw_content).slice(0, 50)}" → "${reflexExec.result.slice(0, 60)}"`);
    appendExperience(signal, reflexAction, { stg_result: 'REFLEX', was_reflex: true, flags_raised: triage.flags.length });
    return;
  }

  // Step 4: Executive — constitutional authorization gate
  const exec = authorize(signal, triage);
  if (exec.verdict === 'VETOED') {
    console.log(`${prefix} | 🛑 VETOED [${exec.constitution_ref}] ${exec.reason}`);
    return;
  }
  if (exec.verdict === 'FLAGGED') {
    console.log(`${prefix} | ⚠️  FLAGGED [${exec.constitution_ref}] ${exec.reason} — proceeding with caution`);
  }

  // Step 5: STG — priority-based resource allocation (v12 §9)
  const batteryPct = stateModel.get().battery_status * 100;
  const stgResult = evaluateSTG(signal, triage.highestPriority, batteryPct);

  if (stgResult === 'DENY') return;

  if (stgResult === 'DEFER') {
    console.log(`${prefix} | 💤 DEFER`);
    return;
  }

  // Step 6: Mind — route to appropriate reasoning layer
  console.log(`${prefix} | 🧠 STG=OPEN | "${String(signal.raw_content).slice(0, 50)}"`);

  let action: Action;

  // Priority ≥ 3 → full reasoning engine (LLM-capable)
  // Priority < 3  → fast stub (avoid burning API tokens on routine noise)
  if (triage.highestPriority >= 3) {
    action = await evaluateNovelSignal(signal, stateModel.get());
  } else {
    const decision = callMind(signal);
    if (decision.admissibility_status === 'blocked' || !checkAdmissibility(decision.selected_action)) {
      console.log(`${prefix} | 🚫 BLOCKED`);
      return;
    }
    action = decision.selected_action;
  }

  if (!checkAdmissibility(action)) {
    console.log(`${prefix} | 🚫 INADMISSIBLE`);
    return;
  }

  // Step 7: Body — execute through the global gate
  const execResult = callBodyGated(action, signal.id);
  console.log(`${prefix} | ✅ ACT → "${execResult.result.slice(0, 80)}"`);

  // Step 8: Experience Stream — record what happened
  appendExperience(signal, action, {
    stg_result: 'OPEN',
    was_reflex: false,
    flags_raised: triage.flags.length,
  });
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

function broadcast(wss: WebSocketServer, message: unknown): void {
  const data = JSON.stringify(message);
  wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

async function handleObservation(wss: WebSocketServer, raw: string): Promise<void> {
  const signal: Signal = makeSignal({
    id: crypto.randomUUID(),
    source: 'system_api',
    kind: 'user_input',
    raw_content: raw,
    timestamp: Date.now(),
    urgency: 0.5,
    confidence: 0.95,
    quality_score: 0.95,
    threat_flag: false,
    firewall_status: 'cleared',
    perceived_at: Date.now(),
  });

  // CB → Triage → Executive → Mind (WebSocket signals always get full reasoning)
  const cbResult = recordAndEvaluate(signal);
  const triage = triageSignal(signal, cbResult);

  // Reflex check
  const { reflexAction, bypassed } = routeWithPriority([signal]);
  if (bypassed && reflexAction) {
    callBodyGated(reflexAction, signal.id);
    const text = reflexAction.type === 'display_text' ? reflexAction.payload : '[reflex]';
    broadcast(wss, { type: 'render', canvas: 'text', content: { text } });
    appendExperience(signal, reflexAction, { stg_result: 'REFLEX', was_reflex: true, flags_raised: triage.flags.length });
    return;
  }

  // Executive gate
  const exec = authorize(signal, triage);
  if (exec.verdict === 'VETOED') {
    broadcast(wss, { type: 'render', canvas: 'text', content: { text: `🛑 VETOED [${exec.constitution_ref}]: ${exec.reason}` } });
    return;
  }

  try {
    const action = await evaluateNovelSignal(signal, stateModel.get());
    if (checkAdmissibility(action)) {
      const wsExec = callBodyGated(action, signal.id);
      const text = action.type === 'display_text' ? action.payload : wsExec.result;
      broadcast(wss, { type: 'render', canvas: 'text', content: { text } });
      appendExperience(signal, action, { stg_result: 'OPEN', was_reflex: false, flags_raised: triage.flags.length });
    }
  } catch (err) {
    console.error('[WS] evaluateNovelSignal failed:', err);
  }
}

function startWebSocketServer(): void {
  const wss = new WebSocketServer({ port: 7070 });
  wss.on('listening', () => console.log('[ALIVE] WebSocket listening on ws://localhost:7070'));
  wss.on('connection', (ws, req) => {
    const type = new URL(req.url ?? '/', 'ws://localhost').searchParams.get('type') ?? 'unknown';
    console.log(`[WS] Connected (type=${type})`);
    ws.send(JSON.stringify({ type: 'status', connected: true }));
    ws.on('message', (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      const msg = parsed as Record<string, unknown>;
      if (msg['type'] === 'observation' && typeof msg['raw'] === 'string') {
        handleObservation(wss, msg['raw']).catch(console.error);
      }
    });
    ws.on('close', () => console.log(`[WS] Disconnected (type=${type})`));
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function runLoop(): void {
  console.log('[ALIVE] ══════════════════════════════════════════════════');
  console.log('[ALIVE] AUTONOMOUS COMMAND CENTER v12 — ONLINE');
  console.log('[ALIVE] Pipeline: Sense → CB → Triage → STG → Mind → Body → Experience');
  console.log('[ALIVE] Terrain heartbeat  : every 5 min');
  console.log('[ALIVE] Captain\'s log      : every 60 min');
  console.log('[ALIVE] Dashboard          : alive-web/index.html (poll status.json)');
  console.log('[ALIVE] WebSocket          : ws://localhost:7070');
  console.log('[ALIVE] ══════════════════════════════════════════════════');

  startWebSocketServer();
  setInterval(() => tick().catch(console.error), 1000);

  terrainHeartbeat().catch(console.error);
  setInterval(() => terrainHeartbeat().catch(console.error), TERRAIN_INTERVAL_MS);

  captainsLogHeartbeat().catch(console.error);
  setInterval(() => captainsLogHeartbeat().catch(console.error), LOG_INTERVAL_MS);
}

// Pipeline smoke test — runs before the event loop starts
runPipeline('hello');

runLoop();

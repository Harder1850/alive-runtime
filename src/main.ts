/**
 * ALIVE Runtime — Central Autonomous Heartbeat
 *
 * Implements the full cognitive pipeline on every tick:
 *   Sense → Fast-Path Check → STG Gate → Deep Cognition → Admissibility → Act
 */

import type { Signal } from '../../alive-constitution/contracts/signal';
import type { Action } from '../../alive-constitution/contracts/action';
import { routeWithPriority } from '../enforcement/reflex-router';
import { callMind } from './wiring/mind-bridge';
import { callBody } from './wiring/body-bridge';

// ---------------------------------------------------------------------------
// Mock Sensor
// Simulates alive-body producing a firewall-cleared Signal each tick.
// Every 5th tick injects a threat to exercise the fast-path reflex.
// ---------------------------------------------------------------------------

let tickCount = 0;

const MOCK_PAYLOADS = [
  'telemetry nominal',
  'battery at 82%',
  'ambient noise detected',
  'system api heartbeat',
  'peer_bot status ping',
];

function sense(): Signal {
  tickCount++;
  const isThreat = tickCount % 5 === 0;

  return {
    id: crypto.randomUUID(),
    source: 'telemetry',
    raw_content: isThreat
      ? 'INTRUDER ALERT — perimeter breach detected'
      : MOCK_PAYLOADS[(tickCount - 1) % MOCK_PAYLOADS.length],
    timestamp: Date.now(),
    threat_flag: isThreat,
    firewall_status: 'cleared',
  };
}

// ---------------------------------------------------------------------------
// Inline STG Gate
// Evaluates whether a signal is worth deep cognition (the "lazy" principle).
// ~70% of cleared, non-threat signals are dropped to conserve compute.
// ---------------------------------------------------------------------------

function evaluateSTG(signal: Signal): 'OPEN' | 'DENY' {
  if (!signal.raw_content?.toString().trim()) return 'DENY';
  if (signal.firewall_status !== 'cleared') return 'DENY';
  // Simulate lazy path: most signals are handled by reflexes or dropped
  return Math.random() < 0.7 ? 'DENY' : 'OPEN';
}

// ---------------------------------------------------------------------------
// Inline Admissibility Check
// Ensures the decision coming out of alive-mind is structurally valid.
// Enforces MIND_CANNOT_EXECUTE — mind proposes, runtime decides to act.
// ---------------------------------------------------------------------------

function checkAdmissibility(action: Action): boolean {
  return action.type === 'display_text' && typeof action.payload === 'string';
}

// ---------------------------------------------------------------------------
// Tick — one full pipeline execution
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const signal = sense();
  const ts = new Date().toISOString();
  const prefix = `[${ts}] TICK ${String(tickCount).padStart(3, '0')}`;

  // Step 1 — Sense (already done above)

  // Step 2 — Fast-Path: threat check
  const { reflexAction, bypassed } = routeWithPriority([signal]);
  if (bypassed && reflexAction) {
    const output = callBody(reflexAction);
    console.log(`${prefix} | ⚡ FAST-PATH REFLEX | signal="${signal.raw_content}" → "${output}"`);
    return;
  }

  // Step 3 — STG Gate
  const stgResult = evaluateSTG(signal);
  if (stgResult === 'DENY') {
    console.log(`${prefix} | 💤 STG=DENY | LAZY — conserving compute, skipping cognition`);
    return;
  }

  // Step 4 — Deep Cognition (alive-mind)
  console.log(`${prefix} | 🧠 STG=OPEN | Engaging deep cognition for: "${signal.raw_content}"`);
  const decision = callMind(signal);

  // Step 5 — Admissibility Check
  if (decision.admissibility_status === 'blocked' || !checkAdmissibility(decision.selected_action)) {
    console.log(`${prefix} | 🚫 ADMISSIBILITY=BLOCKED | Decision rejected (confidence=${decision.confidence})`);
    return;
  }

  // Step 6 — Act (alive-body)
  const output = callBody(decision.selected_action);
  console.log(`${prefix} | ✅ ACT | confidence=${decision.confidence} reason="${decision.reason}" → "${output}"`);
}

// ---------------------------------------------------------------------------
// Run Loop — 1000ms tick rate
// ---------------------------------------------------------------------------

function runLoop(): void {
  console.log('[ALIVE] ════════════════════════════════════════════════');
  console.log('[ALIVE] Central autonomous loop initializing...');
  console.log('[ALIVE] Tick rate: 1000ms | Architecture: Dual-Speed');
  console.log('[ALIVE] Pipeline: Sense → STG → Mind → Admissibility → Body');
  console.log('[ALIVE] ════════════════════════════════════════════════');
  setInterval(() => tick().catch(console.error), 1000);
}

runLoop();

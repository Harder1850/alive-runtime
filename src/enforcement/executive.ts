/**
 * Executive Orchestrator — alive-runtime enforcement authority.
 *
 * Sits between Triage and the STG in the v12 pipeline:
 *   CB → Triage → [Executive] → STG → Mind → Body → Experience
 *
 * Responsibilities:
 *   1. Load CONSTITUTION.json and mission.json on startup (cached in memory).
 *   2. Evaluate each signal against constitutional invariants and forbidden patterns.
 *   3. Authorize or VETO the signal before STG evaluation begins.
 *   4. Enforce the Enforcement Integrity Invariant (INV-005).
 *
 * Authority:
 *   - AUTHORIZED  : signal may proceed to STG
 *   - VETOED      : signal blocked — constitutional violation
 *   - FLAGGED     : signal may proceed but carries a warning annotation
 *
 * The Executive reads law — it does not write it.
 * Constitution and mission are source files, not runtime state.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Signal } from '../../../alive-constitution/contracts/signal';
import type { TriageResult } from '../triage/triage-service';

// ---------------------------------------------------------------------------
// Constitution + Mission loading
// ---------------------------------------------------------------------------

interface ConstitutionDoc {
  version: string;
  enforcement_mode: 'strict' | 'permissive';
  invariants: Array<{
    id: string;
    name: string;
    description: string;
    violation_action: 'block' | 'deny' | 'flag';
  }>;
  forbidden_patterns: Array<{
    id: string;
    pattern: string;
    reason: string;
    action: 'block' | 'flag';
  }>;
  signal_sources: {
    trusted: string[];
    restricted: string[];
    untrusted: string[];
  };
}

interface MissionDoc {
  version: string;
  vessel: string;
  operator: string;
  operating_constraints: string[];
  resource_thresholds: {
    battery_critical_pct: number;
    battery_low_pct: number;
    cpu_overheat_c: number;
    disk_full_pct: number;
    wind_high_mph: number;
    system_load_high_pct: number;
  };
  failure_modes: Record<string, string>;
}

const RUNTIME_ROOT = join(__dirname, '..', '..');

function loadJSON<T>(filename: string): T | null {
  const path = join(RUNTIME_ROOT, filename);
  if (!existsSync(path)) {
    console.warn(`[EXECUTIVE] ${filename} not found at ${path} — using defaults`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err) {
    console.error(`[EXECUTIVE] Failed to parse ${filename}:`, err);
    return null;
  }
}

// Load once at module init — these are constitution-level documents, not hot config
const CONSTITUTION = loadJSON<ConstitutionDoc>('CONSTITUTION.json');
const MISSION = loadJSON<MissionDoc>('mission.json');

if (CONSTITUTION) {
  console.log(`[EXECUTIVE] Constitution v${CONSTITUTION.version} loaded (${CONSTITUTION.invariants.length} invariants, ${CONSTITUTION.forbidden_patterns.length} forbidden patterns)`);
} else {
  console.warn('[EXECUTIVE] Running without constitution — enforcement degraded to structural checks only');
}

if (MISSION) {
  console.log(`[EXECUTIVE] Mission loaded: vessel="${MISSION.vessel}" operator="${MISSION.operator}"`);
}

// Compile forbidden patterns to RegExp once at load time
const COMPILED_PATTERNS: Array<{ re: RegExp; id: string; reason: string; action: 'block' | 'flag' }> = [];

if (CONSTITUTION) {
  for (const fp of CONSTITUTION.forbidden_patterns) {
    try {
      COMPILED_PATTERNS.push({ re: new RegExp(fp.pattern, 'i'), id: fp.id, reason: fp.reason, action: fp.action });
    } catch {
      console.warn(`[EXECUTIVE] Invalid regex in forbidden pattern ${fp.id}: ${fp.pattern}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Executive decision types
// ---------------------------------------------------------------------------

export type ExecutiveVerdict = 'AUTHORIZED' | 'VETOED' | 'FLAGGED';

export interface ExecutiveDecision {
  verdict: ExecutiveVerdict;
  reason: string;
  constitution_ref: string;  // invariant ID or forbidden pattern ID
  signal_id: string;
  checked_at: number;
}

// ---------------------------------------------------------------------------
// Core authorization logic
// ---------------------------------------------------------------------------

/**
 * Authorize or veto a signal before it reaches the STG.
 *
 * Checks (in order of severity):
 *   1. Firewall status (INV-006)
 *   2. Source trustworthiness (CONSTITUTION.signal_sources)
 *   3. Forbidden content patterns (CONSTITUTION.forbidden_patterns)
 *   4. Triage flags — critical flag count limit (anomaly detection)
 */
export function authorize(signal: Signal, triage: TriageResult): ExecutiveDecision {
  const now = Date.now();
  const content = String(signal.raw_content ?? '');

  // INV-006: Firewall must have cleared the signal
  if (signal.firewall_status === 'blocked') {
    return {
      verdict: 'VETOED',
      reason: `Firewall blocked signal before executive review`,
      constitution_ref: 'INV-006',
      signal_id: signal.id,
      checked_at: now,
    };
  }

  // Source trust check
  if (CONSTITUTION) {
    const { trusted, restricted } = CONSTITUTION.signal_sources;
    if (!trusted.includes(signal.source) && !restricted.includes(signal.source)) {
      return {
        verdict: 'VETOED',
        reason: `Signal source "${signal.source}" is not in trusted or restricted list`,
        constitution_ref: 'INV-006',
        signal_id: signal.id,
        checked_at: now,
      };
    }
  }

  // Forbidden pattern scan
  for (const { re, id, reason, action } of COMPILED_PATTERNS) {
    if (re.test(content)) {
      if (action === 'block') {
        console.warn(`[EXECUTIVE] VETOED signal ${signal.id} — pattern ${id}: ${reason}`);
        return {
          verdict: 'VETOED',
          reason: `Forbidden pattern matched: ${reason}`,
          constitution_ref: id,
          signal_id: signal.id,
          checked_at: now,
        };
      }
      // 'flag' action — authorize but annotate
      console.warn(`[EXECUTIVE] FLAGGED signal ${signal.id} — pattern ${id}: ${reason}`);
      return {
        verdict: 'FLAGGED',
        reason: `Sensitive pattern detected: ${reason}`,
        constitution_ref: id,
        signal_id: signal.id,
        checked_at: now,
      };
    }
  }

  // Triage anomaly check — if triage raised critical (priority 4) flags from
  // multiple independent sources, treat as constitutional threat
  const criticalFlagCount = triage.flags.filter((f) => f.priority >= 4).length;
  if (criticalFlagCount >= 3) {
    console.warn(`[EXECUTIVE] FLAGGED: ${criticalFlagCount} critical flags — possible cascading failure`);
    return {
      verdict: 'FLAGGED',
      reason: `${criticalFlagCount} simultaneous critical flags — cascading failure risk`,
      constitution_ref: 'INV-005',
      signal_id: signal.id,
      checked_at: now,
    };
  }

  return {
    verdict: 'AUTHORIZED',
    reason: 'All constitutional checks passed',
    constitution_ref: 'ALL',
    signal_id: signal.id,
    checked_at: now,
  };
}

/**
 * Expose loaded mission thresholds for STG resource allocation.
 * Returns defaults if mission.json was not found.
 */
export function getMissionThresholds() {
  return MISSION?.resource_thresholds ?? {
    battery_critical_pct: 20,
    battery_low_pct: 50,
    cpu_overheat_c: 85,
    disk_full_pct: 90,
    wind_high_mph: 25,
    system_load_high_pct: 70,
  };
}

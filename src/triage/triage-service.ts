/**
 * Triage Service — alive-runtime's flag classifier.
 *
 * Sits between the CB layer and the STG. Takes a Signal + CB analysis,
 * inspects content, and emits zero or more Flags that downstream
 * processors (STG, brain) use to make routing decisions.
 *
 * Triage is intentionally fast and heuristic. Deep analysis happens
 * in alive-mind. Triage only classifies urgency and routing.
 */

import type { Signal } from '../../../alive-constitution/contracts/signal';
import { createFlag } from '../../../alive-constitution/contracts/flag';
import type { Flag, FlagPriority, FlagRoute } from '../../../alive-constitution/contracts/flag';
import type { CBResult } from '../comparison-baseline/cb-service';

// ---------------------------------------------------------------------------
// Content pattern tables
// ---------------------------------------------------------------------------

interface PatternRule {
  pattern: RegExp;
  flagType: Flag['flag_type'];
  priority: FlagPriority;
  route: FlagRoute;
  reason: string;
}

const CONTENT_RULES: readonly PatternRule[] = [
  // Critical threats
  { pattern: /intruder|breach|mayday|man overboard|hull/i,     flagType: 'threat',      priority: 4, route: 'reflex',   reason: 'Critical physical threat detected in signal content' },
  { pattern: /fire|explosion|flood/i,                           flagType: 'threat',      priority: 4, route: 'reflex',   reason: 'Catastrophic hazard keyword detected' },
  { pattern: /survival_mode|SURVIVAL_MODE/,                     flagType: 'threat',      priority: 3, route: 'brain',    reason: 'System survival mode activated' },
  // System health
  { pattern: /battery.*critical|power.*low|low.*battery/i,      flagType: 'degradation', priority: 3, route: 'brain',    reason: 'Battery critically low' },
  { pattern: /cpu.*overheat|overheating|temp.*high/i,           flagType: 'degradation', priority: 3, route: 'brain',    reason: 'Thermal degradation detected' },
  { pattern: /disk.*full|storage.*full/i,                       flagType: 'degradation', priority: 2, route: 'brain',    reason: 'Disk capacity critical' },
  // Anomalies
  { pattern: /error|fail|crash|exception/i,                     flagType: 'anomaly',     priority: 2, route: 'brain',    reason: 'Error or failure keyword in signal' },
  // Opportunities
  { pattern: /task.*complete|mission.*success|goal.*achieved/i, flagType: 'completion',  priority: 1, route: 'brain',    reason: 'Goal completion signal detected' },
  // Low-priority
  { pattern: /heartbeat|ping|nominal|status/i,                  flagType: 'suggestion',  priority: 0, route: 'log_only', reason: 'Routine telemetry — no action needed' },
];

// ---------------------------------------------------------------------------
// Main triage function
// ---------------------------------------------------------------------------

export interface TriageResult {
  flags: Flag[];
  /** Recommended route after considering all flags (highest priority wins) */
  recommendedRoute: FlagRoute;
  /** Highest priority flag raised */
  highestPriority: FlagPriority;
}

const ROUTE_ORDER: FlagRoute[] = ['reflex', 'brain', 'defer', 'log_only'];

function pickHighestRoute(routes: FlagRoute[]): FlagRoute {
  for (const r of ROUTE_ORDER) {
    if (routes.includes(r)) return r;
  }
  return 'brain';
}

export function triageSignal(signal: Signal, cb: CBResult): TriageResult {
  const flags: Flag[] = [];
  const content = String(signal.raw_content ?? '');

  // --- CB anomaly flag ---
  if (cb.isAnomaly) {
    flags.push(createFlag({
      signal_id: signal.id,
      source_layer: 'runtime',
      flag_type: 'anomaly',
      priority: 2,
      confidence: Math.min(cb.zScore / 10, 1.0),
      reason: `Signal velocity spike: ${cb.currentVelocity.toFixed(1)}/min vs baseline ${cb.baselineVelocity.toFixed(1)}/min`,
      recommended_route: 'brain',
      requires_decision: false,
    }));
  }

  // --- Threat flag from body layer ---
  if (signal.threat_flag) {
    flags.push(createFlag({
      signal_id: signal.id,
      source_layer: 'body',
      flag_type: 'threat',
      priority: 3,
      confidence: 0.9,
      reason: 'threat_flag set by alive-body firewall/sensor layer',
      recommended_route: 'brain',
      requires_decision: true,
    }));
  }

  // --- Content pattern matching ---
  for (const rule of CONTENT_RULES) {
    if (rule.pattern.test(content)) {
      flags.push(createFlag({
        signal_id: signal.id,
        source_layer: 'runtime',
        flag_type: rule.flagType,
        priority: rule.priority,
        confidence: 0.8,
        reason: rule.reason,
        recommended_route: rule.route,
        requires_decision: rule.priority >= 3,
      }));
    }
  }

  if (flags.length === 0) {
    return { flags, recommendedRoute: 'brain', highestPriority: 0 };
  }

  const highestPriority = Math.max(...flags.map((f) => f.priority)) as FlagPriority;
  const recommendedRoute = pickHighestRoute(flags.map((f) => f.recommended_route));

  if (flags.length > 0) {
    console.log(
      `[TRIAGE] ${flags.length} flag(s) for signal="${content.slice(0, 50)}": ` +
      `max_priority=${highestPriority}, route=${recommendedRoute}`,
    );
  }

  return { flags, recommendedRoute, highestPriority };
}

/**
 * Triage Service — alive-runtime's flag classifier.
 *
 * Sits between the CB layer and the STG. Takes a Signal + CB analysis,
 * inspects content, and emits zero or more Flags that downstream
 * processors (STG, brain) use to make routing decisions.
 *
 * Triage is intentionally fast and heuristic. Deep analysis happens
 * in alive-mind. Triage only classifies urgency and routing.
 *
 * Updated for Slice 2: uses new Flag contract fields (class/source/emitted_at/
 * expires_at/support_ref).  Routing logic is unchanged — PatternRule.route is
 * used internally to compute TriageResult.recommendedRoute but is no longer
 * stored on the Flag itself.
 */

import type { Signal }          from '../../../alive-constitution/contracts/signal';
import { createFlag }           from '../../../alive-constitution/contracts/flag';
import type { Flag, FlagClass, FlagRoute } from '../../../alive-constitution/contracts/flag';
import type { CBResult }        from '../comparison-baseline/cb-service';

// ---------------------------------------------------------------------------
// Content pattern tables
// ---------------------------------------------------------------------------

/** Triage TTL — flags raised per-cycle expire after 60 s */
const TRIAGE_FLAG_TTL_MS = 60_000;

interface PatternRule {
  pattern:   RegExp;
  flagClass: FlagClass;
  priority:  number;          // 0–4 (Slice 1 scale — valid as number)
  route:     FlagRoute;       // internal only; used for TriageResult.recommendedRoute
  reason:    string;
}

const CONTENT_RULES: readonly PatternRule[] = [
  // Critical threats
  { pattern: /intruder|breach|mayday|man overboard|hull/i,     flagClass: 'threat',      priority: 4, route: 'reflex',   reason: 'Critical physical threat detected in signal content' },
  { pattern: /fire|explosion|flood/i,                           flagClass: 'threat',      priority: 4, route: 'reflex',   reason: 'Catastrophic hazard keyword detected' },
  { pattern: /survival_mode|SURVIVAL_MODE/,                     flagClass: 'threat',      priority: 3, route: 'brain',    reason: 'System survival mode activated' },
  // System health
  { pattern: /battery.*critical|power.*low|low.*battery/i,      flagClass: 'degradation', priority: 3, route: 'brain',    reason: 'Battery critically low' },
  { pattern: /cpu.*overheat|overheating|temp.*high/i,           flagClass: 'degradation', priority: 3, route: 'brain',    reason: 'Thermal degradation detected' },
  { pattern: /disk.*full|storage.*full/i,                       flagClass: 'degradation', priority: 2, route: 'brain',    reason: 'Disk capacity critical' },
  // Anomalies
  { pattern: /error|fail|crash|exception/i,                     flagClass: 'anomaly',     priority: 2, route: 'brain',    reason: 'Error or failure keyword in signal' },
  // Completions (mapped to anomaly — positive deviation from baseline)
  { pattern: /task.*complete|mission.*success|goal.*achieved/i, flagClass: 'anomaly',     priority: 1, route: 'brain',    reason: 'Goal completion signal detected' },
  // Low-priority telemetry (mapped to degradation — softest class)
  { pattern: /heartbeat|ping|nominal|status/i,                  flagClass: 'degradation', priority: 0, route: 'log_only', reason: 'Routine telemetry — no action needed' },
];

// ---------------------------------------------------------------------------
// Main triage function
// ---------------------------------------------------------------------------

export interface TriageResult {
  flags: Flag[];
  /** Recommended route after considering all flags (highest priority wins) */
  recommendedRoute: FlagRoute;
  /** Highest priority flag raised */
  highestPriority: number;
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
  const content  = String(signal.raw_content ?? '');
  const now      = Date.now();
  const ttl      = now + TRIAGE_FLAG_TTL_MS;

  // --- CB anomaly flag ---
  if (cb.isAnomaly) {
    flags.push(createFlag({
      class:       'anomaly',
      source:      'runtime/cb',
      signal_id:   signal.id,
      priority:    2,
      reason:      `Signal velocity spike: ${cb.currentVelocity.toFixed(1)}/min vs baseline ${cb.baselineVelocity.toFixed(1)}/min`,
      expires_at:  ttl,
      support_ref: signal.id,
    }));
  }

  // --- Threat flag from body layer ---
  if (signal.threat_flag) {
    flags.push(createFlag({
      class:       'threat',
      source:      'body/sensor',
      signal_id:   signal.id,
      priority:    3,
      reason:      'threat_flag set by alive-body firewall/sensor layer',
      expires_at:  ttl,
      support_ref: signal.id,
    }));
  }

  // --- Content pattern matching ---
  const ruleRoutes: FlagRoute[] = [];
  for (const rule of CONTENT_RULES) {
    if (rule.pattern.test(content)) {
      flags.push(createFlag({
        class:       rule.flagClass,
        source:      'runtime/triage',
        signal_id:   signal.id,
        priority:    rule.priority,
        reason:      rule.reason,
        expires_at:  ttl,
        support_ref: signal.id,
      }));
      ruleRoutes.push(rule.route);
    }
  }

  if (flags.length === 0) {
    return { flags, recommendedRoute: 'brain', highestPriority: 0 };
  }

  const highestPriority  = Math.max(...flags.map((f) => f.priority));
  const recommendedRoute = pickHighestRoute([
    ...ruleRoutes,
    ...(cb.isAnomaly ? ['brain' as FlagRoute] : []),
    ...(signal.threat_flag ? ['brain' as FlagRoute] : []),
  ]);

  console.log(
    `[TRIAGE] ${flags.length} flag(s) for signal="${content.slice(0, 50)}": ` +
    `max_priority=${highestPriority}, route=${recommendedRoute}`,
  );

  return { flags, recommendedRoute, highestPriority };
}

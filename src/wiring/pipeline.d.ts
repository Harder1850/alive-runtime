/**
 * Signal Pipeline Orchestrator
 *
 * Pure wiring — no logic lives here.
 * Calls each stage in order and halts on any stop condition.
 *
 * Chain:
 *   Ingest → Filter → Firewall → STG → Mind → Executive → Execute → Log
 */
export declare function runPipeline(raw: string): void;
//# sourceMappingURL=pipeline.d.ts.map
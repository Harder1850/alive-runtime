# Execution Flow

## Implemented (Slice 1.5)

1. Interface reads user input and calls `ingestInput(input)`.
2. Body ingestion creates a `Signal` with `firewall_status: 'pending'`.
3. Runtime `routeSignal(signal)` calls Body `firewallCheck(signal)`.
4. Runtime STG gate runs `evaluateSTG(screened)`.
   - If firewall is not passed, return `Denied by STG`.
   - If `raw_content` is empty after trim, return `Denied by STG`.
5. Runtime STG intent gate runs `shouldThink(screened)`.
   - If content includes `forbidden`, return `Request blocked by STG.`
6. Runtime calls Mind `think(screened)`.
7. Runtime runs `checkAdmissibility(decision)`.
   - If blocked, return `Blocked by admissibility check`.
8. Runtime calls Body `executeAction(decision.selected_action)`.
9. Runtime records execution via Body `recordExecution(...)`.
10. Interface prints result and current execution log.

## Target-Aligned (Not Yet Implemented)

- Deferred STG output and queue handling.
- Mode-aware STG behavior.
- Structured pre-cognition scope admissibility.
- Perception shaping pipeline between Signal and Mind.
- Rich enforcement outcomes beyond pass/blocked.

## Current Failure Paths

- STG deny (`evaluateSTG`): `Denied by STG`
- STG block (`shouldThink`): `Request blocked by STG.`
- Admissibility block: `Blocked by admissibility check`

## Current Boundary Notes

- Runtime governs flow and enforcement only.
- Mind returns descriptive decisions only.
- Body executes only authorized actions.
- Interface does not bypass runtime.

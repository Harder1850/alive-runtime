# STG Specification

## Implemented (Slice 1.5)

STG behavior is split into two checks in runtime:

1. `evaluateSTG(signal)`
   - Returns `DENY` when `signal.firewall_status !== 'passed'`.
   - Returns `DENY` when `signal.raw_content.trim()` is empty.
   - Returns `OPEN` otherwise.

2. `shouldThink(signal)`
   - Returns `false` when `signal.raw_content.toLowerCase().includes('forbidden')`.
   - Returns `true` otherwise.

## Router Enforcement

Runtime router enforces STG in order:

1. Run `evaluateSTG(screened)`.
   - If not `OPEN`: return `Denied by STG`.
2. Run `shouldThink(screened)`.
   - If `false`: return `Request blocked by STG.`
3. Only then call Mind.

## Implemented Outputs

- `Denied by STG`
- `Request blocked by STG.`

## Target-Aligned (Not Yet Implemented)

- `DEFER` result handling.
- Queue depth controls.
- Mode- and resource-aware gating.
- Structured deny/defer reason objects.
# Execution Flow

## Canonical Runtime Flow

1. Input arrives at Body → Body fires Signal
2. Runtime Router receives Signal
3. Router checks admissibility (via Constitution policy)
4. Signal dispatched to Mind UC layer
5. Mind produces Decision contract
6. Runtime validates Decision
7. If valid: dispatched to Body actuators
8. Body executes
9. Result logged

## STG Intervention
At any point in steps 4-6, STG may halt cognitive processing.

## Emergency Flow
Emergency Stop → STG fires → Body enters safe-state → Mind paused → Log incident

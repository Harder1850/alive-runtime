# Architecture

## Overview

The Runtime repository governs the behavior of ALIVE. It enforces constitutional law, controls flow, and gates cognition and action.

## System Role

- Enforces constitutional rules and invariants
- Controls when cognition is permitted (Stop-Thinking Gate)
- Routes signals and actions through the system
- Validates admissibility of all operations
- Manages system lifecycle and scheduling

## Core Components

### enforcement/
Constitutional enforcement mechanisms and boundary checks.

### src/
Runtime core logic including routing, scheduling, and lifecycle management.

## Data Flow

```
Body → Runtime → Mind (gated)
Runtime → Body (actions)
Mind → Runtime → Body (decisions)
```

## Boundaries

- No cognition
- No long-term memory storage
- No direct external interaction
- Does not define law (only enforces)

## Interfaces

- Receives: signals, actions, decisions from other layers
- Outputs: governance decisions, routing, enforcement results
- Integrates with: Constitution (imports), Body (directs), Mind (governs)

## Constraints

- Must pass constitutional validation
- Cannot originate authority
- All operations must be auditable

## Failure Modes

- STG bypass → unauthorized cognition
- Routing failure → system isolation
- Enforcement failure → constitutional breach

## Open Questions

- Implementation of priority handling details
- Interrupt management specifics

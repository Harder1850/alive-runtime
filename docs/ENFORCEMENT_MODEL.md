# Enforcement Model

## Checks (in order)
1. Admissibility — is this signal/action constitutional?
2. Validation — does it meet schema and bounds?
3. Authorization — is the caller permitted?
4. Rate limiting — within cycle limits?

## On Failure
- Reject and log
- Escalate if configured
- Rollback if partially executed
- Emergency stop if critical violation

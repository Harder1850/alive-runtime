/**
 * Emergency override handler.
 * NOTE: Per Constitution invariants, this CANNOT override Constitutional law.
 */
export class EmergencyOverride {
  trigger(_reason: string): void {
    // TODO: implement — must respect EMERGENCY_ALLOWS_CONSTITUTION_OVERRIDE = false
  }
}

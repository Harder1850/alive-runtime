/**
 * ENFORCEMENT TEMPLATE
 * All enforcement modules must:
 * - Check against Constitution contracts/policies
 * - Return boolean (pass/fail) + reason
 * - NEVER make cognitive decisions
 * - NEVER execute actions directly
 */
export class YourEnforcementCheck {
  check(_input: unknown): { pass: boolean; reason: string } {
    // TODO: implement
    return { pass: true, reason: "not implemented" };
  }
}

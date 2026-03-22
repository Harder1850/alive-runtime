/** Stub: Policy rules for when STG should fire. */
export interface STGPolicy {
  shouldHalt(context: unknown): boolean;
  reason(context: unknown): string;
}

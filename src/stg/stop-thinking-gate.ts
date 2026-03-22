/**
 * Stop Thinking Gate (STG)
 * Halts cognitive processing based on policy.
 * DOES NOT make cognitive decisions — enforces halting only.
 */
export class StopThinkingGate {
  private halted = false;

  halt(reason: string): void {
    this.halted = true;
    console.log(`[STG] Halt: ${reason}`);
  }

  resume(): void {
    this.halted = false;
  }

  isHalted(): boolean {
    return this.halted;
  }
}

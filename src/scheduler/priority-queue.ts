import type { Signal } from '../../../alive-constitution/contracts';

/** Stub: Priority queue for runtime jobs. */
export class PriorityQueue<T> {
  private items: Array<{ item: T; priority: number }> = [];

  enqueue(item: T, priority: number): void {
    this.items.push({ item, priority });
    this.items.sort((a, b) => b.priority - a.priority);
  }

  dequeue(): T | undefined {
    const result = this.items.shift();
    if (!result) return undefined;

    // Verify STG verification before dispatch
    if (this.isSignal(result.item)) {
      const signal = result.item as unknown as Signal;
      if (!signal.stg_verified) {
        throw new Error(
          `Signal dispatched without STG verification. stg_verified=${signal.stg_verified}`,
        );
      }
    }

    return result.item;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Type guard to detect if item is a Signal object
   */
  private isSignal(item: unknown): item is Signal {
    if (!item || typeof item !== 'object') return false;
    const obj = item as Record<string, unknown>;
    return typeof obj.signal_id === 'string' && typeof obj.stg_verified === 'boolean';
  }
}

"use strict";
/**
 * Stop-Thinking Gate (STG) — alive-runtime's cognitive gatekeeper.
 *
 * Three possible outcomes:
 *   OPEN   — route to full cognitive pipeline
 *   DEFER  — buffer in priority queue for next cycle
 *   DENY   — discard (blocked by firewall, empty, or vetoed)
 *
 * v16 §31.8 Three-Condition Decision Policy (Slice 1 weights):
 *
 *   Pre-checks (before conditions):
 *     • firewall_status === 'blocked' → DENY
 *     • empty raw_content             → DENY
 *     • distress/query keyword        → OPEN (force override)
 *     • threat_flag === true          → OPEN (force override)
 *
 *   Condition 1 — Critical priority override:
 *     triagePriority >= CRITICAL_THRESHOLD (4) → OPEN regardless of resources
 *
 *   Condition 2 — Resource gate (Slice 1 weights):
 *     batteryPct > BATTERY_THRESHOLD (30) AND cpuRisk < CPU_RISK_THRESHOLD (0.7)
 *     → OPEN
 *
 *   Condition 3 — Default:
 *     → DEFER (pushed to priority queue)
 *
 * Slice 2 additions (v16 §25):
 *   • DeferQueue — priority-ordered ring buffer for deferred signals
 *   • P3/P4 signals interrupt lower-priority deferred items on arrival
 *   • Starvation prevention: any item deferred > 30 s is promoted one tier
 *   • Expired items (deferred > 3× TTL) are dropped on tick()
 *   • Queue bounded at MAX_QUEUE_SIZE — lowest-priority item evicted on overflow
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deferQueue = void 0;
exports.markSignalVerified = markSignalVerified;
exports.evaluateSTG = evaluateSTG;
exports.shouldThink = shouldThink;
// ---------------------------------------------------------------------------
// Atomic per-signal locks — prevent duplicate concurrent STG evaluation
// ---------------------------------------------------------------------------
const stgLocks = new Map();
function acquireSTGLock(id) {
    if (stgLocks.get(id))
        throw new Error(`STG lock conflict on signal ${id}`);
    stgLocks.set(id, true);
}
function releaseSTGLock(id) {
    stgLocks.delete(id);
}
// ---------------------------------------------------------------------------
// Keyword overrides
// ---------------------------------------------------------------------------
const FORCE_OPEN_KEYWORDS = [
    'help', 'broke', 'broken', 'emergency', 'how', '?',
    'survival', 'threat', 'warning', 'error', 'fail',
];
// ---------------------------------------------------------------------------
// Slice 1 weights (v16 §31.8)
// ---------------------------------------------------------------------------
/** Minimum battery percentage required for the resource gate to pass. */
const BATTERY_THRESHOLD = 30;
/** Maximum cpu_risk (0.0–1.0) allowed for the resource gate to pass. */
const CPU_RISK_THRESHOLD = 0.7;
/** Priority level that bypasses all resource checks. */
const CRITICAL_THRESHOLD = 4;
// ---------------------------------------------------------------------------
// Slice 2: Defer Priority Queue  (v16 §25)
// ---------------------------------------------------------------------------
const DEFER_TTL_MS = 30000; // 30 s → starvation promotion threshold
const DEFER_MAX_AGE_MS = 90000; // 3× TTL → hard expiry
const MAX_QUEUE_SIZE = 64; // prevent unbounded growth
class DeferQueue {
    constructor() {
        this.items = [];
    }
    /**
     * Push a signal into the defer queue.
     *
     * P3/P4 signals are inserted at the front of all lower-priority deferred items
     * so they are processed before lower-priority work on the next cycle.
     *
     * On overflow (MAX_QUEUE_SIZE), the lowest-priority item is evicted.
     */
    push(signal, priority) {
        if (this.items.length >= MAX_QUEUE_SIZE) {
            // Sort ascending by priority to find eviction candidate
            this.items.sort((a, b) => a.priority - b.priority);
            const evicted = this.items.shift();
            console.log(`[STG-QUEUE] OVERFLOW — evicted signal=${evicted.signal.id.slice(0, 8)} ` +
                `priority=${evicted.priority}`);
        }
        const item = {
            signal,
            priority,
            deferredAt: Date.now(),
            promoted: false,
        };
        // P3/P4 interrupt lower-priority items: find the first item with lower priority
        // and insert before it, otherwise append.
        if (priority >= 3) {
            const insertAt = this.items.findIndex((i) => i.priority < priority);
            if (insertAt >= 0) {
                this.items.splice(insertAt, 0, item);
                console.log(`[STG-QUEUE] INTERRUPT  signal=${signal.id.slice(0, 8)} ` +
                    `priority=${priority} inserted at position ${insertAt}`);
                return;
            }
        }
        this.items.push(item);
        console.log(`[STG-QUEUE] ENQUEUE  signal=${signal.id.slice(0, 8)} ` +
            `priority=${priority} queueSize=${this.items.length}`);
    }
    /**
     * Tick the queue:
     *   1. Drop hard-expired items (age > 3× TTL).
     *   2. Promote any item deferred > 30 s by one priority tier (starvation prevention).
     *   3. Re-sort by priority descending so pop() always returns the highest.
     */
    tick() {
        const now = Date.now();
        const before = this.items.length;
        // Hard expiry
        this.items = this.items.filter((i) => {
            const age = now - i.deferredAt;
            if (age > DEFER_MAX_AGE_MS) {
                console.log(`[STG-QUEUE] EXPIRED  signal=${i.signal.id.slice(0, 8)} ` +
                    `age=${(age / 1000).toFixed(1)}s`);
                return false;
            }
            return true;
        });
        // Starvation prevention
        let promoted = 0;
        for (const item of this.items) {
            const age = now - item.deferredAt;
            if (age > DEFER_TTL_MS && !item.promoted) {
                item.priority = Math.min(item.priority + 1, 5);
                item.promoted = true;
                promoted++;
                console.log(`[STG-QUEUE] PROMOTE  signal=${item.signal.id.slice(0, 8)} ` +
                    `→ priority=${item.priority} (starvation prevention)`);
            }
        }
        // Sort highest-priority first
        this.items.sort((a, b) => b.priority - a.priority);
        const purged = before - this.items.length;
        if (purged > 0 || promoted > 0) {
            console.log(`[STG-QUEUE] TICK  purged=${purged} promoted=${promoted} remaining=${this.items.length}`);
        }
    }
    /** Pop the highest-priority deferred item. Returns undefined if queue is empty. */
    pop() {
        return this.items.shift();
    }
    /** Peek at the next item without removing it. */
    peek() {
        return this.items[0];
    }
    /** Current number of items in the queue. */
    size() {
        return this.items.length;
    }
    /** Drain the full queue (for testing / cycle processing). */
    drain() {
        const all = [...this.items];
        this.items = [];
        return all;
    }
}
/** Shared defer queue — exported so slice1-cycle.ts can drain on each cycle. */
exports.deferQueue = new DeferQueue();
// ---------------------------------------------------------------------------
// STG mark — stamps signal as brain-approved
// ---------------------------------------------------------------------------
function markSignalVerified(signal) {
    return { ...signal, stg_verified: true };
}
// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------
function evaluateSTG(signal, ctx = {}) {
    const { triagePriority = 1, batteryPct = 100, cpuRisk = 0.0 } = ctx;
    acquireSTGLock(signal.id);
    try {
        console.log(`[STG] priority=${triagePriority} battery=${batteryPct}% cpu_risk=${cpuRisk.toFixed(2)} ` +
            `signal="${String(signal.raw_content).slice(0, 50)}"`);
        // Pre-checks
        if (signal.firewall_status === 'blocked')
            return 'DENY';
        if (!String(signal.raw_content ?? '').trim())
            return 'DENY';
        const lower = String(signal.raw_content).toLowerCase();
        if (FORCE_OPEN_KEYWORDS.some((kw) => lower.includes(kw))) {
            console.log('[STG] Force-OPEN: distress/query keyword');
            return 'OPEN';
        }
        if (signal.threat_flag)
            return 'OPEN';
        // v16 §31.8 — Condition 1: critical priority override
        if (triagePriority >= CRITICAL_THRESHOLD)
            return 'OPEN';
        // v16 §31.8 — Condition 2: resource gate (Slice 1 weights)
        if (batteryPct > BATTERY_THRESHOLD && cpuRisk < CPU_RISK_THRESHOLD)
            return 'OPEN';
        // v16 §31.8 — Condition 3: default → DEFER (Slice 2: pushed to queue by caller)
        return 'DEFER';
    }
    finally {
        releaseSTGLock(signal.id);
    }
}
function shouldThink(signal) {
    return !String(signal.raw_content ?? '').toLowerCase().includes('forbidden');
}

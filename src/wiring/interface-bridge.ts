/**
 * Interface Bridge — WebSocket server that connects alive-runtime to ALIVE Studio.
 *
 * Listens on port 2719 (configurable via BRIDGE_PORT env var).
 *
 * Protocol:
 *   Browser → Studio server → InterfaceBridge : InterfaceCommand  (JSON)
 *   InterfaceBridge → Studio server → Browser : RuntimeEvent      (JSON)
 *
 * Commands handled:
 *   start           — mark runtime as running, emit runtime.started
 *   stop            — mark runtime as stopped, emit runtime.stopped
 *   inject_signal   — run the real pipeline, streaming all stage events back
 *   request_status  — emit a status.update snapshot
 *   clear_trace     — no-op server-side (trace lives in the browser)
 *
 * Architecture boundary:
 *   This class is the ONLY place in alive-runtime that speaks the Studio
 *   RuntimeEvent / InterfaceCommand protocol.  pipeline.ts and everything
 *   below it are completely unaware of the UI.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { runPipeline } from './pipeline';
import type {
  RuntimeEvent,
  InterfaceCommand,
  RuntimeStatus,
} from '../../../alive-interface/studio/packages/shared-types/src/index';

// ─── Configuration ───────────────────────────────────────────────────────────

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 2719);

// ─── InterfaceBridge ─────────────────────────────────────────────────────────

export class InterfaceBridge {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  // Runtime session state
  private running   = false;
  private profile   = 'default';
  private startedAt = 0;
  private signalCount = 0;
  private errorCount  = 0;
  private lastSignal?: string;
  private lastSTG?:   'OPEN' | 'DEFER' | 'DENY';

  constructor() {
    this.wss = new WebSocketServer({ port: BRIDGE_PORT });

    this.wss.on('listening', () => {
      console.log(`[Bridge] Interface bridge listening on ws://localhost:${BRIDGE_PORT}`);
    });

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('[Bridge] Studio client connected');
      this.clients.add(ws);

      // Send connection confirmation and current status immediately
      this.sendTo(ws, { type: 'studio.connected', timestamp: Date.now() });
      this.sendTo(ws, { type: 'status.update', status: this.buildStatus() });

      ws.on('message', (data: Buffer) => {
        try {
          const cmd = JSON.parse(data.toString()) as InterfaceCommand;
          this.handleCommand(cmd);
        } catch (_err) {
          this.sendTo(ws, {
            type: 'runtime.error',
            error: 'Malformed command — expected JSON InterfaceCommand',
            stage: 'bridge',
          });
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log('[Bridge] Studio client disconnected');
      });

      ws.on('error', (err: Error) => {
        console.error('[Bridge] WS error:', err.message);
        this.clients.delete(ws);
      });
    });

    this.wss.on('error', (err: Error) => {
      console.error('[Bridge] Server error:', err.message);
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private sendTo(ws: WebSocket, event: RuntimeEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  private broadcast(event: RuntimeEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  private buildStatus(): RuntimeStatus {
    return {
      running:          this.running,
      mode:             'real',
      profile:          this.profile,
      signal_count:     this.signalCount,
      last_signal:      this.lastSignal,
      last_stg_verdict: this.lastSTG,
      error_count:      this.errorCount,
      uptime_ms:        this.running ? Date.now() - this.startedAt : 0,
    };
  }

  private broadcastStatus(): void {
    this.broadcast({ type: 'status.update', status: this.buildStatus() });
  }

  // ─── Command routing ───────────────────────────────────────────────────────

  private handleCommand(cmd: InterfaceCommand): void {
    switch (cmd.type) {

      case 'start': {
        this.running     = true;
        this.profile     = cmd.profile ?? 'default';
        this.startedAt   = Date.now();
        this.signalCount = 0;
        this.errorCount  = 0;
        this.lastSignal  = undefined;
        this.lastSTG     = undefined;
        this.broadcast({ type: 'runtime.started', profile: this.profile, timestamp: Date.now() });
        this.broadcastStatus();
        console.log(`[Bridge] Runtime started (profile=${this.profile})`);
        break;
      }

      case 'stop': {
        this.running = false;
        this.broadcast({ type: 'runtime.stopped', timestamp: Date.now() });
        this.broadcastStatus();
        console.log('[Bridge] Runtime stopped');
        break;
      }

      case 'inject_signal': {
        if (!this.running) {
          this.broadcast({
            type: 'runtime.error',
            error: 'Runtime is not running — send a "start" command first',
            stage: 'bridge',
          });
          return;
        }
        this.signalCount++;
        this.lastSignal = cmd.payload;
        this.runSignal(cmd.payload);
        break;
      }

      case 'request_status': {
        this.broadcastStatus();
        break;
      }

      case 'clear_trace': {
        // Trace lives in the browser; nothing to do on the runtime side.
        break;
      }
    }
  }

  // ─── Pipeline execution ────────────────────────────────────────────────────

  private runSignal(payload: string): void {
    runPipeline(payload, (event: RuntimeEvent) => {
      // Track STG verdict for status reporting
      if (event.type === 'stg.evaluated') {
        this.lastSTG = event.verdict;
      }

      // Relay every pipeline event to all connected Studio clients
      this.broadcast(event);

      // Refresh status summary after the pipeline completes or terminates
      if (
        event.type === 'execution.completed' ||
        event.type === 'pipeline.terminated' ||
        event.type === 'pipeline.error'
      ) {
        this.broadcastStatus();
      }
    }).catch((err: unknown) => {
      this.errorCount++;
      const error = err instanceof Error ? err.message : String(err);
      console.error('[Bridge] Pipeline threw:', error);
      this.broadcast({ type: 'runtime.error', error, stage: 'pipeline' });
      this.broadcastStatus();
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Close the bridge WebSocket server (call on process exit or test teardown). */
  close(): void {
    this.wss.close(() => console.log('[Bridge] Server closed'));
  }

  /** Legacy push-state stub — kept for any callers that existed before this bridge. */
  pushState(_state: unknown): void { /* no-op */ }
}

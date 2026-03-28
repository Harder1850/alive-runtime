/**
 * Standalone entry point for the InterfaceBridge.
 *
 * Starts a WebSocket server on port 2719 (or BRIDGE_PORT env var) that
 * ALIVE Studio can connect to when ALIVE_REAL_RUNTIME=true.
 *
 * Usage:
 *   node --import tsx src/wiring/start-bridge.ts
 *
 * Or from package.json scripts:
 *   "start:bridge": "node --import tsx src/wiring/start-bridge.ts"
 */

import { InterfaceBridge } from './interface-bridge';

const bridge = new InterfaceBridge();

console.log('[Bridge] Standalone mode — waiting for Studio connections.');
console.log('[Bridge] Press Ctrl+C to stop.');

process.on('SIGINT', () => {
  console.log('\n[Bridge] Shutting down...');
  bridge.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  bridge.close();
  process.exit(0);
});

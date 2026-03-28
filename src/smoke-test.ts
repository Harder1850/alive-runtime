/**
 * Smoke Test — CPU Cycle
 * Tests the complete ALIVE pipeline with a CPU signal
 */

import { readCpuSignal } from '../../alive-body/src/adapters/cpu-monitor';
import { firewallCheck } from '../../alive-body/src/nervous-system/firewall';
import { runCycle } from './cycle';

async function smokeTest() {
  console.log('\n=== ALIVE CPU Cycle Smoke Test ===\n');

  try {
    // Step 1: Read CPU signal
    console.log('[SMOKE] Reading CPU signal...');
    const rawSignal = await readCpuSignal();
    console.log(`[SMOKE] Signal ID: ${rawSignal.id}`);
    console.log(`[SMOKE] Kind: ${rawSignal.kind}, Urgency: ${rawSignal.urgency.toFixed(2)}\n`);

    // Step 2: Firewall check
    console.log('[SMOKE] Running firewall check...');
    const clearedSignal = firewallCheck(rawSignal);
    console.log(`[SMOKE] Firewall status: ${clearedSignal.firewall_status}\n`);

    if (clearedSignal.firewall_status !== 'cleared') {
      console.log('[SMOKE] Signal blocked by firewall. Aborting cycle.');
      return;
    }

    // Step 3: Run cycle
    console.log('[SMOKE] Running full cycle...\n');
    const result = await runCycle(clearedSignal);

    // Step 4: Print results
    console.log('\n=== Cycle Complete ===');
    console.log(`Signal ID:        ${result.signal_id}`);
    console.log(`STG Result:       ${result.stg_result}`);
    console.log(`STG Reason:       ${result.stg_reason}`);
    console.log(`Synthesizer:      ${result.synthesizer_level}`);
    console.log(`Admissibility:    ${result.admissibility}`);
    console.log(`Action Executed:  ${result.executed}`);
    console.log(`Cycle Count:      ${result.asm_after.cycleCount}`);
    console.log(`CPU Risk (ASM):   ${result.asm_after.cpu_risk.toFixed(4)}`);
    console.log(`Experience Log:   ${result.experience_stream}`);
    console.log('\n=== Smoke Test Passed ===\n');
  } catch (err) {
    console.error('[SMOKE] Test failed:', err);
    process.exit(1);
  }
}

smokeTest();

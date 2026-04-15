import type { Signal } from '../../../alive-constitution/contracts';
import type { Decision } from '../../../alive-constitution/contracts/decision';
import { think } from '../../../alive-mind/src/spine/mind-loop';

export function callMind(signal: Signal): Decision {
  return think(signal);
}

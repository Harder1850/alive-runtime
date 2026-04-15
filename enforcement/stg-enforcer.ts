/**
 * STG Enforcer — Stop-Thinking Gate token lifecycle manager.
 *
 * Each cognitive cycle requires a one-time-use STG authorization token.
 * Once a token is consumed it is permanently invalidated. Any attempt to
 * consume the same token a second time ("double-spend") is blocked and throws.
 *
 * Invariant enforced: NO_COGNITION_WITHOUT_STG
 * (alive-constitution/invariants/system-invariants.ts)
 */

import type { Signal } from '../../alive-constitution/contracts';

export interface STGToken {
  readonly id: string;
  readonly signalId: string;
  readonly issuedAt: number;
}

// Tokens that have been issued but not yet consumed.
const pendingTokens = new Map<string, STGToken>();

// Permanently burned token IDs — never cleared at runtime.
const consumedTokenIds = new Set<string>();

/** Issue a single-use STG authorization token for a given signal. */
export function issueSTGToken(signal: Signal): STGToken {
  const token: STGToken = {
    id: `stg-${signal.id}-${Date.now()}`,
    signalId: signal.id,
    issuedAt: Date.now(),
  };
  pendingTokens.set(token.id, token);
  return token;
}

/**
 * Consume a token, authorizing one cognitive cycle.
 * Throws if the token was already consumed (double-spend attack)
 * or was never issued (counterfeit token).
 */
export function consumeSTGToken(tokenId: string): STGToken {
  if (consumedTokenIds.has(tokenId)) {
    throw new Error(
      `DOUBLE-SPEND BLOCKED: STG token "${tokenId}" has already been consumed. ` +
      'Single-use authorization tokens cannot be reused. ' +
      'Invariant NO_COGNITION_WITHOUT_STG has been violated.'
    );
  }

  const token = pendingTokens.get(tokenId);
  if (!token) {
    throw new Error(
      `INVALID TOKEN: STG token "${tokenId}" was never issued or has expired.`
    );
  }

  consumedTokenIds.add(tokenId);
  pendingTokens.delete(tokenId);
  return token;
}

/** Reset enforcer state — for use in tests only. */
export function resetSTGEnforcer(): void {
  pendingTokens.clear();
  consumedTokenIds.clear();
}

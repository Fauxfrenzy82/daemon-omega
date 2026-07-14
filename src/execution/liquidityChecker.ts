import * as api from '@protocolink/api';
import { TokenInfo } from '../config/tokens';
import { getChainId } from './protocolinkClient';
import { createLogger } from '../utils/logger';

const log = createLogger('liquidityChecker');

export interface FlashLoanAvailability {
  token: TokenInfo;
  amount: string; // raw amount in token decimals
  availableProviders: string[];
  isAvailable: boolean;
  reason?: string;
}

/**
 * Checks if a given token and amount can be flash‑loaned on Polygon.
 * Returns the list of providers (Aave V3, Balancer V2) that can fulfill it.
 */
export async function checkFlashLoanLiquidity(
  token: TokenInfo,
  amount: string
): Promise<FlashLoanAvailability> {
  const chainId = getChainId();
  const availableProviders: string[] = [];

  // Helper to test a provider
  async function testProvider(providerName: string, getQuoteFn: () => Promise<any>) {
    try {
      const quote = await getQuoteFn();
      // If quote succeeds, liquidity exists
      log.debug(`${providerName}: ${token.symbol} flash loan available for amount ${amount}`);
      availableProviders.push(providerName);
    } catch (error: any) {
      const msg = error?.message || String(error);
      log.debug(`${providerName}: ${token.symbol} flash loan failed: ${msg}`);
    }
  }

  // 1. Aave V3
  await testProvider('Aave V3', async () => {
    const tokenList = await api.protocols.aavev3.getFlashLoanTokenList(chainId);
    const found = tokenList.some((t: any) => t.address.toLowerCase() === token.address.toLowerCase());
    if (!found) {
      throw new Error('Token not in Aave V3 flash loan list');
    }
    return api.protocols.aavev3.getFlashLoanQuotation(chainId, {
      loans: [{ token: token, amount: amount }],
    });
  });

  // 2. Balancer V2
  await testProvider('Balancer V2', async () => {
    const tokenList = await api.protocols.balancerv2.getFlashLoanTokenList(chainId);
    const found = tokenList.some((t: any) => t.address.toLowerCase() === token.address.toLowerCase());
    if (!found) {
      throw new Error('Token not in Balancer V2 flash loan list');
    }
    return api.protocols.balancerv2.getFlashLoanQuotation(chainId, {
      loans: [{ token: token, amount: amount }],
    });
  });

  // Uniswap V3 does not expose flash loan logic via Protocolink, so we skip it.

  const isAvailable = availableProviders.length > 0;
  return {
    token,
    amount,
    availableProviders,
    isAvailable,
    reason: isAvailable
      ? `Available on: ${availableProviders.join(', ')}`
      : 'Not available on Aave V3 or Balancer V2 (insufficient liquidity or unsupported token)',
  };
}
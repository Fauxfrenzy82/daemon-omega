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
 * Logs every step with extreme detail.
 */
export async function checkFlashLoanLiquidity(
  token: TokenInfo,
  amount: string
): Promise<FlashLoanAvailability> {
  const chainId = getChainId();
  const availableProviders: string[] = [];

  // Human‑readable amount for logging
  const humanAmount = Number(amount) / (10 ** token.decimals);

  log.info('🔍 Liquidity check started', {
    chainId,
    token: token.symbol,
    tokenAddress: token.address,
    decimals: token.decimals,
    rawAmount: amount,
    humanAmount: humanAmount.toFixed(token.decimals > 6 ? 4 : 2),
  });

  // Helper to test a provider with detailed logging
  async function testProvider(providerName: string, getQuoteFn: () => Promise<any>) {
    log.info(`📡 Testing ${providerName} for ${token.symbol}`, {
      amount: amount,
      humanAmount: humanAmount.toFixed(token.decimals > 6 ? 4 : 2),
    });

    try {
      // 1. Get the token list (if the provider supports it)
      let tokenList: any[] = [];
      let tokenFound = false;

      try {
        if (providerName === 'Aave V3') {
          tokenList = await api.protocols.aavev3.getFlashLoanTokenList(chainId);
        } else if (providerName === 'Balancer V2') {
          tokenList = await api.protocols.balancerv2.getFlashLoanTokenList(chainId);
        }
        log.info(`📋 ${providerName} token list received`, {
          count: tokenList?.length || 0,
          sample: tokenList?.slice(0, 3).map((t: any) => ({ symbol: t.symbol, address: t.address })),
        });
        tokenFound = tokenList.some((t: any) => t.address.toLowerCase() === token.address.toLowerCase());
        log.info(`🔎 Token ${token.symbol} found in ${providerName} list?`, { found: tokenFound });
      } catch (listError: any) {
        log.warn(`⚠️ Failed to fetch ${providerName} token list`, {
          error: listError?.message || String(listError),
          responseData: listError?.response?.data,
        });
        // Continue anyway – some providers might not have a list method.
      }

      // 2. If token not found in list (or list failed), still attempt quotation (some protocols allow direct quote)
      // We'll still try the quotation regardless, because the list might be incomplete or the token is supported anyway.

      log.info(`📤 Requesting flash loan quotation from ${providerName}`, {
        token: token.symbol,
        tokenAddress: token.address,
        amount: amount,
        humanAmount: humanAmount.toFixed(token.decimals > 6 ? 4 : 2),
      });

      const quote = await getQuoteFn();

      log.info(`✅ ${providerName} flash loan quotation succeeded`, {
        token: token.symbol,
        amount: amount,
        quote: JSON.stringify(quote, null, 2),
      });

      availableProviders.push(providerName);
    } catch (error: any) {
      // Detailed error logging
      const errorMessage = error?.message || String(error);
      const responseData = error?.response?.data;
      const statusCode = error?.response?.status;

      log.warn(`❌ ${providerName} flash loan quotation failed`, {
        token: token.symbol,
        amount: amount,
        humanAmount: humanAmount.toFixed(token.decimals > 6 ? 4 : 2),
        statusCode,
        errorMessage,
        responseData: typeof responseData === 'string' ? responseData : JSON.stringify(responseData ?? {}),
        stack: error?.stack,
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error)),
      });
    }
  }

  // 1. Aave V3
  await testProvider('Aave V3', async () => {
    return api.protocols.aavev3.getFlashLoanQuotation(chainId, {
      loans: [{ token: token, amount: amount }],
    });
  });

  // 2. Balancer V2
  await testProvider('Balancer V2', async () => {
    return api.protocols.balancerv2.getFlashLoanQuotation(chainId, {
      loans: [{ token: token, amount: amount }],
    });
  });

  // Uniswap V3 does not expose a flash‑loan token list or quotation via Protocolink, so skip.

  const isAvailable = availableProviders.length > 0;
  const result: FlashLoanAvailability = {
    token,
    amount,
    availableProviders,
    isAvailable,
    reason: isAvailable
      ? `Available on: ${availableProviders.join(', ')}`
      : 'Not available on Aave V3 or Balancer V2 (insufficient liquidity or unsupported token)',
  };

  log.info(`🏁 Liquidity check result for ${token.symbol}`, {
    isAvailable,
    availableProviders,
    reason: result.reason,
  });

  return result;
}
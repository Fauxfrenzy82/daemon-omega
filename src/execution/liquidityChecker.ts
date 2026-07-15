import * as api from '@protocolink/api';
import { TokenInfo } from '../config/tokens';
import { getChainId } from './protocolinkClient';
import { createLogger } from '../utils/logger';

const log = createLogger('liquidityChecker');

export interface FlashLoanAvailability {
  token: TokenInfo;
  amount: string;
  availableProviders: string[];
  isAvailable: boolean;
  reason?: string;
}

export async function checkFlashLoanLiquidity(
  token: TokenInfo,
  amount: string
): Promise<FlashLoanAvailability> {
  const chainId = getChainId();
  const availableProviders: string[] = [];

  const humanAmount = Number(amount) / (10 ** token.decimals);

  log.info('🔍 Liquidity check started', {
    chainId,
    token: token.symbol,
    tokenAddress: token.address,
    decimals: token.decimals,
    rawAmount: amount,
    humanAmount: humanAmount.toFixed(token.decimals > 6 ? 4 : 2),
  });

  async function testProvider(providerName: string, getQuoteFn: (matchedToken: any) => Promise<any>) {
    log.info(`📡 Testing ${providerName} for ${token.symbol}`, {
      amount: amount,
      humanAmount: humanAmount.toFixed(token.decimals > 6 ? 4 : 2),
    });

    try {
      let tokenList: any[] = [];
      let matchedToken: any = null;

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

        // Use the ACTUAL token object the provider returned — not a
        // reconstructed one — since Protocolink's flash-loan token
        // objects may carry protocol-specific fields our own TokenInfo
        // doesn't have. This is THE fix for "insufficient borrowing
        // capacity" appearing on tokens with tens of millions of
        // dollars in real, verified on-chain liquidity.
        matchedToken = tokenList.find(
          (t: any) => t.address.toLowerCase() === token.address.toLowerCase()
        );
        log.info(`🔎 Token ${token.symbol} matched object in ${providerName} list?`, {
          found: !!matchedToken,
          matchedTokenShape: matchedToken ? Object.keys(matchedToken) : null,
        });
      } catch (listError: any) {
        log.warn(`⚠️ Failed to fetch ${providerName} token list`, {
          error: listError?.message || String(listError),
          responseData: listError?.response?.data,
        });
      }

      if (!matchedToken) {
        log.warn(`⏭️ Skipping ${providerName} quotation — token not found in provider's own list`, {
          token: token.symbol,
        });
        return;
      }

      log.info(`📤 Requesting flash loan quotation from ${providerName}`, {
        token: token.symbol,
        tokenAddress: matchedToken.address,
        amount: amount,
        humanAmount: humanAmount.toFixed(token.decimals > 6 ? 4 : 2),
      });

      const quote = await getQuoteFn(matchedToken);

      log.info(`✅ ${providerName} flash loan quotation succeeded`, {
        token: token.symbol,
        amount: amount,
      });

      availableProviders.push(providerName);
    } catch (error: any) {
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
      });
    }
  }

  await testProvider('Aave V3', async (matchedToken) => {
    return api.protocols.aavev3.getFlashLoanQuotation(chainId, {
      loans: [{ token: matchedToken, amount: amount }],
    });
  });

  await testProvider('Balancer V2', async (matchedToken) => {
    return api.protocols.balancerv2.getFlashLoanQuotation(chainId, {
      loans: [{ token: matchedToken, amount: amount }],
    });
  });

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
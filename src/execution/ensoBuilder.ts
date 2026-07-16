import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { executionWallet } from '../treasury/wallets';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import axios from 'axios';
import { env } from '../config/env';

const log = createLogger('ensoBuilder');

export interface BuiltBundle {
  bundleData: any;
  flashLoanAmount: string;
  flashLoanToken: TokenInfo;
}

export interface FlashLoanProvider {
  name: string;
  protocol: 'aave-v3' | 'morpho-markets-v1' | 'balancer-v3' | 'uniswap-v3';
}

// Simple cache to avoid repeating the same request within 10 seconds
const bundleCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL_MS = 10000;

export const FLASH_LOAN_PROVIDERS: FlashLoanProvider[] = [
  { name: 'Aave V3', protocol: 'aave-v3' },
  { name: 'Morpho', protocol: 'morpho-markets-v1' },
];

export async function buildArbitrageBundle(
  opp: EvaluatedOpportunity,
  flashLoanToken: TokenInfo,
  flashLoanAmountRaw: string,
  provider: FlashLoanProvider,
  options: { buyRequiresRequote?: boolean; sellRequiresRequote?: boolean } = {}
): Promise<BuiltBundle> {
  const chainId = activeChain.chainId;
  // ✅ FIX: Enso API expects lowercase addresses (not checksummed)
  const fromAddress = executionWallet.address.toLowerCase() as `0x${string}`;

  const humanAmount = Number(flashLoanAmountRaw) / 10 ** flashLoanToken.decimals;

  // Build cache key
  const cacheKey = `${provider.protocol}:${flashLoanToken.address}:${flashLoanAmountRaw}`;
  const cached = bundleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    log.info(`✅ Using cached bundle for ${provider.name} / ${flashLoanToken.symbol}`);
    return {
      bundleData: cached.data,
      flashLoanAmount: flashLoanAmountRaw,
      flashLoanToken,
    };
  }

  log.info('💡 Building Enso flash‑loan bundle (direct HTTP)', {
    pair: opp.pair.id,
    flashLoanToken: flashLoanToken.symbol,
    provider: provider.name,
    amount: humanAmount.toFixed(flashLoanToken.decimals > 6 ? 4 : 2),
    chainId,
  });

  const actions = [
    {
      protocol: provider.protocol,
      action: 'flashloan',
      args: {
        flashloanToken: flashLoanToken.address as `0x${string}`,
        flashloanAmount: flashLoanAmountRaw,
        tokenOut: [flashLoanToken.address as `0x${string}`],
        callback: [
          {
            protocol: 'enso',
            action: 'route',
            args: {
              tokenIn: flashLoanToken.address as `0x${string}`,
              tokenOut: opp.pair.base.address as `0x${string}`,
              amountIn: { useOutputOfCallAt: 0 },
              slippage: '100',
            },
          },
          {
            protocol: 'enso',
            action: 'route',
            args: {
              tokenIn: opp.pair.base.address as `0x${string}`,
              tokenOut: flashLoanToken.address as `0x${string}`,
              amountIn: { useOutputOfCallAt: 1 },
              slippage: '100',
            },
          },
        ],
      },
    },
  ];

  const requestBody = {
    fromAddress,
    chainId,
    routingStrategy: 'router',
    actions,
  };

  log.debug('📦 Enso bundle payload', {
    payload: JSON.stringify(requestBody, null, 2),
  });

  const baseUrl = env.ENSO_BASE_URL || 'https://api.enso.build';
  const endpoint = `${baseUrl}/api/v1/shortcuts/bundle`;

  try {
    const response = await axios.post(endpoint, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.ENSO_API_KEY}`,
      },
      timeout: 15000,
    });

    const bundleData = response.data;
    bundleCache.set(cacheKey, { data: bundleData, timestamp: Date.now() });

    log.info('✅ Enso bundle created (direct HTTP)', {
      provider: provider.name,
      actionsCount: actions.length,
      hasTx: !!bundleData?.tx,
      status: response.status,
    });

    return {
      bundleData,
      flashLoanAmount: flashLoanAmountRaw,
      flashLoanToken,
    };
  } catch (error: any) {
    if (error?.response?.status === 429) {
      log.warn(`⏳ Rate limited for ${provider.name} / ${flashLoanToken.symbol}, caching failure for ${CACHE_TTL_MS}ms`);
      bundleCache.set(cacheKey, { data: null, timestamp: Date.now() });
    } else {
      log.error(`❌ Enso API error for ${provider.name} / ${flashLoanToken.symbol}`, {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
      });
    }
    throw error;
  }
}
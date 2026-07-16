kimport { ethers } from 'ethers';
import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { executionWallet } from '../treasury/wallets';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { getEnsoClient } from './ensoClient';

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
  const fromAddress = ethers.utils.getAddress(executionWallet.address) as `0x${string}`;

  const humanAmount = Number(flashLoanAmountRaw) / 10 ** flashLoanToken.decimals;

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

  log.info('💡 Building Enso flash‑loan bundle (via SDK)', {
    pair: opp.pair.id,
    flashLoanToken: flashLoanToken.symbol,
    provider: provider.name,
    amount: humanAmount.toFixed(flashLoanToken.decimals > 6 ? 4 : 2),
    chainId,
  });

  const bundleParams = {
    fromAddress,
    chainId,
    routingStrategy: 'router' as const,
  };

  // FIX: callback steps form their OWN independent index sequence,
  // separate from the outer bundle's top-level actions. Confirmed via
  // Enso's live getActions()/getActionsBySlug() schema: "callback"
  // takes ActionToBundle[], and useOutputOfCallAt indexes into
  // whichever action-list context it's evaluated in.
  //
  // The first callback step (buy swap) has NO prior callback action
  // to reference — it must use the literal flashloanAmount directly,
  // not { useOutputOfCallAt: 0 }, since index 0 IS this step itself.
  // "No previous call found with index 0" was Enso correctly
  // reporting exactly that: nothing exists yet at that point to
  // reference.
  //
  // Only the SECOND callback step (sell swap) correctly uses
  // { useOutputOfCallAt: 0 } — meaning "the output of callback step
  // at index 0", which by then is the completed first swap.
  const actions = [
    {
      protocol: provider.protocol,
      action: 'flashloan' as const,
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
              amountIn: flashLoanAmountRaw, // literal amount — this IS index 0, nothing to reference yet
              slippage: '100',
            },
          },
          {
            protocol: 'enso',
            action: 'route',
            args: {
              tokenIn: opp.pair.base.address as `0x${string}`,
              tokenOut: flashLoanToken.address as `0x${string}`,
              amountIn: { useOutputOfCallAt: 0 }, // output of callback step 0 (the buy swap above)
              slippage: '100',
            },
          },
        ],
      },
    },
  ];

  log.debug('📦 Enso bundle params + actions', {
    bundleParams: JSON.stringify(bundleParams, null, 2),
    actions: JSON.stringify(actions, null, 2),
  });

  try {
    const enso = getEnsoClient();
    const bundleData = await enso.getBundleData(bundleParams, actions as any);

    bundleCache.set(cacheKey, { data: bundleData, timestamp: Date.now() });

    log.info('✅ Enso bundle created (via SDK)', {
      provider: provider.name,
      actionsCount: actions.length,
      hasTx: !!(bundleData as any)?.tx,
    });

    return {
      bundleData,
      flashLoanAmount: flashLoanAmountRaw,
      flashLoanToken,
    };
  } catch (error: any) {
    const isEnsoApiError = error?.constructor?.name === 'EnsoApiError';
    if (error?.statusCode === 429 || error?.response?.status === 429) {
      log.warn(`⏳ Rate limited for ${provider.name} / ${flashLoanToken.symbol}, caching failure for ${CACHE_TTL_MS}ms`);
      bundleCache.set(cacheKey, { data: null, timestamp: Date.now() });
    } else {
      log.error(`❌ Enso API error for ${provider.name} / ${flashLoanToken.symbol}`, {
        isEnsoApiError,
        statusCode: error?.statusCode || error?.response?.status,
        responseData: error?.responseData || error?.response?.data,
        message: error?.message,
      });
    }
    throw error;
  }
}
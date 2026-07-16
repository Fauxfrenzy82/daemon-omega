import { ethers } from 'ethers';
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

  // Using the SDK's own getBundleData(params, actions) — a TWO-argument
  // call, not a single flattened object — instead of hand-built axios.
  // Every prior attempt sent { fromAddress, chainId, routingStrategy,
  // actions } as one flat JSON body via raw HTTP, and Enso rejected it
  // with "fromAddress must be an Ethereum address" even when the
  // address itself was independently verified correct (right length,
  // valid hex, both lowercase and checksummed forms tried). The
  // SDK's documented signature — getBundleData(params, actions) —
  // takes params and actions as SEPARATE arguments, meaning the SDK
  // very likely serializes the actual HTTP request differently than
  // a flat merge, and Enso's backend schema validator may reject a
  // flat body's structure entirely, surfacing a misleading first-field
  // error rather than the real structural mismatch. Using the actual
  // SDK method guarantees the request matches what Enso's team tests
  // against, removing our own HTTP-layer guesswork from the equation.
  const bundleParams = {
    fromAddress,
    chainId,
    routingStrategy: 'router' as const,
  };

  // ⚠️ Still unverified: whether useOutputOfCallAt indexes correctly
  // into a flashloan's nested callback array. Check bundleData's
  // route/simulation breakdown once a request succeeds, before
  // trusting executed swap amounts at real position sizes.
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
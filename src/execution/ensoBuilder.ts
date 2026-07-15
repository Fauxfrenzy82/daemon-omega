import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { getEnsoClient } from './ensoClient';
import { executionWallet } from '../treasury/wallets';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';

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

/**
 * Available flash‑loan providers via Enso Bundle API.
 * @see https://docs.enso.build/pages/build/reference/flashloans
 */
export const FLASH_LOAN_PROVIDERS: FlashLoanProvider[] = [
  { name: 'Aave V3', protocol: 'aave-v3' },
  { name: 'Morpho', protocol: 'morpho-markets-v1' },
  { name: 'Balancer V3', protocol: 'balancer-v3' },
  { name: 'Uniswap V3', protocol: 'uniswap-v3' },
];

/**
 * Build a flash‑loan arbitrage bundle using Enso's Bundle API.
 * 
 * According to Enso docs, flashloans are only available via Bundle API:
 * @see https://docs.enso.build/pages/build/reference/flashloans
 */
export async function buildArbitrageBundle(
  opp: EvaluatedOpportunity,
  flashLoanToken: TokenInfo,
  flashLoanAmountRaw: string,
  provider: FlashLoanProvider,
  options: { buyRequiresRequote?: boolean; sellRequiresRequote?: boolean } = {}
): Promise<BuiltBundle> {
  const enso = getEnsoClient();
  const chainId = activeChain.chainId;
  const fromAddress = executionWallet.address as `0x${string}`;

  const humanAmount = Number(flashLoanAmountRaw) / 10 ** flashLoanToken.decimals;

  log.info('💡 Building Enso flash‑loan bundle', {
    pair: opp.pair.id,
    flashLoanToken: flashLoanToken.symbol,
    provider: provider.name,
    amount: humanAmount.toFixed(flashLoanToken.decimals > 6 ? 4 : 2),
    chainId,
  });

  /**
   * Flashloan action structure from Enso docs:
   * 
   * {
   *   protocol: "aave-v3" | "morpho-markets-v1" | "balancer-v3" | "uniswap-v3",
   *   action: "flashloan",
   *   args: {
   *     flashloanToken: "0x...",
   *     flashloanAmount: "1000000000000000000",
   *     tokenOut: ["0x..."],  // tokens expected after callback
   *     callback: [ ... ]     // actions to execute after receiving flash loan
   *   }
   * }
   * 
   * @see https://docs.enso.build/pages/build/reference/flashloans#parameters
   */
  const actions = [
    // 1. Flash loan
    {
      protocol: provider.protocol,
      action: 'flashloan',
      args: {
        flashloanToken: flashLoanToken.address as `0x${string}`,
        flashloanAmount: flashLoanAmountRaw,
        tokenOut: [flashLoanToken.address as `0x${string}`],
        callback: [
          // 2. Buy swap: flashLoanToken → base
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
          // 3. Sell swap: base → flashLoanToken
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

  log.debug('📦 Enso bundle actions', {
    actions: JSON.stringify(actions, null, 2),
  });

  const bundleData = await enso.getBundleData(
    {
      fromAddress,
      chainId,
      routingStrategy: 'router',
    },
    actions
  );

  log.info('✅ Enso bundle created', {
    provider: provider.name,
    actionsCount: actions.length,
    hasTx: !!bundleData?.tx,
  });

  return {
    bundleData,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken,
  };
}
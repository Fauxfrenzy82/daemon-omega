import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { getEnsoClient } from './ensoClient';
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
  protocol: string;
}

/**
 * Available flash‑loan providers via Enso Bundle API:
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
 * The bundle executes:
 * 1. Flash loan (borrow flashLoanToken)
 * 2. Buy swap (flashLoanToken → base token)
 * 3. Sell swap (base token → flashLoanToken)
 * 4. Repay flash loan (automatically enforced by Enso)
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
  const fromAddress = ''; // Set by router before execution

  const humanAmount = Number(flashLoanAmountRaw) / 10 ** flashLoanToken.decimals;

  log.info('💡 Building Enso flash‑loan bundle', {
    pair: opp.pair.id,
    flashLoanToken: flashLoanToken.symbol,
    provider: provider.name,
    amount: humanAmount.toFixed(flashLoanToken.decimals > 6 ? 4 : 2),
  });

  /**
   * Enso flash‑loan bundle structure:
   * 
   * Action 0: Flash loan from the selected protocol
   * Action 1: Route (swap) flashLoanToken → base token (buy)
   * Action 2: Route (swap) base token → flashLoanToken (sell)
   * 
   * Enso automatically handles repayment – the flash loan callback
   * must produce enough tokens to repay the borrowed amount + fees.
   */
  const actions = [
    // 1. Flash loan
    {
      protocol: provider.protocol,
      action: 'flashloan',
      args: {
        flashloanToken: flashLoanToken.address,
        flashloanAmount: flashLoanAmountRaw,
        tokenOut: [flashLoanToken.address],
        callback: [
          // 2. Buy swap: flashLoanToken → base
          {
            protocol: 'enso',
            action: 'route',
            args: {
              tokenIn: flashLoanToken.address,
              tokenOut: opp.pair.base.address,
              amountIn: { useOutputOfCallAt: 0 },
              slippage: '100',
            },
          },
          // 3. Sell swap: base → flashLoanToken
          {
            protocol: 'enso',
            action: 'route',
            args: {
              tokenIn: opp.pair.base.address,
              tokenOut: flashLoanToken.address,
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
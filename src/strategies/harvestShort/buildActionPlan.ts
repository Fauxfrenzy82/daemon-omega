import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { env } from '../../config/env';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';
import { createLogger } from '../../utils/logger';

const log = createLogger('buildActionPlan');

/**
 * 🔥 Supported flashloan protocols on Polygon
 * - morpho-markets-v1: 0% fee (BEST for arbitrage)
 * - aave-v3: Dynamic fee (5-9 bps)
 * - balancer-v3: Pool-specific fee
 */
const SUPPORTED_FLASHLOAN_PROTOCOLS = [
  'morpho-markets-v1',
  'aave-v3',
  'balancer-v3',
] as const;

type FlashloanProtocol = typeof SUPPORTED_FLASHLOAN_PROTOCOLS[number];

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const {
    positionAddress,
    rewardToken,
    entryToken,
    rewardAmount,
    sellQuote,
    useFlashloanArbitrage,
    flashloanSizeUsd,
    flashloanAmount,
    buyQuote,
    priceImpactBps,
    _debugSteps,
  } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || entryToken;

  const flashloanProtocol = (env.HARVEST_FLASHLOAN_PROTOCOL || 'morpho-markets-v1') as FlashloanProtocol;

  if (!SUPPORTED_FLASHLOAN_PROTOCOLS.includes(flashloanProtocol)) {
    log.warn(`Unsupported flashloan protocol: ${flashloanProtocol}, falling back to morpho-markets-v1`);
  }

  const useArbitrage = useFlashloanArbitrage === true && flashloanAmount && buyQuote;

  let actualFlashloanAmount: string;
  let flashloanAmountHuman: string;

  if (useArbitrage && flashloanAmount) {
    actualFlashloanAmount = flashloanAmount;
    flashloanAmountHuman = ethers.utils.formatUnits(flashloanAmount, flashLoanToken.decimals);
    log.info(`🚀 Using flashloan arbitrage for harvest`, {
      flashloanSizeUsd,
      flashloanAmount: flashloanAmountHuman,
      entryToken: flashLoanToken.symbol,
      rewardToken: rewardToken.symbol,
      protocol: flashloanProtocol,
      priceImpactBps,
      feePercent: flashloanProtocol === 'morpho-markets-v1' ? '0%' : 'variable',
      debugSteps: _debugSteps?.length || 0,
    });
  } else {
    actualFlashloanAmount = '1';
    flashloanAmountHuman = '1 (minimal)';
    log.info(`🪣 Using minimal flashloan (gas only) for harvest`, {
      protocol: flashloanProtocol,
    });
  }

  // 🔥 Step 1: Harvest rewards using Enso's native harvest action
  // Enso handles the ABI automatically – no custom contract calls needed
  const harvestStep: ActionStep = {
    type: 'harvest',
    protocol: 'enso',
    positionAddress: positionAddress,
    token: rewardToken.address,
  };

  // 🔥 Build the callback actions
  const callbackActions: ActionStep[] = [harvestStep];

  // 🔥 Step 2: If using arbitrage, add the flashloan swap logic
  if (useArbitrage && buyQuote) {
    // Swap entryToken → rewardToken (buy reward token with flashloaned funds)
    const buyStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: flashLoanToken.address,
      tokenOut: rewardToken.address,
      amountIn: actualFlashloanAmount,
      slippage: '100',
      primaryAddress: buyQuote.raw?.primaryAddress || undefined,
      poolFee: buyQuote.raw?.poolFee,
    };
    callbackActions.push(buyStep);

    // 🔥 FIX: After harvesting, sell all rewards back to entryToken
    // Use the actual rewardAmount from discovery (not useOutputOfCallAt)
    const sellStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: rewardToken.address,
      tokenOut: entryToken.address,
      amountIn: rewardAmount,  // ✅ FIX: Use direct amount from discovery
      slippage: '100',
      primaryAddress: sellQuote?.raw?.primaryAddress || undefined,
      poolFee: sellQuote?.raw?.poolFee,
    };
    callbackActions.push(sellStep);

    log.info(`📈 Arbitrage steps added`, {
      buyStep: `${flashLoanToken.symbol} → ${rewardToken.symbol}`,
      sellStep: `${rewardToken.symbol} → ${flashLoanToken.symbol}`,
      flashloanAmount: flashloanAmountHuman,
      rewardAmount: rewardAmount,
      protocol: flashloanProtocol,
    });
  } else {
    // 🔥 Standard harvest + spot sell
    // Use the actual rewardAmount from discovery (not useOutputOfCallAt)
    const sellStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: rewardToken.address,
      tokenOut: entryToken.address,
      amountIn: rewardAmount,  // ✅ FIX: Use direct amount from discovery
      slippage: '100',
      primaryAddress: sellQuote?.raw?.primaryAddress || undefined,
      poolFee: sellQuote?.raw?.poolFee,
    };
    callbackActions.push(sellStep);
  }

  // 🔥 Flashloan step with configurable protocol
  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: flashloanProtocol,
    token: flashLoanToken.address,
    amount: actualFlashloanAmount,
    tokenIn: flashLoanToken.address,
    amountIn: actualFlashloanAmount,
    callback: callbackActions,
  };

  log.info(`✅ Harvest action plan built`, {
    positionAddress,
    rewardToken: rewardToken.symbol,
    entryToken: entryToken.symbol,
    flashloanAmount: flashloanAmountHuman,
    flashloanProtocol,
    callbackActionCount: callbackActions.length,
    usingArbitrage: useArbitrage,
    rewardAmount: rewardAmount,
    steps: callbackActions.map(a => a.type).join(' → '),
  });

  return {
    flashLoanToken,
    flashLoanAmount: actualFlashloanAmount,
    steps: [flashloanStep],
  };
}
import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { env } from '../../config/env';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';
import { createLogger } from '../../utils/logger';

const log = createLogger('buildActionPlan');

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
  } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || entryToken;

  // 🔥 Determine if we should use flashloan arbitrage
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
    });
  } else {
    // Fallback: minimal flashloan (just to pay gas)
    actualFlashloanAmount = '1';
    flashloanAmountHuman = '1 (minimal)';
    log.info(`🪣 Using minimal flashloan (gas only) for harvest`);
  }

  // Step 1: Harvest rewards
  const harvestStep: ActionStep = {
    type: 'harvest',
    protocol: 'enso',
    positionAddress: positionAddress,
    token: rewardToken.address,
  };

  // 🔥 Build the callback actions
  const callbackActions: ActionStep[] = [harvestStep];

  // Step 2: If using arbitrage, add the flashloan swap logic
  if (useArbitrage && buyQuote) {
    // Swap entryToken → rewardToken (buy QUICK with flashloaned USDC)
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

    // After harvesting, sell all rewards back to entryToken
    const sellStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: rewardToken.address,
      tokenOut: flashLoanToken.address,
      amountIn: { useOutputOfCallAt: 0 }, // Use the output from the last step
      slippage: '100',
      primaryAddress: sellQuote?.raw?.primaryAddress || undefined,
      poolFee: sellQuote?.raw?.poolFee,
    };
    callbackActions.push(sellStep);

    log.info(`📈 Arbitrage steps added`, {
      buyStep: `${flashLoanToken.symbol} → ${rewardToken.symbol}`,
      sellStep: `${rewardToken.symbol} → ${flashLoanToken.symbol}`,
      flashloanAmount: flashloanAmountHuman,
    });
  } else {
    // Standard harvest + spot sell
    const sellStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: rewardToken.address,
      tokenOut: entryToken.address,
      amountIn: { useOutputOfCallAt: 0 },
      slippage: '100',
      primaryAddress: sellQuote?.raw?.primaryAddress || undefined,
      poolFee: sellQuote?.raw?.poolFee,
    };
    callbackActions.push(sellStep);
  }

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
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
    callbackActionCount: callbackActions.length,
    usingArbitrage: useArbitrage,
  });

  return {
    flashLoanToken,
    flashLoanAmount: actualFlashloanAmount,
    steps: [flashloanStep],
  };
}
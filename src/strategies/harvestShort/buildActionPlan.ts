import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { env } from '../../config/env';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { positionAddress, rewardToken, entryToken, rewardAmount, sellQuote } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || entryToken;
  
  // 🔥 FIX: Use configurable flashloan amount in USD
  // If the flashloan token is a stablecoin, use the USD value directly.
  // Otherwise, convert USD to token amount using the token's price.
  let flashLoanAmount: string;
  
  try {
    // Get the price of the flashloan token in USD
    const tokenPrice = await getLiveTokenPriceUsd(flashLoanToken);
    
    // Convert USD amount to token amount
    const amountInHuman = env.HARVEST_FLASHLOAN_AMOUNT_USD / tokenPrice;
    
    // Parse to raw amount with token decimals
    flashLoanAmount = ethers.utils.parseUnits(
      amountInHuman.toFixed(flashLoanToken.decimals),
      flashLoanToken.decimals
    ).toString();
    
    // Cap at MAX_POSITION_SIZE_USD
    const maxPositionUsd = env.MAX_POSITION_SIZE_USD;
    if (env.HARVEST_FLASHLOAN_AMOUNT_USD > maxPositionUsd) {
      const cappedAmount = maxPositionUsd / tokenPrice;
      flashLoanAmount = ethers.utils.parseUnits(
        cappedAmount.toFixed(flashLoanToken.decimals),
        flashLoanToken.decimals
      ).toString();
    }
  } catch (err) {
    // Fallback: use the minimal amount if price fetch fails
    flashLoanAmount = '1';
  }

  const harvestStep: ActionStep = {
    type: 'harvest',
    protocol: 'enso',
    positionAddress: positionAddress,
    token: rewardToken.address,
  };

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

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    tokenIn: flashLoanToken.address,
    amountIn: flashLoanAmount,
    callback: [harvestStep, sellStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}
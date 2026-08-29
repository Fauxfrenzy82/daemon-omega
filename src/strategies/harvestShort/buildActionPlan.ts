// src/strategies/harvestShort/buildActionPlan.ts

import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { executionWallet } from '../../treasury/wallets';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { getEnsoClient } from '../../execution/ensoClient';

const log = createLogger('buildActionPlan');

// ✅ CORRECT: Aave V3 Pool Addresses Provider on Polygon
const AAVE_V3_POOL_ADDRESSES_PROVIDER = '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb';

interface FarmConfig {
  id: string;
  positionAddress: string;
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  protocol: string;
}

/**
 * Builds an action plan for harvesting rewards and selling them immediately.
 * Uses Aave V3 flashloan (not Morpho) to enable the reward token swap.
 */
export async function buildHarvestActionPlan(
  farm: FarmConfig,
  rewardAmount: string,
  flashLoanProvider?: FlashLoanProvider
): Promise<ActionPlan> {
  const { positionAddress, rewardToken, entryToken } = farm;

  // ✅ Use Aave V3 as the flashloan provider (not Morpho)
  const provider = flashLoanProvider || { protocol: 'aave-v3' as const };

  // Minimal flashloan amount (1 wei) - just enough to trigger the callback
  const flashLoanAmount = '1';

  log.info('🪣 Using minimal flashloan (gas only) for harvest', {
    protocol: provider.protocol,
  });

  // ✅ Step 1: Harvest the reward
  const harvestStep: ActionStep = {
    type: 'harvest',
    protocol: 'enso',
    positionAddress: positionAddress,
    token: rewardToken.address,
  };

  // ✅ Step 2: Swap reward token to entry token (USDC)
  const swapStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: rewardToken.address,
    tokenOut: entryToken.address,
    amountIn: { useOutputOfCallAt: 0 },
    slippage: '100',
  };

  // ✅ Flashloan step with Aave V3
  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: provider.protocol, // 'aave-v3'
    tokenIn: entryToken.address,   // Flashloan USDC
    amountIn: flashLoanAmount,     // 1 wei
    primaryAddress: AAVE_V3_POOL_ADDRESSES_PROVIDER,
    callback: [harvestStep, swapStep],
  };

  log.info('✅ Harvest action plan built', {
    positionAddress,
    rewardToken: rewardToken.symbol,
    entryToken: entryToken.symbol,
    flashloanAmount: `${flashLoanAmount} (minimal)`,
    flashloanProtocol: provider.protocol,
    callbackActionCount: 2,
    steps: 'harvest → swap',
  });

  return {
    flashLoanToken: entryToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

/**
 * Alias for compatibility with existing code that expects buildActionPlan.
 */
export const buildActionPlan = buildHarvestActionPlan;
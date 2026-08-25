import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo, TOKENS } from '../../config/tokens';
import { executionWallet } from '../../treasury/wallets';

const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const type = candidate.params.type;

  switch (type) {
    case 'aaveIncentive':
      return buildAaveIncentivePlan(candidate, options);
    case 'quickswapV3':
      return buildQuickSwapV3Plan(candidate, options);
    default:
      throw new Error(`Unknown incentive type: ${type}`);
  }
}

/**
 * Aave V3 incentive plan.
 *
 * Flashloans the asset, deposits it as collateral, borrows the same
 * asset to earn incentive rewards, then repays the flashloan.
 *
 * Steps inside callback:
 *   1. deposit   — deposit flashloan proceeds as Aave collateral
 *   2. borrow    — borrow same asset to earn incentive spread
 *
 * Only adds a swap step if the borrowed asset differs from the
 * flashloan token (they are the same in standard aaveIncentive
 * candidates, so the swap is skipped).
 *
 * IMPORTANT: borrowStep uses type 'borrow' (an Enso-native action),
 * NOT type 'call' with raw ABI-encoded data. Raw calls to external
 * contracts are not supported inside Enso flashloan callbacks.
 */
async function buildAaveIncentivePlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { asset, borrowAmount } = candidate.params;

  const flashLoanToken: TokenInfo = options?.flashLoanToken || asset;
  const flashLoanAmount: string = borrowAmount;

  // Step 1: deposit the flash-borrowed amount into Aave as collateral
  const depositStep: ActionStep = {
    type: 'deposit',
    protocol: 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    primaryAddress: AAVE_POOL,
  };

  // Step 2: borrow the incentive asset using Enso's native borrow action.
  // Do NOT use type 'call' with encodeBorrow() — raw external calls are
  // rejected inside Enso flashloan callbacks.
  const borrowStep: ActionStep = {
    type: 'borrow',
    protocol: 'aave-v3',
    token: asset.address,
    amount: borrowAmount,
    primaryAddress: AAVE_POOL,
  };

  const callback: ActionStep[] = [depositStep, borrowStep];

  // Only swap borrowed asset back if it differs from the flashloan token.
  // When they are the same (standard case), skip the swap — including an
  // unnecessary swap is what previously caused the Enso 422 validation error.
  if (asset.address.toLowerCase() !== flashLoanToken.address.toLowerCase()) {
    const swapStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: asset.address,
      tokenOut: flashLoanToken.address,
      amountIn: { useOutputOfCallAt: 1 }, // output of borrowStep (index 1)
      slippage: '100',
    };
    callback.push(swapStep);
  }

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    // tokenIn/amountIn default to token/amount in ensoBuilder when not set,
    // but set them explicitly here for clarity and to satisfy Enso validation.
    tokenIn: flashLoanToken.address,
    amountIn: flashLoanAmount,
    callback,
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

/**
 * QuickSwap V3 round-trip arbitrage plan.
 * Flash-borrows token0, swaps to token1, swaps back to token0, repays.
 */
async function buildQuickSwapV3Plan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { token0, token1, positionSize } = candidate.params;

  const flashLoanToken: TokenInfo = options?.flashLoanToken || token0;
  const flashLoanAmount: string = ethers.utils
    .parseUnits(
      (positionSize / getTokenPriceUsd(token0)).toFixed(token0.decimals),
      token0.decimals
    )
    .toString();

  // Step 1: swap token0 → token1
  const buyStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: flashLoanToken.address,
    tokenOut: token1.address,
    amountIn: flashLoanAmount,
    slippage: '100',
  };

  // Step 2: swap token1 → token0 to repay flashloan
  const sellStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: token1.address,
    tokenOut: flashLoanToken.address,
    amountIn: { useOutputOfCallAt: 0 }, // output of buyStep (index 0)
    slippage: '100',
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    tokenIn: flashLoanToken.address,
    amountIn: flashLoanAmount,
    callback: [buyStep, sellStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

function getTokenPriceUsd(token: TokenInfo): number {
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    WMATIC: 0.1,
    WETH: 3000,
    WBTC: 60000,
    AAVE: 150,
    QUICK: 0.05,
  };
  return priceMap[token.symbol] ?? 0.01;
}
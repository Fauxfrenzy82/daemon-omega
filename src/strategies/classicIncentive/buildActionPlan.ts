import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';

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
 * Enso flashloan callback sequence:
 *   1. deposit  — flashloaned asset into Aave as collateral
 *                 args: { tokenIn, amountIn, primaryAddress }
 *   2. borrow   — borrow same/different asset to earn incentives
 *                 args: { collateral, tokenOut, amountOut, primaryAddress }
 *
 * The flashloan action args use flashloanToken / flashloanAmount
 * (not tokenIn/amountIn — those are different Enso field names used
 *  by deposit/swap actions).
 */
async function buildAaveIncentivePlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { asset, borrowAmount } = candidate.params;

  const flashLoanToken: TokenInfo = options?.flashLoanToken || asset;
  const flashLoanAmount: string = borrowAmount;

  // Step 1: deposit the flash-borrowed amount into Aave as collateral
  // Enso deposit: args.tokenIn / args.amountIn / args.primaryAddress
  const depositStep: ActionStep = {
    type: 'deposit',
    protocol: 'aave-v3',
    token: flashLoanToken.address,   // becomes args.tokenIn in ensoBuilder
    amount: flashLoanAmount,          // becomes args.amountIn in ensoBuilder
    primaryAddress: AAVE_POOL,
  };

  // Step 2: borrow the incentive asset.
  // Enso borrow: args.collateral / args.tokenOut / args.amountOut / args.primaryAddress
  const borrowStep: ActionStep = {
    type: 'borrow',
    protocol: 'aave-v3',
    collateral: flashLoanToken.address,  // becomes args.collateral in ensoBuilder
    token: asset.address,                // becomes args.tokenOut in ensoBuilder
    amount: borrowAmount,                // becomes args.amountOut in ensoBuilder
    primaryAddress: AAVE_POOL,
  };

  const callback: ActionStep[] = [depositStep, borrowStep];

  // Only swap borrowed asset back if it differs from the flashloan token.
  // When they are the same (standard aaveIncentive case) skip the swap.
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

  // Flashloan action: args.flashloanToken / args.flashloanAmount / args.callback
  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,   // becomes args.flashloanToken in ensoBuilder
    amount: flashLoanAmount,          // becomes args.flashloanAmount in ensoBuilder
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
 * Flash-borrows token0, swaps to token1, swaps back, repays.
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

  const buyStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: flashLoanToken.address,
    tokenOut: token1.address,
    amountIn: flashLoanAmount,
    slippage: '100',
  };

  const sellStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: token1.address,
    tokenOut: flashLoanToken.address,
    amountIn: { useOutputOfCallAt: 0 },
    slippage: '100',
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
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
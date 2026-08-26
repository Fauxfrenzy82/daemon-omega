// src/strategies/classicIncentive/buildActionPlan.ts
import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';

const log = createLogger('buildActionPlan');

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

async function buildAaveIncentivePlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  // FIX: discover now sets asset=collateral, borrowAsset=USDC (separate token).
  // The flashloan is taken in the collateral token, deposited into Aave, then
  // USDC is borrowed against it. If collateral !== flashloan token we add a swap.
  const { asset, borrowAsset, borrowAmount } = candidate.params;

  log.info('BUILDING AAVE INCENTIVE PLAN', {
    collateral: asset.symbol,
    collateralAddress: asset.address,
    borrowAsset: borrowAsset.symbol,
    borrowAssetAddress: borrowAsset.address,
    borrowAmount,
    executionWalletAddress: executionWallet.address,
  });

  const flashLoanToken: TokenInfo = options?.flashLoanToken || asset;

  const LTV_CAPS: Record<string, number> = {
    USDC:   0.78,
    DAI:    0.78,
    WETH:   0.78,
    WMATIC: 0.65,
    WBTC:   0.73,
    AAVE:   0.60,
  };
  const safeLtv = LTV_CAPS[flashLoanToken.symbol] || 0.65;

  const borrowBig = ethers.BigNumber.from(borrowAmount);
  const ltvMultiplier = ethers.BigNumber.from(Math.floor(safeLtv * 10000));
  const flashLoanAmountBig = borrowBig.mul(10000).div(ltvMultiplier);
  const flashLoanAmount: string = flashLoanAmountBig.toString();

  // Step 0: deposit the flashloaned collateral into Aave
  // primaryAddress required on deposit callback steps for aave-v3
  const depositStep: ActionStep = {
    type: 'deposit',
    protocol: 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    primaryAddress: AAVE_POOL,
    onBehalfOf: executionWallet.address,
  };

  log.info('DEPOSIT STEP CREATED', {
    token: flashLoanToken.symbol,
    amount: flashLoanAmount,
    primaryAddress: AAVE_POOL,
    onBehalfOf: executionWallet.address,
  });

  // Step 1: borrow USDC (or borrowAsset) against the deposited collateral
  // FIX: collateral field = what we deposited (flashLoanToken), token = what we borrow (borrowAsset)
  // primaryAddress required on borrow callback steps for aave-v3
  const borrowStep: ActionStep = {
    type: 'borrow',
    protocol: 'aave-v3',
    collateral: flashLoanToken.address,   // what's locked as collateral
    token: borrowAsset.address,            // what we're borrowing
    amount: borrowAmount,
    primaryAddress: AAVE_POOL,
    onBehalfOf: executionWallet.address,
  };

  log.info('BORROW STEP CREATED', {
    collateral: flashLoanToken.symbol,
    borrowToken: borrowAsset.symbol,
    amount: borrowAmount,
    primaryAddress: AAVE_POOL,
    onBehalfOf: executionWallet.address,
  });

  const callback: ActionStep[] = [depositStep, borrowStep];

  // If we borrowed something other than the flashloan token, swap borrowed asset → flashloan token
  // so we can repay the flashloan
  if (borrowAsset.address.toLowerCase() !== flashLoanToken.address.toLowerCase()) {
    const swapStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: borrowAsset.address,
      tokenOut: flashLoanToken.address,
      amountIn: { useOutputOfCallAt: 1 }, // output of the borrow step (index 1)
      slippage: '100',
    };
    callback.push(swapStep);
  }

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    primaryAddress: AAVE_POOL,
    callback,
  };

  log.info('FULL ACTION PLAN CREATED', {
    plan: JSON.stringify({ flashLoanToken, flashLoanAmount, steps: [flashloanStep] }, null, 2),
  });

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

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
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) return 1.0;
  const priceMap: Record<string, number> = {
    WMATIC: 0.1,
    WETH:   3000,
    WBTC:   60000,
    AAVE:   150,
    QUICK:  0.05,
  };
  return priceMap[token.symbol] ?? 0.01;
}
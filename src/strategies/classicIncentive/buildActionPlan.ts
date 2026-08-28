import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';

const log = createLogger('buildActionPlan');

// ✅ CORRECT: Aave V3 Pool Address Provider on Polygon
const AAVE_POOL_ADDRESS_PROVIDER = '0xa97684ecd3b83121b6a219c60a431530d09a731e';

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
  const { asset, borrowAsset, borrowAmount, positionSize } = candidate.params;

  const flashLoanToken: TokenInfo = options?.flashLoanToken || asset;
  const flashLoanProvider = { protocol: 'aave-v3' as const };

  const collateralPriceUsd = getTokenPriceUsd(flashLoanToken);
  const collateralUnits = positionSize / collateralPriceUsd;
  const flashLoanAmount: string = ethers.utils
    .parseUnits(
      collateralUnits.toFixed(flashLoanToken.decimals),
      flashLoanToken.decimals
    )
    .toString();

  log.info('BUILDING AAVE INCENTIVE PLAN', {
    collateral: flashLoanToken.symbol,
    collateralAddress: flashLoanToken.address,
    borrowAsset: borrowAsset.symbol,
    borrowAssetAddress: borrowAsset.address,
    positionSizeUsd: positionSize,
    collateralPriceUsd,
    flashLoanAmount,
    borrowAmount,
    flashLoanProvider: flashLoanProvider.protocol,
    executionWalletAddress: executionWallet.address,
  });

  // ✅ Step 1: Deposit - uses tokenIn/amountIn (NO primaryAddress)
  const depositStep: ActionStep = {
    type: 'deposit',
    protocol: 'aave-v3',
    tokenIn: flashLoanToken.address,
    amountIn: flashLoanAmount,
    onBehalfOf: executionWallet.address,
  };

  log.info('DEPOSIT STEP CREATED', {
    token: flashLoanToken.symbol,
    amount: flashLoanAmount,
    onBehalfOf: executionWallet.address,
  });

  // ✅ Step 2: Borrow - uses tokenIn/tokenOut/amountOut (NO primaryAddress)
  const borrowStep: ActionStep = {
    type: 'borrow',
    protocol: 'aave-v3',
    tokenIn: flashLoanToken.address,
    tokenOut: borrowAsset.address,
    amountOut: borrowAmount,
    onBehalfOf: executionWallet.address,
    interestRateMode: 2,
  };

  log.info('BORROW STEP CREATED', {
    collateral: flashLoanToken.symbol,
    borrowToken: borrowAsset.symbol,
    amount: borrowAmount,
    onBehalfOf: executionWallet.address,
  });

  const callback: ActionStep[] = [depositStep, borrowStep];

  // Step 3: Swap - uses tokenIn/tokenOut/amountIn
  if (borrowAsset.address.toLowerCase() !== flashLoanToken.address.toLowerCase()) {
    const swapStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: borrowAsset.address,
      tokenOut: flashLoanToken.address,
      amountIn: { useOutputOfCallAt: 1 },
      slippage: '100',
    };
    callback.push(swapStep);
  }

  // ✅ Step 4: Flashloan - uses flashloanToken/flashloanAmount (NOT tokenIn/amountIn)
  // primaryAddress is the Pool Address Provider
  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: flashLoanProvider.protocol,
    flashloanToken: flashLoanToken.address,    // ✅ Enso requires this
    flashloanAmount: flashLoanAmount,           // ✅ Enso requires this
    primaryAddress: AAVE_POOL_ADDRESS_PROVIDER,
    callback,
  };

  log.info('FULL ACTION PLAN CREATED', {
    flashLoanProvider: flashLoanProvider.protocol,
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
  const flashLoanProvider = { protocol: 'aave-v3' as const };

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
    protocol: flashLoanProvider.protocol,
    flashloanToken: flashLoanToken.address,
    flashloanAmount: flashLoanAmount,
    primaryAddress: AAVE_POOL_ADDRESS_PROVIDER,
    callback: [buyStep, sellStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}
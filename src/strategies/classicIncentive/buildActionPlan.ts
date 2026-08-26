import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { executionWallet } from '../../treasury/wallets'; // <-- ADDED IMPORT

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
  const { asset, borrowAmount } = candidate.params;

  const flashLoanToken: TokenInfo = options?.flashLoanToken || asset;
  const flashLoanAmount: string = borrowAmount;

  const depositStep: ActionStep = {
    type: 'deposit',
    protocol: 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    primaryAddress: AAVE_POOL,
    onBehalfOf: executionWallet.address, // <-- ADDED
  };

  const borrowStep: ActionStep = {
    type: 'borrow',
    protocol: 'aave-v3',
    collateral: flashLoanToken.address,
    token: asset.address,
    amount: borrowAmount,
    primaryAddress: AAVE_POOL,
    onBehalfOf: executionWallet.address, // <-- ADDED
  };

  const callback: ActionStep[] = [depositStep, borrowStep];

  if (asset.address.toLowerCase() !== flashLoanToken.address.toLowerCase()) {
    const swapStep: ActionStep = {
      type: 'swap',
      protocol: 'enso',
      tokenIn: asset.address,
      tokenOut: flashLoanToken.address,
      amountIn: { useOutputOfCallAt: 1 },
      slippage: '100',
    };
    callback.push(swapStep);
  }

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback,
  };

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
    WETH: 3000,
    WBTC: 60000,
    AAVE: 150,
    QUICK: 0.05,
  };
  return priceMap[token.symbol] ?? 0.01;
}
import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo, TOKENS } from '../../config/tokens';

const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const params = candidate.params;
  const type = params.type;

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

  const flashLoanToken = options?.flashLoanToken || asset;
  const flashLoanAmount = borrowAmount;

  const depositStep: ActionStep = {
    type: 'deposit',
    protocol: 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    primaryAddress: AAVE_POOL,
  };

  const borrowStep: ActionStep = {
    type: 'call',
    protocol: 'custom',
    target: AAVE_POOL,
    data: encodeBorrow(asset.address, borrowAmount),
    useOutput: true,
  };

  const swapStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: asset.address,
    tokenOut: flashLoanToken.address,
    amountIn: { useOutputOfCallAt: 0 },
    slippage: '100',
  };

  // ✅ FIX: Pass tokenIn and amountIn (ensoBuilder will convert to arrays)
  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    tokenIn: flashLoanToken.address,   // ✅ Will be wrapped in array
    amountIn: flashLoanAmount,          // ✅ Will be wrapped in array
    amount: flashLoanAmount,
    callback: [depositStep, borrowStep, swapStep],
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

  const flashLoanToken = options?.flashLoanToken || token0;
  const flashLoanAmount = ethers.utils.parseUnits(
    (positionSize / getTokenPriceUsd(token0)).toString(),
    token0.decimals
  ).toString();

  const swapStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: flashLoanToken.address,
    tokenOut: token1.address,
    amountIn: flashLoanAmount,
    slippage: '100',
  };

  // ✅ FIX: Pass tokenIn and amountIn
  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    tokenIn: flashLoanToken.address,
    amountIn: flashLoanAmount,
    amount: flashLoanAmount,
    callback: [swapStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

function encodeBorrow(asset: string, amount: string): string {
  const iface = new ethers.utils.Interface([
    'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external',
  ]);
  return iface.encodeFunctionData('borrow', [
    asset,
    amount,
    2,
    0,
    ethers.constants.AddressZero,
  ]);
}

function getTokenPriceUsd(token: TokenInfo): number {
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    'WMATIC': 0.1,
    'WETH': 3000,
    'WBTC': 60000,
    'AAVE': 150,
    'QUICK': 0.05,
  };
  return priceMap[token.symbol] || 0.01;
}
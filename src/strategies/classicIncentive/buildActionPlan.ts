import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo, TOKENS } from '../../config/tokens';

const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const QUICKSWAP_ROUTER = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';

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
    case 'sPOL':
      return buildSPOLPlan(candidate, options);
    case 'aaveMerit':
      return buildAaveMeritPlan(candidate, options);
    case 'crossProtocol':
      return buildCrossProtocolPlan(candidate, options);
    default:
      throw new Error(`Unknown incentive type: ${type}`);
  }
}

// ============================================================================
// 1. Aave V3 Incentive Plan
// ============================================================================

async function buildAaveIncentivePlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { asset, borrowAmount, positionSize, nativePriceUsd } = candidate.params;

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

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [depositStep, borrowStep, swapStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

// ============================================================================
// 2. QuickSwap V3 Concentrated Gauge Plan
// ============================================================================

async function buildQuickSwapV3Plan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { token0, token1, fee, positionSize, quote } = candidate.params;

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

  const addLiquidityStep: ActionStep = {
    type: 'call',
    protocol: 'custom',
    target: QUICKSWAP_ROUTER,
    data: encodeMintPosition(token0, token1, fee, flashLoanAmount),
    useOutput: true,
  };

  const stakeStep: ActionStep = {
    type: 'harvest',
    protocol: 'enso',
    positionAddress: QUICKSWAP_ROUTER,
    token: token1.address,
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [swapStep, addLiquidityStep, stakeStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

// ============================================================================
// 3. sPOL Liquid Staking Plan
// ============================================================================

async function buildSPOLPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { positionSize, nativePriceUsd } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || TOKENS.WMATIC;
  const flashLoanAmount = ethers.utils.parseUnits(
    (positionSize / getTokenPriceUsd(TOKENS.WMATIC)).toString(),
    TOKENS.WMATIC.decimals
  ).toString();

  // FIX: Changed from 'polygon' to 'aave-v3' (valid protocol)
  const stakeStep: ActionStep = {
    type: 'deposit',
    protocol: 'aave-v3', // Changed from 'polygon' to 'aave-v3'
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    primaryAddress: '0x...', // sPOL staking contract address
  };

  const addLiquidityStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: flashLoanToken.address,
    tokenOut: TOKENS.USDC.address,
    amountIn: flashLoanAmount,
    slippage: '100',
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [stakeStep, addLiquidityStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

// ============================================================================
// 4. Aave Merit Plan
// ============================================================================

async function buildAaveMeritPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { rewardToken, rewardAmount, rewardValue } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || rewardToken;
  const flashLoanAmount = rewardAmount;

  const claimStep: ActionStep = {
    type: 'harvest',
    protocol: 'enso',
    positionAddress: AAVE_POOL,
    token: rewardToken.address,
  };

  const swapStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: rewardToken.address,
    tokenOut: flashLoanToken.address,
    amountIn: { useOutputOfCallAt: 0 },
    slippage: '100',
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [claimStep, swapStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

// ============================================================================
// 5. Cross-Protocol Arbitrage Plan
// ============================================================================

async function buildCrossProtocolPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { fromProtocol, toProtocol, positionSize, yieldDiff } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || TOKENS.USDC;
  const flashLoanAmount = ethers.utils.parseUnits(
    positionSize.toString(),
    flashLoanToken.decimals
  ).toString();

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
    data: encodeBorrow(flashLoanToken.address, flashLoanAmount),
    useOutput: true,
  };

  const swapStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: flashLoanToken.address,
    tokenOut: flashLoanToken.address,
    amountIn: { useOutputOfCallAt: 0 },
    slippage: '100',
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [depositStep, borrowStep, swapStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

// ============================================================================
// Encoding Helpers
// ============================================================================

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

function encodeMintPosition(token0: TokenInfo, token1: TokenInfo, fee: number, amount: string): string {
  const iface = new ethers.utils.Interface([
    'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external returns (uint256 tokenId)',
  ]);
  return iface.encodeFunctionData('mint', [
    {
      token0: token0.address,
      token1: token1.address,
      fee: fee,
      tickLower: -887220,
      tickUpper: 887220,
      amount0Desired: amount,
      amount1Desired: amount,
      amount0Min: 0,
      amount1Min: 0,
      recipient: ethers.constants.AddressZero,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    },
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
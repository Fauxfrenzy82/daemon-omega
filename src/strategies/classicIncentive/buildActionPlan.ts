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

/**
 * ✅ Aave incentive plan.
 * 
 * This plan:
 * 1. Flashloans USDC (or the asset being borrowed)
 * 2. Deposits the flashloaned amount as collateral
 * 3. Borrows the target asset (which earns incentives)
 * 4. Swaps the borrowed asset back to the flashloan token
 * 
 * The callback repays the flashloan + fee.
 */
async function buildAaveIncentivePlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { asset, borrowAmount } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || asset;
  const flashLoanAmount = borrowAmount;

  // Step 1: Deposit flashloan as collateral into Aave
  const depositStep: ActionStep = {
    type: 'deposit',
    protocol: 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    primaryAddress: AAVE_POOL,
  };

  // Step 2: Borrow asset (to earn incentives)
  // ✅ FIX: Use proper onBehalfOf (not AddressZero)
  const borrowStep: ActionStep = {
    type: 'call',
    protocol: 'custom',
    target: AAVE_POOL,
    data: encodeBorrow(asset.address, borrowAmount, executionWallet.address),
    useOutput: true,
  };

  // Step 3: Swap borrowed asset back to flashloan token
  const swapStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: asset.address,
    tokenOut: flashLoanToken.address,
    amountIn: { useOutputOfCallAt: 0 },
    slippage: '100',
  };

  // ✅ Flashloan step: token is the flashloan asset, no user input required
  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    // ✅ No tokenIn/amountIn here – this is a pure flashloan
    callback: [depositStep, borrowStep, swapStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

/**
 * ✅ QuickSwap round-trip plan.
 * 
 * This plan:
 * 1. Flashloans USDC
 * 2. Swaps USDC → WETH (buy)
 * 3. Swaps WETH → USDC (sell back)
 * 4. Repays flashloan + fee
 * 
 * The profit comes from the arbitrage spread between the two swaps.
 */
async function buildQuickSwapV3Plan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { token0, token1, positionSize, quote, reverseQuote } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || token0;
  const flashLoanAmount = ethers.utils.parseUnits(
    (positionSize / getTokenPriceUsd(token0)).toString(),
    token0.decimals
  ).toString();

  // Step 1: Swap token0 → token1 (buy)
  const buyStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: flashLoanToken.address,
    tokenOut: token1.address,
    amountIn: flashLoanAmount,
    slippage: '100',
  };

  // Step 2: Swap token1 → token0 (sell back to repay)
  const sellStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: token1.address,
    tokenOut: flashLoanToken.address,
    amountIn: { useOutputOfCallAt: 0 }, // Use output of buy step
    slippage: '100',
  };

  // ✅ Flashloan step with both swap steps in callback
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

// ✅ FIX: Proper borrow encoding with correct onBehalfOf
function encodeBorrow(asset: string, amount: string, onBehalfOf: string): string {
  const iface = new ethers.utils.Interface([
    'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external',
  ]);
  return iface.encodeFunctionData('borrow', [
    asset,
    amount,
    2, // Variable interest rate mode
    0, // No referral
    onBehalfOf, // ✅ Valid onBehalfOf address (execution wallet)
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

// Import executionWallet for the onBehalfOf address
import { executionWallet } from '../../treasury/wallets';
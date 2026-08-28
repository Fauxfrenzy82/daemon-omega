import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';

const log = createLogger('buildActionPlan');

// Aave V3 pool on Polygon — used on deposit and borrow callback steps only.
// NOT placed on the flashloan outer step (that caused "Invalid address type").
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

// Morpho Blue contract address on Polygon
// Required as primaryAddress for morpho-markets-v1 flashloans
const MORPHO_BLUE = '0x1bF0c2541F820E775182832f06c0B7Fc27A25f67';

// Morpho is the flashloan provider. It supports WETH, WBTC, USDC on Polygon.
// The flashloan itself comes from Morpho; the collateral actions inside the
// callback still target Aave V3. This sidesteps the Enso aave-v3 flashloan
// schema validation that has been blocking execution.
const MORPHO_FLASHLOAN_PROVIDER: FlashLoanProvider = {
  name: 'Morpho',
  protocol: 'morpho-markets-v1',
};

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

  // Always use Morpho as the flashloan provider unless explicitly overridden.
  const flashLoanProvider = options?.flashLoanProvider || MORPHO_FLASHLOAN_PROVIDER;

  // Calculate flashloan amount from position size in collateral token's decimals.
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

  // Step 0: deposit flashloaned collateral into Aave V3.
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

  // Step 1: borrow USDC against the deposited collateral.
  const borrowStep: ActionStep = {
    type: 'borrow',
    protocol: 'aave-v3',
    collateral: flashLoanToken.address,
    token: borrowAsset.address,
    amount: borrowAmount,
    primaryAddress: AAVE_POOL,
    onBehalfOf: executionWallet.address,
    interestRateMode: 2,
  };

  log.info('BORROW STEP CREATED', {
    collateral: flashLoanToken.symbol,
    borrowToken: borrowAsset.symbol,
    amount: borrowAmount,
    primaryAddress: AAVE_POOL,
    onBehalfOf: executionWallet.address,
  });

  const callback: ActionStep[] = [depositStep, borrowStep];

  // Step 2: swap borrowed USDC back to collateral token to repay Morpho flashloan.
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

  // ✅ FIXED: Morpho flashloan requires primaryAddress (the Morpho Blue contract)
  // Also requires tokenIn and amountIn at the root level for the flashloan action.
  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: flashLoanProvider.protocol,
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    tokenIn: flashLoanToken.address,   // ✅ REQUIRED: Enso flashloan schema
    amountIn: flashLoanAmount,          // ✅ REQUIRED: Enso flashloan schema
    primaryAddress: MORPHO_BLUE,        // ✅ REQUIRED: Morpho Blue contract address
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
  const flashLoanProvider = options?.flashLoanProvider || MORPHO_FLASHLOAN_PROVIDER;

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

  // ✅ FIXED: Morpho flashloan requires primaryAddress
  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: flashLoanProvider.protocol,
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    tokenIn: flashLoanToken.address,   // ✅ REQUIRED: Enso flashloan schema
    amountIn: flashLoanAmount,          // ✅ REQUIRED: Enso flashloan schema
    primaryAddress: MORPHO_BLUE,        // ✅ REQUIRED: Morpho Blue contract address
    callback: [buyStep, sellStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}
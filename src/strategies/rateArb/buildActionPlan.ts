// src/strategies/rateArb/buildActionPlan.ts
import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep, FlashloanProtocol } from '../common/opportunityCandidate';
import { TOKENS } from '../../config/tokens';
import { createLogger } from '../../utils/logger';

const log = createLogger('rateArb-build');

// Morpho Blue Polygon address
const MORPHO_BLUE = '0x6c247b1F6182318877311737BaC0844bAa518F5e';
// Aave V3 Pool Addresses Provider (for flashloan)
const AAVE_POOL_ADDRESSES_PROVIDER = '0xa97684ead0e402dc232d5a977953df7ecbab3cdb';

// ✅ Define protocol constants as literals for type safety
const MORPHO_PROTOCOL = 'morpho-markets-v1' as const;
const AAVE_V3_PROTOCOL = 'aave-v3' as const;
const ENSO_PROTOCOL = 'enso' as const;

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: any }
): Promise<ActionPlan> {
  const params = candidate.params;
  const type = params.type;
  const assetSymbol = params.asset;
  const amountUsd = params.amountUsd;

  // Determine token
  const token = getTokenBySymbol(assetSymbol);
  const flashLoanToken = options?.flashLoanToken || token;
  const flashLoanAmount = ethers.utils.parseUnits(
    amountUsd.toString(),
    flashLoanToken.decimals
  ).toString();

  // Build steps based on type
  let steps: ActionStep[] = [];
  // ✅ FIX: Explicitly type flashloanProtocol as FlashloanProtocol
  let flashloanProtocol: FlashloanProtocol = AAVE_V3_PROTOCOL;
  let primaryAddress = AAVE_POOL_ADDRESSES_PROVIDER;

  if (type === 'morphoBorrowAaveSupply') {
    // Use Morpho flashloan (0% fee)
    flashloanProtocol = MORPHO_PROTOCOL;
    primaryAddress = MORPHO_BLUE;

    // Step 1: Deposit to Aave (using flashloan amount)
    const depositStep: ActionStep = {
      type: 'deposit',
      protocol: AAVE_V3_PROTOCOL,
      tokenIn: flashLoanToken.address,
      amountIn: flashLoanAmount,
      onBehalfOf: '0x1b1a1E836E16172dCa6aa9c30494385f87141638', // executor address
      primaryAddress: AAVE_POOL_ADDRESSES_PROVIDER,
    };

    // Step 2: Borrow from Morpho (collateral = the deposited asset? Actually we need to borrow the same asset)
    // Morpho borrow requires collateral. In a flashloan, we can use the flashloan as collateral? Not directly.
    // This is a simplified simulation – in reality you'd need to provide collateral.
    // For testing, we'll just log that this is a placeholder.
    log.warn('Rate arb buildActionPlan is a placeholder – real implementation requires complex collateral management.');
    // We'll create a dummy step for simulation purposes.
    const borrowStep: ActionStep = {
      type: 'call',
      protocol: 'custom',
      target: MORPHO_BLUE,
      data: '0x', // placeholder
      value: '0',
      useOutput: false,
    };

    const flashloanStep: ActionStep = {
      type: 'flashloan',
      protocol: flashloanProtocol,
      flashloanToken: flashLoanToken.address,
      flashloanAmount: flashLoanAmount,
      primaryAddress,
      callback: [depositStep, borrowStep],
    };
    steps = [flashloanStep];
  } else {
    // Similar for aaveBorrowMorphoSupply
    flashloanProtocol = AAVE_V3_PROTOCOL;
    primaryAddress = AAVE_POOL_ADDRESSES_PROVIDER;
    // Placeholder
    const depositStep: ActionStep = {
      type: 'deposit',
      protocol: MORPHO_PROTOCOL,
      tokenIn: flashLoanToken.address,
      amountIn: flashLoanAmount,
      primaryAddress: MORPHO_BLUE,
    };
    const borrowStep: ActionStep = {
      type: 'call',
      protocol: 'custom',
      target: AAVE_POOL_ADDRESSES_PROVIDER,
      data: '0x',
      value: '0',
      useOutput: false,
    };
    const flashloanStep: ActionStep = {
      type: 'flashloan',
      protocol: flashloanProtocol,
      flashloanToken: flashLoanToken.address,
      flashloanAmount: flashLoanAmount,
      primaryAddress,
      callback: [depositStep, borrowStep],
    };
    steps = [flashloanStep];
  }

  log.info('Rate arbitrage action plan built (placeholder)', {
    type,
    amountUsd,
    asset: assetSymbol,
    flashloanProtocol,
  });

  return {
    flashLoanToken,
    flashLoanAmount,
    steps,
  };
}

function getTokenBySymbol(symbol: string) {
  const map: Record<string, any> = {
    USDC: TOKENS.USDC,
    USDT: TOKENS.USDT,
    WETH: TOKENS.WETH,
    WBTC: TOKENS.WBTC,
    WMATIC: TOKENS.WMATIC,
  };
  if (!map[symbol]) throw new Error(`Unknown token: ${symbol}`);
  return map[symbol];
}
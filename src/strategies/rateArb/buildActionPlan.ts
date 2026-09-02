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
  let flashloanProtocol: FlashloanProtocol = 'aave-v3';
  let primaryAddress = AAVE_POOL_ADDRESSES_PROVIDER;

  if (type === 'morphoBorrowAaveSupply') {
    // Use Morpho flashloan (0% fee)
    flashloanProtocol = 'morpho-markets-v1';
    primaryAddress = MORPHO_BLUE;

    // Step 1: Deposit to Aave (using flashloan amount)
    const depositStep: ActionStep = {
      type: 'deposit',
      protocol: 'aave-v3',
      tokenIn: flashLoanToken.address,
      amountIn: flashLoanAmount,
      onBehalfOf: '0x1b1a1E836E16172dCa6aa9c30494385f87141638',
      primaryAddress: AAVE_POOL_ADDRESSES_PROVIDER,
    };

    // Step 2: Borrow from Morpho (placeholder)
    const borrowStep: ActionStep = {
      type: 'call',
      protocol: 'custom',
      target: MORPHO_BLUE,
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
  } else {
    // aaveBorrowMorphoSupply
    flashloanProtocol = 'aave-v3';
    primaryAddress = AAVE_POOL_ADDRESSES_PROVIDER;
    
    const depositStep: ActionStep = {
      type: 'deposit',
      protocol: 'morpho-markets-v1',
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
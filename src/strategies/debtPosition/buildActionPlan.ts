import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';

// Aave V3 Pool ABI for liquidationCall
const POOL_LIQUIDATION_ABI = [
  'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external',
];

const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

function encodeLiquidationCall(
  collateralAsset: string,
  debtAsset: string,
  user: string,
  debtToCover: string,
  receiveAToken: boolean
): string {
  const iface = new ethers.utils.Interface(POOL_LIQUIDATION_ABI);
  return iface.encodeFunctionData('liquidationCall', [
    collateralAsset,
    debtAsset,
    user,
    debtToCover,
    receiveAToken,
  ]);
}

export async function buildActionPlan(candidate: OpportunityCandidate): Promise<ActionPlan> {
  const { borrower, debtAsset, collateralAsset, debtToCover } = candidate.params;

  const flashLoanToken = debtAsset;
  const flashLoanAmount = debtToCover;

  // Build callback steps:
  // 1. Call liquidationCall (custom call)
  // 2. Sell seized collateral (swap) -> debt asset
  // Flashloan auto-repays

  const liquidationData = encodeLiquidationCall(
    collateralAsset.address,
    debtAsset.address,
    borrower,
    debtToCover,
    false // receiveAToken = false (receive underlying collateral)
  );

  const liquidationStep: ActionStep = {
    type: 'call',
    protocol: 'custom',
    target: AAVE_POOL,
    data: liquidationData,
    value: '0',
    useOutput: true, // Output is the seized collateral amount
  };

  const swapStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: collateralAsset.address,
    tokenOut: debtAsset.address,
    amountIn: { useOutputOfCallAt: 0 }, // Use output of liquidation call
    slippage: '100',
    // Enso route will find best path; no primaryAddress needed
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [liquidationStep, swapStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}
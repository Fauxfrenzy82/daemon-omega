import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';

const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

const POOL_LIQUIDATION_ABI = [
  'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external',
];

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

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { borrower, debtAsset, collateralAsset, debtToCover } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || debtAsset;
  const flashLoanAmount = debtToCover;

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
    useOutput: true,
  };

  const swapStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: collateralAsset.address,
    tokenOut: debtAsset.address,
    amountIn: { useOutputOfCallAt: 0 },
    slippage: '100',
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
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
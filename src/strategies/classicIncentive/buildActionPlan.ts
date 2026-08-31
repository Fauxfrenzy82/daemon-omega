// src/strategies/classicIncentive/buildActionPlan.ts

import { ethers } from 'ethers';
import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';
import { TOKENS } from '../../config/tokens';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { ProtocolConfig, getContractInterface } from './protocolRegistry';

const log = createLogger('buildActionPlan');

const AAVE_V3_POOL_ADDRESSES_PROVIDER = '0xa97684ead0e402dc232d5a977953df7ecbab3cdb';
const DEFAULT_FLASHLOAN_PROTOCOL = 'morpho-markets-v1';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const protocol = candidate.params.protocol as ProtocolConfig;
  const functionName = candidate.params.functionName as string;
  const rewardAmount = candidate.params.rewardAmount as string;
  const rewardToken = candidate.params.rewardToken as TokenInfo;
  const entryToken = candidate.params.entryToken as TokenInfo;

  const flashLoanToken = options?.flashLoanToken || entryToken;
  // ✅ FIX: Removed invalid 'as const'
  const flashLoanProvider = options?.flashLoanProvider || { 
    name: 'Morpho', 
    protocol: DEFAULT_FLASHLOAN_PROTOCOL 
  };

  const flashLoanAmount = '1';

  log.info('🪣 Building harvest action plan (minimal flashloan)', {
    protocol: protocol.id,
    functionName,
    rewardToken: rewardToken.symbol,
    entryToken: entryToken.symbol,
    flashLoanProvider: flashLoanProvider.protocol,
  });

  const harvestStep: ActionStep = {
    type: 'call',
    protocol: 'custom',
    target: protocol.address,
    data: encodeHarvestCall(protocol, functionName),
    value: '0',
    useOutput: true,
  };

  const swapStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: rewardToken.address,
    tokenOut: entryToken.address,
    amountIn: { useOutputOfCallAt: 0 },
    slippage: '100',
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: flashLoanProvider.protocol,
    flashloanToken: flashLoanToken.address,
    flashloanAmount: flashLoanAmount,
    primaryAddress: AAVE_V3_POOL_ADDRESSES_PROVIDER,
    callback: [harvestStep, swapStep],
  };

  log.info('✅ Harvest action plan built', {
    protocol: protocol.id,
    functionName,
    rewardToken: rewardToken.symbol,
    entryToken: entryToken.symbol,
    flashloanProtocol: flashLoanProvider.protocol,
    callbackActionCount: 2,
  });

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}

function encodeHarvestCall(protocol: ProtocolConfig, functionName: string): string {
  const iface = getContractInterface(protocol);
  const fn = protocol.functions.find(f => f.name === functionName);
  
  if (!fn) {
    throw new Error(`Function ${functionName} not found in protocol ${protocol.id}`);
  }

  const executorAddress = executionWallet.address;

  // Generic: try to call with no args
  try {
    return iface.encodeFunctionData(functionName, []);
  } catch {
    try {
      return iface.encodeFunctionData(functionName, [executorAddress]);
    } catch {
      throw new Error(`Cannot encode function ${functionName} for protocol ${protocol.id}`);
    }
  }
}
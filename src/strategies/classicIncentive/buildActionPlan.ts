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

// ✅ CORRECT: Aave V3 Pool Addresses Provider on Polygon
const AAVE_V3_POOL_ADDRESSES_PROVIDER = '0xa97684ead0e402dc232d5a977953df7ecbab3cdb';

// ✅ Use Morpho for 0% flashloan fee
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
  const flashLoanProvider = options?.flashLoanProvider || { 
    name: 'Morpho', 
    protocol: DEFAULT_FLASHLOAN_PROTOCOL as const 
  };

  // Minimal flashloan amount (1 wei) — just enough to trigger the callback
  // The harvest function itself doesn't need flashloan funds; the flashloan
  // is used as a mechanism to bundle multiple actions atomically.
  const flashLoanAmount = '1';

  log.info('🪣 Building harvest action plan (minimal flashloan)', {
    protocol: protocol.id,
    functionName,
    rewardToken: rewardToken.symbol,
    entryToken: entryToken.symbol,
    flashLoanProvider: flashLoanProvider.protocol,
    flashLoanAmount: '1 wei (minimal)',
  });

  // ✅ Step 1: Harvest the reward
  // This calls the protocol's harvest/claim function
  const harvestStep: ActionStep = {
    type: 'call',
    protocol: 'custom',
    target: protocol.address,
    data: encodeHarvestCall(protocol, functionName),
    value: '0',
    useOutput: true,
  };

  // ✅ Step 2: Swap reward token → entry token (USDC)
  const swapStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: rewardToken.address,
    tokenOut: entryToken.address,
    amountIn: { useOutputOfCallAt: 0 },
    slippage: '100',
  };

  // ✅ Step 3: Flashloan with callback
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

  // Special cases for specific protocols  if (protocol.id === 'aave-v3-rewards') {
    // claimAllRewards(address[] assets, address to)
    return iface.encodeFunctionData('claimAllRewards', [[], executorAddress]);
  }

  if (protocol.id === 'balancer-gauge') {
    if (functionName === 'getReward') {
      return iface.encodeFunctionData('getReward', [executorAddress]);
    }
    return iface.encodeFunctionData('claim_rewards', []);
  }

  // Generic: try to call with no args
  try {
    return iface.encodeFunctionData(functionName, []);
  } catch {
    // Try with executor address as arg
    try {
      return iface.encodeFunctionData(functionName, [executorAddress]);
    } catch {
      throw new Error(`Cannot encode function ${functionName} for protocol ${protocol.id}`);
    }
  }
}
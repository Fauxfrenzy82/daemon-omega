// src/strategies/classicIncentive/buildActionPlan.ts

// ... (previous code remains the same until the encodeHarvestCall function)

function encodeHarvestCall(protocol: ProtocolConfig, functionName: string): string {
  const iface = getContractInterface(protocol);
  const fn = protocol.functions.find(f => f.name === functionName);
  
  if (!fn) {
    throw new Error(`Function ${functionName} not found in protocol ${protocol.id}`);
  }

  const executorAddress = executionWallet.address;

  // Special cases for specific protocols
  // The incorrect 'if' statement below is what caused the error. It has been removed.
  // For Aave V3, you would add logic here, but it's skipped (position-based).
  
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
case 'flashloan': {
  // ✅ Enso requires flashloanToken/flashloanAmount
  // Fallback to token/tokenIn/amount/amountIn for backward compatibility
  const flashloanToken = step.flashloanToken || step.token || step.tokenIn;
  const flashloanAmount = step.flashloanAmount || step.amount || step.amountIn;
  
  if (!flashloanToken) throw new Error('Flashloan step missing flashloanToken/token/tokenIn');
  if (!flashloanAmount) throw new Error('Flashloan step missing flashloanAmount/amount/amountIn');
  if (!step.callback || step.callback.length === 0) {
    throw new Error('Flashloan must contain at least one callback action');
  }

  const args: Record<string, any> = {
    flashloanToken: ethers.utils.getAddress(flashloanToken),
    flashloanAmount: flashloanAmount.toString(),
    callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
  };

  if (step.primaryAddress) {
    args.primaryAddress = ethers.utils.getAddress(step.primaryAddress);
  }
  
  if (step.receiver) {
    args.receiver = ethers.utils.getAddress(step.receiver);
  }
  
  if (step.refundReceiver) {
    args.refundReceiver = ethers.utils.getAddress(step.refundReceiver);
  }

  log.info(`FLASHLOAN PARSED - Protocol: ${step.protocol} | Token: ${args.flashloanToken} | Amount: ${args.flashloanAmount}`);

  return {
    protocol: step.protocol,
    action: 'flashloan',
    args,  // ✅ NO extra fields at root level
  };
}
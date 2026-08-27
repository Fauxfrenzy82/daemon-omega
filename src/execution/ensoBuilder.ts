case 'flashloan': {
  if (!step.token) throw new Error('Flashloan step missing token');
  if (!step.amount) throw new Error('Flashloan step missing amount');
  if (!step.callback || step.callback.length === 0) {
    throw new Error('Flashloan must contain at least one callback action');
  }

  // Build args with flashloan-specific parameters
  const args: Record<string, any> = {
    flashloanToken: ethers.utils.getAddress(step.token),
    flashloanAmount: step.amount.toString(),
    callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
  };

  if (step.primaryAddress) {
    args.primaryAddress = ethers.utils.getAddress(step.primaryAddress);
  }

  // Build the action with tokenIn and amountIn at the ROOT level
  const action: any = {
    protocol: step.protocol,
    action: 'flashloan',
    args,
  };

  // tokenIn and amountIn at the root level
  if (step.tokenIn) {
    action.tokenIn = ethers.utils.getAddress(
      Array.isArray(step.tokenIn) ? step.tokenIn[0] : step.tokenIn
    );
    if (step.amountIn === undefined) {
      throw new Error('Flashloan has tokenIn but no matching amountIn');
    }
    action.amountIn = Array.isArray(step.amountIn) ? step.amountIn[0] : step.amountIn;
  }

  if (step.tokenOut) {
    action.tokenOut = Array.isArray(step.tokenOut) ? step.tokenOut[0] : step.tokenOut;
  }

  // ✅ receiver at the root level – EOA or Smart Contract Wallet
  if (step.receiver) {
    action.receiver = ethers.utils.getAddress(step.receiver);
  } else {
    action.receiver = ethers.utils.getAddress(executionWallet.address);
  }

  // ✅ refundReceiver at the root level – EOA or Smart Contract Wallet
  if (step.refundReceiver) {
    action.refundReceiver = ethers.utils.getAddress(step.refundReceiver);
  } else {
    action.refundReceiver = ethers.utils.getAddress(executionWallet.address);
  }

  log.info(`FLASHLOAN PARSED - Protocol: ${step.protocol} | Token: ${args.flashloanToken} | Amount: ${args.flashloanAmount} | Receiver: ${action.receiver}`);

  return action;
}
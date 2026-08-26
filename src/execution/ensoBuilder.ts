case 'flashloan': {
  if (!step.token) throw new Error('Flashloan step missing token');
  if (!step.amount) throw new Error('Flashloan step missing amount');
  if (!step.callback || step.callback.length === 0) {
    throw new Error('Flashloan must contain at least one callback action');
  }

  // FIX: Enso expects plural array keys even for single-token flashloans
  const args: Record<string, any> = {
    flashloanTokens: [step.token],   // Plural + array
    flashloanAmounts: [step.amount], // Plural + array
    callback: step.callback.map(s => convertStepToEnsoAction(s, context)),
  };

  if (step.primaryAddress) args.primaryAddress = step.primaryAddress;
  if (step.receiver) args.receiver = step.receiver;

  log.info('FLASHLOAN STEP CONVERTED', {
    args: JSON.stringify(args, null, 2),
  });

  return {
    protocol: step.protocol,
    action: 'flashloan',
    args,
  };
}
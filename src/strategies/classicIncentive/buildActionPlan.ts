const flashloanStep: ActionStep = {
  type: 'flashloan',
  protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
  token: flashLoanToken.address,
  amount: flashLoanAmount,
  // NO primaryAddress here — this field on the flashloan outer action
  // must be omitted or set to the Enso router, NOT the Aave pool.
  // The Aave pool address belongs only on the deposit and borrow callback steps.
  callback,
};
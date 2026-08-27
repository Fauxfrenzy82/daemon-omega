// In src/execution/processor.ts

export async function processCandidate(candidate: OpportunityCandidate): Promise<void> {
  if (isBreakerTripped()) {
    log.warn('Circuit breaker tripped, skipping', { candidateId: candidate.id });
    return;
  }

  if (!hasExecutionCapacity()) {
    log.debug('Concurrency limit reached, requeueing', { candidateId: candidate.id });
    const { pushCandidate } = await import('./queue');
    pushCandidate(candidate);
    return;
  }

  incrementActiveTrades();

  try {
    const nativePrice = getCachedNativePrice();
    const gasPrice = getCachedGasPrice();
    const liquidityData = getCachedLiquidity();

    // 🔥 FIX: Build action plan WITHOUT overriding flashloan provider
    // Let the strategy's default (Morpho) take effect
    let plan;
    try {
      plan = await buildActionPlanForCandidate(candidate, {
        flashLoanToken: candidate.params.flashLoanToken || candidate.params.asset,
        // 🔥 REMOVED: flashLoanProvider override
        // The default in buildActionPlan.ts (Morpho) will be used
      });
    } catch (err) {
      log.error(`Failed to build action plan for ${candidate.id}`, { error: String(err) });
      return;
    }

    // ... rest of the function
  }
}
// Helper function to get Enso route quote as a standalone function for optimizer use
export async function getEnsoRouteQuote(
  tokenIn: any,
  tokenOut: any,
  amountIn: string
): Promise<any> {
  const result = await ensoRouteSource.getQuote({
    tokenIn,
    tokenOut,
    amountIn,
  });
  return result;
}
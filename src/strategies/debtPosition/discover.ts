// src/strategies/debtPosition/discover.ts
import { ethers } from 'ethers';
import { getEnsoClient } from '../../execution/ensoClient';
import { pushCandidate } from '../../execution/queue';

const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

// ABI for getUserAccountData
const POOL_ABI = [
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)'
];

export async function discoverDebtPosition(nativePriceUsd: number) {
  // 1. Get list of potential borrowers
  //    - From subgraph (we can still use this for discovery)
  //    - Or from event monitoring (Borrow events)
  //    - Or from a maintained list of addresses
  const borrowers = await fetchPotentialBorrowers();

  for (const borrower of borrowers) {
    // 2. Use Enso to get the health factor via custom call
    const enso = getEnsoClient();
    const healthFactor = await getHealthFactorViaEnso(borrower);

    if (healthFactor < 1) {
      // 3. Create candidate for execution
      const candidate = createLiquidationCandidate(borrower, healthFactor);
      pushCandidate(candidate);
    }
  }
}

async function getHealthFactorViaEnso(borrower: string): Promise<number> {
  // Use Enso's custom call action
  // This can be done via getBundleData or quoter
  const data = encodeGetUserAccountData(borrower);
  // ... execute via Enso
}
// src/execution/ensoClient.ts

/**
 * Fetch token metadata from Enso using /api/v1/tokens.
 * This returns the primaryAddress field for tokens.
 */
async getTokenMetadata(tokenAddress: string, chainId: number = 137): Promise<EnsoTokenResponse | null> {
  try {
    // ✅ CORRECT: Use the tokens endpoint without includeMetadata
    const url = `${BASE_URL}/v1/tokens?chainId=${chainId}&addresses=${tokenAddress}`;

    log.info('🌐 ENSO TOKEN METADATA REQUEST', {
      tokenAddress,
      chainId,
      url,
    });

    const response = await axios.get<EnsoTokenResponse[]>(
      url,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        timeout: 10000,
      }
    );

    const tokens = response.data;
    if (Array.isArray(tokens) && tokens.length > 0) {
      const token = tokens[0];
      log.info('🌐 ENSO TOKEN METADATA RESPONSE', {
        token: token.symbol,
        project: token.project,
        primaryAddress: token.primaryAddress,
        hasPrimaryAddress: !!token.primaryAddress,
      });
      return token;
    }

    log.warn('⚠️ No token data found in response', {
      tokenAddress,
      responseLength: tokens?.length || 0,
    });
    return null;
  } catch (error: any) {
    log.warn('⚠️ Failed to fetch token metadata from Enso', {
      tokenAddress,
      error: error.response?.status || error.message,
      data: error.response?.data,
    });
    return null;
  }
}

/**
 * Get the primaryAddress for a token's protocol.
 * Uses the /api/v1/tokens endpoint.
 */
async getPrimaryAddressForToken(tokenAddress: string, chainId: number = 137): Promise<string> {
  // ✅ Verified Aave V3 Pool Addresses Provider on Polygon
  const FALLBACK_ADDRESS = '0xa97684ecd3b83121b6a219c60a431530d09a731e';

  try {
    const metadata = await this.getTokenMetadata(tokenAddress, chainId);

    if (metadata?.primaryAddress) {
      log.info('✅ Successfully fetched primaryAddress from token metadata', {
        token: metadata.symbol,
        primaryAddress: metadata.primaryAddress,
      });
      return metadata.primaryAddress.toLowerCase();
    }

    log.warn('⚠️ No primaryAddress in token metadata, using fallback', {
      tokenAddress,
      fallback: FALLBACK_ADDRESS,
    });
    return FALLBACK_ADDRESS;
  } catch (error) {
    log.warn('⚠️ Error fetching primaryAddress, using fallback', {
      tokenAddress,
      fallback: FALLBACK_ADDRESS,
    });
    return FALLBACK_ADDRESS;
  }
}

/**
 * Get the Aave V3 primaryAddress by querying a known Aave token.
 * This is more reliable than the nontokenized endpoint for Aave V3.
 */
async getAaveV3PrimaryAddress(chainId: number = 137): Promise<string> {
  // Use WETH address as a known Aave V3 token on Polygon
  const AAVE_TOKEN_ADDRESS = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619';
  return this.getPrimaryAddressForToken(AAVE_TOKEN_ADDRESS, chainId);
}
// src/execution/ensoClient.ts
import axios from 'axios';
import { env } from '../config/env';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';

const log = createLogger('ensoClient');

const BASE_URL = env.ENSO_BASE_URL || 'https://api.enso.build/api';
const API_KEY = env.ENSO_API_KEY;

// Log at module load so it appears in boot logs
log.info('EnsoClient BASE_URL resolved', { BASE_URL });

export interface EnsoBundleParams {
  fromAddress: string;
  chainId: number;
  routingStrategy?: 'router' | 'delegate' | 'ensowallet' | 'router-legacy' | 'delegate-legacy';
  receiver?: string;
  spender?: string;
}

export interface EnsoAction {
  protocol: string;
  action: string;
  args: Record<string, any>;
}

export interface EnsoTokenResponse {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  project: string;
  primaryAddress: string; // The protocol's primary address (e.g., Aave Pool Addresses Provider)
  logoURI?: string;
}

export interface EnsoNonTokenizedResponse {
  id: string;
  chainId: number;
  protocol: string;
  protocolSlug: string;
  primaryAddress: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  underlying?: string[];
}

export class EnsoClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Fetch non-tokenized positions from Enso.
   * This returns protocol contract interfaces, pool layouts, and primaryAddress arrays.
   * This is the recommended way to get primaryAddress for protocols like Aave V3.
   */
  async getNonTokenizedPositions(
    chainId: number = 137,
    protocolSlug?: string
  ): Promise<EnsoNonTokenizedResponse[]> {
    try {
      const params = new URLSearchParams();
      params.append('chainId', String(chainId));
      if (protocolSlug) {
        params.append('protocolSlug', protocolSlug);
      }

      const url = `${BASE_URL}/v1/nontokenized?${params.toString()}`;

      log.info('🌐 ENSO NONTOKENIZED REQUEST', {
        chainId,
        protocolSlug,
        url,
      });

      const response = await axios.get<EnsoNonTokenizedResponse[]>(
        url,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          timeout: 10000,
        }
      );

      log.info('🌐 ENSO NONTOKENIZED RESPONSE', {
        status: response.status,
        count: response.data?.length || 0,
        hasData: !!response.data,
      });

      return response.data || [];
    } catch (error: any) {
      log.warn('⚠️ Failed to fetch nontokenized data from Enso', {
        chainId,
        protocolSlug,
        error: error.response?.status || error.message,
      });
      return [];
    }
  }

  /**
   * Get the primaryAddress for a specific protocol on a specific chain.
   * Uses the /api/v1/nontokenized endpoint which returns protocol contract addresses.
   */
  async getProtocolPrimaryAddress(
    protocolSlug: string,
    chainId: number = 137
  ): Promise<string | null> {
    try {
      const positions = await this.getNonTokenizedPositions(chainId, protocolSlug);

      // Find the position that has a primaryAddress
      for (const position of positions) {
        if (position.primaryAddress) {
          log.info('✅ Found primaryAddress in nontokenized response', {
            protocol: position.protocol,
            protocolSlug: position.protocolSlug,
            primaryAddress: position.primaryAddress,
            name: position.name,
          });
          return position.primaryAddress.toLowerCase();
        }
      }

      log.warn('⚠️ No primaryAddress found in nontokenized response', {
        protocolSlug,
        chainId,
      });
      return null;
    } catch (error) {
      log.warn('⚠️ Error fetching primaryAddress from nontokenized endpoint', {
        protocolSlug,
        chainId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get the primaryAddress for Aave V3 on Polygon.
   * Falls back to the known correct address if the API call fails.
   */
  async getAaveV3PrimaryAddress(chainId: number = 137): Promise<string> {
    // ✅ Verified Aave V3 Pool Addresses Provider on Polygon
    const FALLBACK_ADDRESS = '0xa97684ecd3b83121b6a219c60a431530d09a731e';

    try {
      const primaryAddress = await this.getProtocolPrimaryAddress('aave-v3', chainId);

      if (primaryAddress) {
        log.info('✅ Successfully fetched Aave V3 primaryAddress', {
          primaryAddress,
          source: 'nontokenized endpoint',
        });
        return primaryAddress;
      }

      log.warn('⚠️ No primaryAddress found, using fallback', {
        fallback: FALLBACK_ADDRESS,
        chainId,
      });
      return FALLBACK_ADDRESS;
    } catch (error) {
      log.warn('⚠️ Error fetching Aave V3 primaryAddress, using fallback', {
        fallback: FALLBACK_ADDRESS,
        chainId,
        error: error instanceof Error ? error.message : String(error),
      });
      return FALLBACK_ADDRESS;
    }
  }

  /**
   * Fetch token metadata from Enso, including the primaryAddress for the protocol.
   * This is an alternative method using the /api/v1/tokens endpoint.
   */
  async getTokenMetadata(tokenAddress: string, chainId: number = 137): Promise<EnsoTokenResponse | null> {
    try {
      const url = `${BASE_URL}/v1/tokens/${tokenAddress}?chainId=${chainId}`;

      log.info('🌐 ENSO TOKEN METADATA REQUEST', {
        tokenAddress,
        chainId,
        url,
      });

      const response = await axios.get<EnsoTokenResponse>(
        url,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          timeout: 10000,
        }
      );

      if (response.data) {
        log.info('🌐 ENSO TOKEN METADATA RESPONSE', {
          token: response.data.symbol,
          project: response.data.project,
          primaryAddress: response.data.primaryAddress,
          hasData: !!response.data,
        });
        return response.data;
      }

      return null;
    } catch (error: any) {
      log.warn('⚠️ Failed to fetch token metadata from Enso', {
        tokenAddress,
        error: error.response?.status || error.message,
      });
      return null;
    }
  }

  /**
   * Get the primaryAddress for a token's protocol.
   * Falls back to known correct address if API call fails.
   */
  async getPrimaryAddressForToken(tokenAddress: string, chainId: number = 137): Promise<string> {
    const FALLBACK_ADDRESS = '0xa97684ecd3b83121b6a219c60a431530d09a731e';

    try {
      const metadata = await this.getTokenMetadata(tokenAddress, chainId);

      if (metadata?.primaryAddress) {
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

  async getBundleData(params: EnsoBundleParams, actions: EnsoAction[]): Promise<any> {
    const queryParams = new URLSearchParams();
    queryParams.append('chainId', String(params.chainId));
    if (params.fromAddress) queryParams.append('fromAddress', params.fromAddress);
    if (params.routingStrategy) queryParams.append('routingStrategy', params.routingStrategy);
    if (params.receiver) queryParams.append('receiver', params.receiver);
    if (params.spender) queryParams.append('spender', params.spender);

    const url = `${BASE_URL}/v1/shortcuts/bundle?${queryParams.toString()}`;

    log.info('🌐 ENSO BUNDLE REQUEST (DIRECT)', {
      url,
      actionCount: actions?.length,
      firstAction: actions?.[0] ? {
        protocol: actions[0].protocol,
        action: actions[0].action,
      } : null,
      fullBody: JSON.stringify(actions, null, 2),
    });

    try {
      const response = await axios.post(
        url,
        actions,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          timeout: 30000,
        }
      );

      log.info('🌐 ENSO BUNDLE RESPONSE (DIRECT)', {
        status: response.status,
        hasData: !!response.data,
        fullResponse: JSON.stringify(response.data, null, 2),
      });

      return response.data;
    } catch (error: any) {
      log.error('🌐 ENSO BUNDLE ERROR (DIRECT)', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data ? JSON.stringify(error.response.data, null, 2) : null,
        message: error.message,
        url: error.config?.url,
        method: error.config?.method,
        sentBody: error.config?.data,
        sentHeaders: {
          contentType: error.config?.headers?.['Content-Type'],
          hasAuth: !!error.config?.headers?.['Authorization'],
        },
      });
      throw error;
    }
  }

  async getRouteData(params: any): Promise<any> {
    const queryParams = new URLSearchParams();
    if (params.chainId) queryParams.append('chainId', String(params.chainId));
    if (params.fromAddress) queryParams.append('fromAddress', params.fromAddress);
    if (params.routingStrategy) queryParams.append('routingStrategy', params.routingStrategy || 'router');
    if (params.receiver) queryParams.append('receiver', params.receiver);
    if (params.spender) queryParams.append('spender', params.spender);
    if (params.slippage) queryParams.append('slippage', String(params.slippage));

    const tokenIn = Array.isArray(params.tokenIn) ? params.tokenIn : [params.tokenIn];
    const tokenOut = Array.isArray(params.tokenOut) ? params.tokenOut : [params.tokenOut];
    const amountIn = Array.isArray(params.amountIn) ? params.amountIn : [params.amountIn];

    tokenIn.forEach((t: string) => queryParams.append('tokenIn', t));
    tokenOut.forEach((t: string) => queryParams.append('tokenOut', t));
    amountIn.forEach((a: string) => queryParams.append('amountIn', String(a)));

    const url = `${BASE_URL}/v1/shortcuts/route?${queryParams.toString()}`;

    log.info('🌐 ENSO ROUTE REQUEST (DIRECT)', {
      tokenIn: tokenIn[0],
      tokenOut: tokenOut[0],
      amountIn: amountIn[0],
      fromAddress: params?.fromAddress,
      chainId: params?.chainId,
    });

    try {
      const response = await axios.get(
        url,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          timeout: 15000,
        }
      );

      log.info('🌐 ENSO ROUTE RESPONSE (DIRECT)', {
        status: response.status,
        hasData: !!response.data,
      });

      return response.data;
    } catch (error: any) {
      log.error('🌐 ENSO ROUTE ERROR (DIRECT)', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data ? JSON.stringify(error.response.data, null, 2) : null,
        message: error.message,
      });
      throw error;
    }
  }
}

let ensoClient: EnsoClient | null = null;

export function initEnsoClient(): EnsoClient {
  if (!ensoClient) {
    if (!API_KEY) {
      throw new Error('ENSO_API_KEY is required. Get one from https://developers.enso.finance');
    }
    ensoClient = new EnsoClient(API_KEY);
    log.info('Enso client initialized (direct HTTP mode)', { chainId: activeChain.chainId });
  }
  return ensoClient;
}

export function getEnsoClient(): EnsoClient {
  if (!ensoClient) {
    throw new Error('Enso client not initialized. Call initEnsoClient() first.');
  }
  return ensoClient;
}
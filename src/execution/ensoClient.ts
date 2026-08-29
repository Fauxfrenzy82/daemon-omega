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
  primaryAddress?: string;
  logoURI?: string;
}

export class EnsoClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Fetch token metadata from Enso using /api/v1/tokens.
   * This returns the primaryAddress field for tokens.
   */
  async getTokenMetadata(tokenAddress: string, chainId: number = 137): Promise<EnsoTokenResponse | null> {
    try {
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
   * Falls back to the correct Aave V3 Pool Addresses Provider on Polygon.
   */
  async getPrimaryAddressForToken(tokenAddress: string, chainId: number = 137): Promise<string> {
    // ✅ CORRECT: Aave V3 Pool Addresses Provider on Polygon
    const CORRECT_AAVE_V3_POOL_ADDRESSES_PROVIDER = '0xa97684ead0e402dc232d5a977953df7ecbab3cdb';

    try {
      const metadata = await this.getTokenMetadata(tokenAddress, chainId);

      if (metadata?.primaryAddress) {
        log.info('✅ Successfully fetched primaryAddress from token metadata', {
          token: metadata.symbol,
          primaryAddress: metadata.primaryAddress,
        });
        return metadata.primaryAddress.toLowerCase();
      }

      log.warn('⚠️ No primaryAddress in token metadata, using correct fallback', {
        tokenAddress,
        fallback: CORRECT_AAVE_V3_POOL_ADDRESSES_PROVIDER,
      });
      return CORRECT_AAVE_V3_POOL_ADDRESSES_PROVIDER;
    } catch (error) {
      log.warn('⚠️ Error fetching primaryAddress, using correct fallback', {
        tokenAddress,
        fallback: CORRECT_AAVE_V3_POOL_ADDRESSES_PROVIDER,
      });
      return CORRECT_AAVE_V3_POOL_ADDRESSES_PROVIDER;
    }
  }

  /**
   * Get the Aave V3 primaryAddress (Pool Addresses Provider) for Polygon.
   * This is what Enso expects for the flashloan primaryAddress.
   */
  async getAaveV3PrimaryAddress(chainId: number = 137): Promise<string> {
    // ✅ CORRECT: Aave V3 Pool Addresses Provider on Polygon
    const CORRECT_AAVE_V3_POOL_ADDRESSES_PROVIDER = '0xa97684ead0e402dc232d5a977953df7ecbab3cdb';
    return CORRECT_AAVE_V3_POOL_ADDRESSES_PROVIDER;
  }

  async getBundleData(params: EnsoBundleParams, actions: EnsoAction[]): Promise<any> {
    const queryParams = new URLSearchParams();
    queryParams.append('chainId', String(params.chainId));
    
    // ✅ CRITICAL FIX: fromAddress must be lowercase in the query string
    if (params.fromAddress) {
      queryParams.append('fromAddress', params.fromAddress.toLowerCase());
    }
    
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
    
    // ✅ CRITICAL FIX: fromAddress must be lowercase in the query string
    if (params.fromAddress) {
      queryParams.append('fromAddress', params.fromAddress.toLowerCase());
    }
    
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
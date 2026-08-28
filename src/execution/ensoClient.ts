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

export class EnsoClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Fetch token metadata from Enso, including the primaryAddress for the protocol.
   * This is the recommended way to get the correct primaryAddress dynamically.
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

      log.info('🌐 ENSO TOKEN METADATA RESPONSE', {
        token: response.data.symbol,
        project: response.data.project,
        primaryAddress: response.data.primaryAddress,
        hasData: !!response.data,
      });

      return response.data;
    } catch (error: any) {
      log.warn('⚠️ Failed to fetch token metadata from Enso, using fallback', {
        tokenAddress,
        error: error.response?.status || error.message,
      });
      return null;
    }
  }

  /**
   * Get the primaryAddress for a token's protocol (e.g., Aave Pool Addresses Provider).
   * Falls back to known correct address if API call fails.
   */
  async getPrimaryAddressForToken(tokenAddress: string, chainId: number = 137): Promise<string> {
    // Fallback for Polygon Aave V3 Pool Addresses Provider
    const FALLBACK_PRIMARY_ADDRESS = '0xa97684ecd3b83121b6a219c60a431530d09a731e';
    
    try {
      const metadata = await this.getTokenMetadata(tokenAddress, chainId);
      
      if (metadata?.primaryAddress) {
        // Return lowercase to ensure Enso accepts it
        return metadata.primaryAddress.toLowerCase();
      }
      
      log.warn('⚠️ No primaryAddress in token metadata, using fallback', {
        tokenAddress,
        fallback: FALLBACK_PRIMARY_ADDRESS,
      });
      return FALLBACK_PRIMARY_ADDRESS;
    } catch (error) {
      log.warn('⚠️ Error fetching primaryAddress, using fallback', {
        tokenAddress,
        fallback: FALLBACK_PRIMARY_ADDRESS,
      });
      return FALLBACK_PRIMARY_ADDRESS;
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
    // Route API is GET with query params, not POST with body
    const queryParams = new URLSearchParams();
    if (params.chainId) queryParams.append('chainId', String(params.chainId));
    if (params.fromAddress) queryParams.append('fromAddress', params.fromAddress);
    if (params.routingStrategy) queryParams.append('routingStrategy', params.routingStrategy || 'router');
    if (params.receiver) queryParams.append('receiver', params.receiver);
    if (params.spender) queryParams.append('spender', params.spender);
    if (params.slippage) queryParams.append('slippage', String(params.slippage));

    // Handle array params
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
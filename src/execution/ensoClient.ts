import axios from 'axios';
import { env } from '../config/env';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';

const log = createLogger('ensoClient');

// ✅ FIX: Base URL includes /api – already corrected in env.ts
const BASE_URL = env.ENSO_BASE_URL || 'https://api.enso.build/api';
const API_KEY = env.ENSO_API_KEY;

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

export class EnsoClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
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
      });
      throw error;
    }
  }

  async getRouteData(params: any): Promise<any> {
    const payload = { ...params };

    log.info('🌐 ENSO ROUTE REQUEST (DIRECT)', {
      tokenIn: params?.tokenIn?.[0],
      tokenOut: params?.tokenOut?.[0],
      amountIn: params?.amountIn?.[0],
      fromAddress: params?.fromAddress,
      chainId: params?.chainId,
    });

    try {
      const response = await axios.post(
        `${BASE_URL}/v1/shortcuts/route`,
        payload,
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
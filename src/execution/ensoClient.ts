import axios from 'axios';
import { env } from '../config/env';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';

const log = createLogger('ensoClient');

// ✅ Fixed: Base URL now includes /api
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

  /**
   * Bundle API – sends params as query parameters, actions as body.
   * Matches Enso's documented API: POST /api/v1/shortcuts/bundle?chainId=...&fromAddress=...
   */
  async getBundleData(params: EnsoBundleParams, actions: EnsoAction[]): Promise<any> {
    // 🔍 DEBUG: Log the raw params object
    log.info('🔍 BUNDLE PARAMS (RAW)', {
      fromAddress: params.fromAddress,
      chainId: params.chainId,
      routingStrategy: params.routingStrategy,
      receiver: params.receiver,
      spender: params.spender,
      fromAddressType: typeof params.fromAddress,
      fromAddressLength: params.fromAddress?.length,
      fromAddressIsChecksum: params.fromAddress ? /^0x[A-Fa-f0-9]{40}$/.test(params.fromAddress) : false,
    });

    // Build query string from params
    const queryParams = new URLSearchParams();
    queryParams.append('chainId', String(params.chainId));
    if (params.fromAddress) {
      queryParams.append('fromAddress', params.fromAddress);
    } else {
      log.warn('⚠️ fromAddress is missing or empty in bundle params!');
    }
    if (params.routingStrategy) queryParams.append('routingStrategy', params.routingStrategy);
    if (params.receiver) queryParams.append('receiver', params.receiver);
    if (params.spender) queryParams.append('spender', params.spender);

    const url = `${BASE_URL}/v1/shortcuts/bundle?${queryParams.toString()}`;

    // 🔍 DEBUG: Log the full URL and query string
    log.info('🔍 BUNDLE FULL URL', {
      url,
      baseUrl: BASE_URL,
      queryString: queryParams.toString(),
      hasFromAddress: queryParams.has('fromAddress'),
      fromAddressValue: queryParams.get('fromAddress'),
    });

    log.info('🌐 ENSO BUNDLE REQUEST (DIRECT)', {
      url,
      actionCount: actions?.length,
      firstAction: actions?.[0] ? {
        protocol: actions[0].protocol,
        action: actions[0].action,
        hasTokenIn: !!(actions[0] as any).tokenIn,
        hasArgs: !!(actions[0] as any).args,
      } : null,
    });

    // 🔍 DEBUG: Log the request body (actions array)
    log.info('🔍 BUNDLE REQUEST BODY (actions only)', {
      actionsJSON: JSON.stringify(actions, (key, value) => {
        if (typeof value === 'bigint') return value.toString();
        return value;
      }, 2)
    });

    try {
      const response = await axios.post(
        url,
        actions, // ✅ Body is only the actions array
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
        // Include the URL that was called
        url: error.config?.url,
        method: error.config?.method,
      });
      throw error;
    }
  }

  /**
   * Route API – uses POST with body containing all parameters.
   * This works correctly based on the logs (200 responses).
   */
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
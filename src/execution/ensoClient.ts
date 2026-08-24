import { EnsoClient } from '@ensofinance/sdk';
import { env } from '../config/env';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import axios from 'axios';

const log = createLogger('ensoClient');

let ensoClient: EnsoClient | null = null;
let interceptorsAttached = false;

/**
 * Attach diagnostic interceptors to Enso's axios instance.
 */
function attachDiagnosticInterceptors(): void {
  if (interceptorsAttached) return;
  interceptorsAttached = true;
  log.info('Enso client logging enabled');
}

/**
 * Query Enso for the exact schema of Aave V3 flashloan actions.
 * This tells us exactly where tokenIn should be placed.
 */
async function queryEnsoSchema(): Promise<void> {
  try {
    const client = getEnsoClient();
    
    // Attempt to get all available actions
    log.info('🔍 Querying Enso for available actions...');
    
    // Try to get actions by slug
    try {
      const aaveActions = await (client as any).getActionsBySlug?.('aave-v3');
      if (aaveActions) {
        log.info('🔍 AAVE V3 ACTIONS SCHEMA:', {
          actions: JSON.stringify(aaveActions, (key, value) => {
            if (typeof value === 'bigint') return value.toString();
            if (typeof value === 'function') return '[Function]';
            return value;
          }, 2)
        });
      }
    } catch (err) {
      log.warn('Could not fetch actions by slug', { error: String(err) });
    }

    // Try to get action definitions
    try {
      const actions = await (client as any).getActions?.();
      if (actions) {
        log.info('🔍 ALL ACTIONS SCHEMA (truncated):', {
          actionKeys: Array.isArray(actions) ? actions.map((a: any) => a.action).filter(Boolean) : Object.keys(actions),
          aaveV3Found: actions['aave-v3'] ? true : false,
        });
        if (actions['aave-v3']) {
          log.info('🔍 AAVE V3 DETAILS:', {
            schema: JSON.stringify(actions['aave-v3'], (key, value) => {
              if (typeof value === 'bigint') return value.toString();
              if (typeof value === 'function') return '[Function]';
              return value;
            }, 2)
          });
        }
      }
    } catch (err) {
      log.warn('Could not fetch actions', { error: String(err) });
    }

    // Try to get action definition specifically
    try {
      const flashloanDef = await (client as any).getActionDefinition?.('aave-v3', 'flashloan');
      if (flashloanDef) {
        log.info('🔍 AAVE V3 FLASHLOAN DEFINITION:', {
          definition: JSON.stringify(flashloanDef, (key, value) => {
            if (typeof value === 'bigint') return value.toString();
            if (typeof value === 'function') return '[Function]';
            return value;
          }, 2)
        });
      }
    } catch (err) {
      log.warn('Could not fetch flashloan definition', { error: String(err) });
    }

    // Try to get bundle schema
    try {
      const bundleSchema = await (client as any).getBundleSchema?.();
      if (bundleSchema) {
        log.info('🔍 BUNDLE SCHEMA (truncated):', {
          schema: JSON.stringify(bundleSchema, (key, value) => {
            if (typeof value === 'bigint') return value.toString();
            if (typeof value === 'function') return '[Function]';
            if (key === 'properties' || key === 'definitions') {
              // Only show keys, not full nested objects
              return Object.keys(value);
            }
            return value;
          }, 2)
        });
      }
    } catch (err) {
      log.warn('Could not fetch bundle schema', { error: String(err) });
    }

  } catch (err) {
    log.warn('Failed to query Enso schema', { error: String(err) });
  }
}

/**
 * Wrapper around EnsoClient that logs all Enso requests.
 */
class LoggingEnsoClient {
  private client: EnsoClient;

  constructor(client: EnsoClient) {
    this.client = client;
  }

  async getBundleData(params: any, actions: any): Promise<any> {
    try {
      // 🔍 DEBUG: Log the FULL payload being sent to Enso
      const payload = { params, actions };
      
      // Log full payload structure
      log.info('🔍 ENSO BUNDLE PAYLOAD (DEBUG)', {
        payloadJSON: JSON.stringify(payload, (key, value) => {
          if (typeof value === 'bigint') return value.toString();
          if (Array.isArray(value) && value.length > 10) {
            return `[${value.length} items]`;
          }
          return value;
        }, 2)
      });

      // 🔍 Specifically log the flashloan action structure
      if (actions && Array.isArray(actions)) {
        for (let i = 0; i < actions.length; i++) {
          const action = actions[i];
          if (action?.action === 'flashloan') {
            log.info('🔍 FLASHLOAN ACTION STRUCTURE:', {
              index: i,
              protocol: action.protocol,
              action: action.action,
              hasTokenInRoot: !!action.tokenIn,
              hasAmountInRoot: !!action.amountIn,
              tokenInValue: action.tokenIn,
              amountInValue: action.amountIn,
              hasTokenInArgs: !!(action.args?.tokenIn),
              hasAmountInArgs: !!(action.args?.amountIn),
              argsKeys: action.args ? Object.keys(action.args) : [],
              tokenInNested: !!(action.args?.tokenIn),
              amountInNested: !!(action.args?.amountIn),
            });
          }
        }
      }

      log.info('🌐 ENSO BUNDLE REQUEST', {
        actionCount: actions?.length,
        hasParams: !!params,
      });

      const result = await this.client.getBundleData(params, actions);

      log.info('🌐 ENSO BUNDLE RESPONSE', {
        hasTx: !!(result as any)?.tx,
        hasSimulation: !!(result as any)?.simulation,
      });

      return result;
    } catch (error: any) {
      // Log detailed error including the raw payload that was sent
      log.error('🌐 ENSO BUNDLE ERROR', {
        message: error?.message,
        statusCode: error?.statusCode || error?.response?.status,
        responseData: error?.responseData || error?.response?.data,
        // Log the payload that was sent to help debug
        sentPayload: {
          params: params,
          actionCount: actions?.length,
          firstAction: actions?.[0] ? {
            protocol: actions[0].protocol,
            action: actions[0].action,
            hasTokenIn: !!actions[0].tokenIn,
            hasTokenInArgs: !!(actions[0]?.args?.tokenIn),
          } : null,
        }
      });
      throw error;
    }
  }

  async getRouteData(params: any): Promise<any> {
    try {
      log.info('🌐 ENSO ROUTE REQUEST', {
        tokenIn: params?.tokenIn?.[0],
        tokenOut: params?.tokenOut?.[0],
        amountIn: params?.amountIn?.[0],
      });

      const result = await this.client.getRouteData(params);

      log.info('🌐 ENSO ROUTE RESPONSE', {
        hasAmountOut: !!(result as any)?.amountOut,
        hasRoute: !!(result as any)?.route,
      });

      return result;
    } catch (error: any) {
      log.error('🌐 ENSO ROUTE ERROR', {
        message: error?.message,
        statusCode: error?.statusCode || error?.response?.status,
      });
      throw error;
    }
  }

  // Expose the underlying client for schema queries
  getClient(): EnsoClient {
    return this.client;
  }
}

export function initEnsoClient(): EnsoClient {
  if (!ensoClient) {
    if (!env.ENSO_API_KEY) {
      throw new Error(
        'ENSO_API_KEY is required. Get one from https://developers.enso.finance'
      );
    }

    // Create the client
    ensoClient = new EnsoClient({
      apiKey: env.ENSO_API_KEY,
    });

    // Wrap the client for logging
    const wrappedClient = new LoggingEnsoClient(ensoClient);
    (ensoClient as any)._wrapped = wrappedClient;

    log.info('Enso client initialized', { chainId: activeChain.chainId });

    // 🔍 Query Enso for the Aave V3 flashloan schema (non-blocking)
    queryEnsoSchema().catch(err => {
      log.warn('Schema query failed (non-critical)', { error: String(err) });
    });
  }
  return ensoClient;
}

export function getEnsoClient(): EnsoClient {
  if (!ensoClient) {
    throw new Error('Enso client not initialized. Call initEnsoClient() first.');
  }
  // Return the wrapped client if available
  if ((ensoClient as any)._wrapped) {
    return (ensoClient as any)._wrapped as EnsoClient;
  }
  return ensoClient;
}

export function getEnsoClientWrapper(): LoggingEnsoClient {
  const client = getEnsoClient();
  if (!(client as any)._wrapped) {
    return new LoggingEnsoClient(client);
  }
  return (client as any)._wrapped;
}

/**
 * Direct HTTP call to Enso API to test the bundle format.
 * This bypasses the SDK to see what the raw API expects.
 */
export async function testBundleDirectly(actions: any[]): Promise<any> {
  const apiKey = env.ENSO_API_KEY;
  const baseUrl = env.ENSO_BASE_URL || 'https://api.enso.finance';
  
  const payload = {
    chainId: activeChain.chainId,
    fromAddress: '0xA714a014Db24b6b86e3f465be93736E019fCB47A',
    routingStrategy: 'router',
    actions: actions,
  };

  log.info('🔍 DIRECT API TEST - Sending payload:', {
    url: `${baseUrl}/api/v1/bundle`,
    payload: JSON.stringify(payload, (key, value) => {
      if (typeof value === 'bigint') return value.toString();
      return value;
    }, 2)
  });

  try {
    const response = await axios.post(
      `${baseUrl}/api/v1/bundle`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        timeout: 10000,
      }
    );
    log.info('🔍 DIRECT API TEST - Success:', {
      status: response.status,
      data: JSON.stringify(response.data, null, 2)
    });
    return response.data;
  } catch (error: any) {
    log.error('🔍 DIRECT API TEST - Error:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data ? JSON.stringify(error.response.data, null, 2) : null,
      message: error.message,
    });
    throw error;
  }
}
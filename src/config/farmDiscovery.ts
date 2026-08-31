// src/config/farmDiscovery.ts

export async function discoverGammaFarms(): Promise<Record<string, string>> {
  const farms: Record<string, string> = {};
  
  // ✅ Check if API key is set
  const subgraphApiKey = env.SUBGRAPH_API_KEY;
  if (!subgraphApiKey) {
    log.warn('❌ SUBGRAPH_API_KEY is not set!');
    return farms;
  }
  
  const subgraphId = '5AK9Y4tk27ZWrPKvSAUQmffXWyQvjWqyJ2GNEZUWTirU';
  const endpoint = `https://gateway.thegraph.com/api/${subgraphApiKey}/subgraphs/id/${subgraphId}`;
  
  log.info('🔍 Discovering QuickSwap V3 Gamma farms...', { endpoint: endpoint.replace(subgraphApiKey, '***') });

  const currentTimestamp = Math.floor(Date.now() / 1000);
  
  // ✅ SIMPLIFIED QUERY - test if subgraph is reachable
  const testQuery = `
    {
      _meta {
        block {
          number
        }
        deployment
      }
    }
  `;
  
  try {
    log.info('📡 Testing subgraph connection...');
    const testResponse = await axios.post(endpoint, { query: testQuery }, { timeout: 15000 });
    
    if (testResponse.data?.errors) {
      log.error('❌ Subgraph test failed with errors:', {
        errors: JSON.stringify(testResponse.data.errors, null, 2),
      });
      return farms;
    }
    
    log.info('✅ Subgraph connection successful', {
      block: testResponse.data?.data?._meta?.block?.number,
      deployment: testResponse.data?.data?._meta?.deployment,
    });
  } catch (err: any) {
    log.error('❌ Subgraph connection failed:', {
      status: err?.response?.status,
      statusText: err?.response?.statusText,
      data: err?.response?.data ? JSON.stringify(err.response.data) : null,
      message: err?.message,
    });
    return farms;
  }

  // ✅ Now try the actual incentives query
  const query = `
    {
      incentives(
        where: { endTime_gt: "${currentTimestamp}" }
        first: 20
        orderBy: endTime
        orderDirection: asc
      ) {
        id
        rewardToken
        bonusRewardToken
        totalReward
        bonusReward
        startTime
        endTime
        pool {
          id
          token0 {
            id
            symbol
            decimals
          }
          token1 {
            id
            symbol
            decimals
          }
        }
      }
    }
  `;

  try {
    log.info('📡 Querying incentives...');
    const response = await axios.post(endpoint, { query }, { timeout: 15000 });
    
    // ✅ Log the full response for debugging
    if (response.data?.errors) {
      log.error('❌ Subgraph errors:', {
        errors: JSON.stringify(response.data.errors, null, 2),
      });
      return farms;
    }
    
    const incentives = response.data?.data?.incentives || [];
    log.info(`📊 Found ${incentives.length} active incentives in subgraph response`);
    
    // ✅ Log first incentive for debugging
    if (incentives.length > 0) {
      log.info('📊 First incentive sample:', JSON.stringify(incentives[0], null, 2));
    } else {
      log.warn('⚠️ No incentives found in subgraph response');
      log.debug('Full response:', JSON.stringify(response.data, null, 2));
    }

    for (const inc of incentives) {
      if (!inc.pool?.id) continue;
      
      farms[`${inc.pool.token0?.symbol}/${inc.pool.token1?.symbol}`] = inc.pool.id;
      log.debug(`Added Gamma farm: ${inc.pool.token0?.symbol}/${inc.pool.token1?.symbol} -> ${inc.pool.id}`);
    }

  } catch (err: any) {
    log.error('❌ Incentive query failed:', {
      status: err?.response?.status,
      statusText: err?.response?.statusText,
      data: err?.response?.data ? JSON.stringify(err.response.data) : null,
      message: err?.message,
    });
  }

  log.info(`🔍 Discovered ${Object.keys(farms).length} Gamma farms`);
  return farms;
}
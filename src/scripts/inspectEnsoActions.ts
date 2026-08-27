// src/scripts/inspectEnsoActions.ts
import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const ENSO_API_KEY = process.env.ENSO_API_KEY!;
const BASE_URL = 'https://api.enso.build';

async function main() {
  console.log('=== INSPECTING ENSO AAVE-V3 ACTIONS ON POLYGON (chainId: 137) ===\n');

  // 1. Get all supported standards/actions for aave-v3
  try {
    const standardsRes = await axios.get(`${BASE_URL}/api/v1/standards`, {
      params: { chainId: 137 },
      headers: { Authorization: `Bearer ${ENSO_API_KEY}` },
    });

    const aaveStandard = standardsRes.data?.find?.((s: any) =>
      s.slug === 'aave-v3' || s.name?.toLowerCase().includes('aave-v3')
    );

    if (aaveStandard) {
      console.log('=== AAVE-V3 STANDARD ENTRY ===');
      console.log(JSON.stringify(aaveStandard, null, 2));
    } else {
      console.log('=== ALL STANDARDS (aave-v3 not found by direct match) ===');
      console.log(JSON.stringify(standardsRes.data, null, 2));
    }
  } catch (err: any) {
    console.error('Standards endpoint failed:', err.response?.data ?? err.message);
  }

  console.log('\n---\n');

  // 2. Try the actions endpoint
  try {
    const actionsRes = await axios.get(`${BASE_URL}/api/v1/actions`, {
      params: { chainId: 137, protocol: 'aave-v3' },
      headers: { Authorization: `Bearer ${ENSO_API_KEY}` },
    });

    console.log('=== ALL AAVE-V3 ACTIONS ON POLYGON ===');
    console.log(JSON.stringify(actionsRes.data, null, 2));

    const data = Array.isArray(actionsRes.data) ? actionsRes.data : [];

    const flashloan = data.filter((a: any) =>
      JSON.stringify(a).toLowerCase().includes('flash')
    );
    console.log('\n=== FLASHLOAN ACTIONS ===');
    console.log(JSON.stringify(flashloan, null, 2));

    const borrow = data.filter((a: any) =>
      JSON.stringify(a).toLowerCase().includes('borrow')
    );
    console.log('\n=== BORROW ACTIONS ===');
    console.log(JSON.stringify(borrow, null, 2));

    const deposit = data.filter((a: any) =>
      JSON.stringify(a).toLowerCase().includes('deposit')
    );
    console.log('\n=== DEPOSIT ACTIONS ===');
    console.log(JSON.stringify(deposit, null, 2));

  } catch (err: any) {
    console.error('Actions endpoint failed:', err.response?.status, err.response?.data ?? err.message);
  }

  console.log('\n---\n');

  // 3. Try the supported-actions endpoint (alternate path used in docs)
  try {
    const suppRes = await axios.get(`${BASE_URL}/api/v1/shortcuts/supported-actions`, {
      params: { chainId: 137, protocol: 'aave-v3' },
      headers: { Authorization: `Bearer ${ENSO_API_KEY}` },
    });
    console.log('=== SUPPORTED-ACTIONS ENDPOINT ===');
    console.log(JSON.stringify(suppRes.data, null, 2));
  } catch (err: any) {
    console.error('Supported-actions endpoint failed:', err.response?.status, err.response?.data ?? err.message);
  }

  console.log('\n---\n');

  // 4. Send a minimal flashloan-only bundle with NO callback to isolate
  //    whether the flashloan args themselves are the problem.
  //    If this 422s, the field names flashloanToken/flashloanAmount are wrong.
  //    If it succeeds or gives a different error, the issue is in the callback.
  console.log('=== PROBE: minimal flashloan bundle, empty callback ===');
  try {
    const probeRes = await axios.post(
      `${BASE_URL}/api/v1/shortcuts/bundle`,
      [
        {
          protocol: 'aave-v3',
          action: 'flashloan',
          args: {
            flashloanToken: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
            flashloanAmount: '1000000000000000000',
            primaryAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
            callback: [],
          },
        },
      ],
      {
        params: {
          chainId: 137,
          fromAddress: '0xA714a014Db24b6b86e3f465be93736E019fCB47A',
          routingStrategy: 'router',
        },
        headers: {
          Authorization: `Bearer ${ENSO_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('PROBE SUCCESS (unexpected):', JSON.stringify(probeRes.data, null, 2));
  } catch (err: any) {
    console.log('PROBE ERROR (expected):');
    console.log('  status:', err.response?.status);
    console.log('  data:', JSON.stringify(err.response?.data, null, 2));
  }

  console.log('\n---\n');

  // 5. Same probe but with token/amount instead of flashloanToken/flashloanAmount
  //    to test alternate field names
  console.log('=== PROBE: alternate field names (token/amount) ===');
  try {
    const probeRes2 = await axios.post(
      `${BASE_URL}/api/v1/shortcuts/bundle`,
      [
        {
          protocol: 'aave-v3',
          action: 'flashloan',
          args: {
            token: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
            amount: '1000000000000000000',
            primaryAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
            callback: [],
          },
        },
      ],
      {
        params: {
          chainId: 137,
          fromAddress: '0xA714a014Db24b6b86e3f465be93736E019fCB47A',
          routingStrategy: 'router',
        },
        headers: {
          Authorization: `Bearer ${ENSO_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('PROBE2 SUCCESS:', JSON.stringify(probeRes2.data, null, 2));
  } catch (err: any) {
    console.log('PROBE2 ERROR:');
    console.log('  status:', err.response?.status);
    console.log('  data:', JSON.stringify(err.response?.data, null, 2));
  }

  console.log('\n---\n');

  // 6. Probe with deposit-only callback (no borrow) to isolate which callback
  //    step is the actual problem if flashloan args are fine
  console.log('=== PROBE: flashloan + deposit callback only (no borrow) ===');
  try {
    const probeRes3 = await axios.post(
      `${BASE_URL}/api/v1/shortcuts/bundle`,
      [
        {
          protocol: 'aave-v3',
          action: 'flashloan',
          args: {
            flashloanToken: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
            flashloanAmount: '1000000000000000000',
            callback: [
              {
                protocol: 'aave-v3',
                action: 'deposit',
                args: {
                  tokenIn: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
                  amountIn: '1000000000000000000',
                  primaryAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
                  onBehalfOf: '0xA714a014Db24b6b86e3f465be93736E019fCB47A',
                },
              },
            ],
          },
        },
      ],
      {
        params: {
          chainId: 137,
          fromAddress: '0xA714a014Db24b6b86e3f465be93736E019fCB47A',
          routingStrategy: 'router',
        },
        headers: {
          Authorization: `Bearer ${ENSO_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('PROBE3 SUCCESS:', JSON.stringify(probeRes3.data, null, 2));
  } catch (err: any) {
    console.log('PROBE3 ERROR:');
    console.log('  status:', err.response?.status);
    console.log('  data:', JSON.stringify(err.response?.data, null, 2));
  }
}

main().catch(console.error);
'use strict';
/**
 * _simulate.js - Unified Swap Simulation
 * 
 * Combines SDK quotes with math fallback for accurate simulation.
 * Handles all DEX types: DLMM, Whirlpool, CLMM, CPMM
 * 
 * Strategy:
 * 1. Try SDK quote first (most accurate for concentrated liquidity)
 * 2. Fall back to math simulation if SDK fails or unavailable
 */

const { D, normalizeType, shortMint, shortAddr, getSwapDecimals, hasReserves } = require('./_utils');
const sdk = require('./_sdk');
const math = require('./_math');

// ============================================================================
// STATS TRACKING
// ============================================================================

let stats = {
  sdkCalls: 0,
  sdkSuccess: 0,
  mathCalls: 0,
  mathSuccess: 0,
  failures: 0
};

function getStats() {
  return { ...stats };
}

function resetStats() {
  stats = {
    sdkCalls: 0,
    sdkSuccess: 0,
    mathCalls: 0,
    mathSuccess: 0,
    failures: 0
  };
}

// ============================================================================
// SINGLE LEG SIMULATION
// ============================================================================

/**
 * Simulate a single swap leg (one pool)
 * 
 * @param {Object} params
 * @param {Object} params.pool - Pool to simulate
 * @param {string} params.inputMint - Token being swapped in
 * @param {string} params.outputMint - Token expected out
 * @param {string} params.dxAtomic - Input amount in atomic units
 * @param {boolean} params.log - Enable debug logging
 * @returns {Promise<Object>} { ok, dyAtomic, priceImpactPct, feePaid, via, isSdkVerified }
 */
async function simulateLeg({ pool, inputMint, outputMint, dxAtomic, log = false }) {
  const type = normalizeType(pool);
  const dxA = D(dxAtomic);

  if (dxA.lte(0)) {
    return { ok: false, reason: 'zero-input' };
  }

  // Validate pool has the tokens we need
  const hasInput = pool.baseMint === inputMint || pool.quoteMint === inputMint;
  const hasOutput = pool.baseMint === outputMint || pool.quoteMint === outputMint;

  if (!hasInput || !hasOutput) {
    return {
      ok: false,
      reason: 'token-mismatch',
      expected: `${shortMint(inputMint)}→${shortMint(outputMint)}`,
      pool: `${shortMint(pool.baseMint)}/${shortMint(pool.quoteMint)}`
    };
  }

  // Determine swap direction
  const { swapForY } = getSwapDecimals(pool, inputMint);

  // Check what methods are available
  const sdkReady = sdk.isReady && sdk.isReady();
  const sdkAvailable = sdk.getAvailable && sdk.getAvailable();
  const mathAvailable = hasReserves(pool) || math.canSimulateMath(pool);

  // Determine if SDK can handle this pool type
  const canUseSdk = sdkReady && (
    (type === 'dlmm' && sdkAvailable.dlmm) ||
    (type === 'whirlpool' && sdkAvailable.whirlpool) ||
    (type === 'clmm' && sdkAvailable.clmm)
  );

  // Try SDK first for concentrated liquidity pools
  if (canUseSdk) {
    stats.sdkCalls++;

    try {
      const quote = await sdk.quote(pool, inputMint, dxA.toString());

      if (quote && quote.dyAtomic && D(quote.dyAtomic).gt(0)) {
        stats.sdkSuccess++;

        if (log) {
          console.log(`[sim] ${shortMint(inputMint)} → ${shortMint(outputMint)} | ${shortAddr(pool.poolAddress)} | ${quote.via}`);
          console.log(`      dx=${dxA.div(1e9).toFixed(6)} dy=${D(quote.dyAtomic).div(1e6).toFixed(6)} impact=${D(quote.priceImpactPct || 0).toFixed(4)}%`);
        }

        return {
          ok: true,
          dyAtomic: quote.dyAtomic,
          dyHuman: D(quote.dyAtomic).toString(),
          dxHuman: dxA.toString(),
          priceImpactPct: quote.priceImpactPct || '0',
          feePaid: quote.feePaid || '0',
          feeRate: quote.feeRate || pool.fee || '0.003',
          via: quote.via,
          isSdkVerified: true
        };
      }
    } catch (e) {
      if (log) {
        console.log(`[sim] SDK failed for ${shortAddr(pool.poolAddress)}: ${e.message?.slice(0, 50)}`);
      }
    }
  }

  // Fall back to math simulation
  if (mathAvailable) {
    stats.mathCalls++;

    const result = math.simulateMath(pool, inputMint, dxA.toString());

    if (result.ok && D(result.dyAtomic).gt(0)) {
      stats.mathSuccess++;

      if (log) {
        console.log(`[sim] ${shortMint(inputMint)} → ${shortMint(outputMint)} | ${shortAddr(pool.poolAddress)} | ${result.via}`);
        console.log(`      dx=${D(result.dxHuman).toFixed(6)} dy=${D(result.dyHuman).toFixed(6)} impact=${D(result.priceImpactPct).toFixed(4)}%`);
      }

      return {
        ...result,
        isSdkVerified: false
      };
    }

    stats.failures++;
    return result;
  }

  // No simulation method available
  stats.failures++;
  return {
    ok: false,
    reason: `no-simulation-method: type=${type}, sdk=${canUseSdk}, math=${mathAvailable}`,
    poolAddress: pool.poolAddress
  };
}

// ============================================================================
// TRIANGULAR ROUTE SIMULATION
// ============================================================================

/**
 * Simulate a complete triangular route (3 legs)
 * A → B → C → A
 * 
 * @param {Object} params
 * @param {Array} params.pools - Array of 3 pools [poolAB, poolBC, poolCA]
 * @param {string} params.tokenA - Token A mint (start/end)
 * @param {string} params.tokenB - Token B mint (intermediate)
 * @param {string} params.tokenC - Token C mint (USDC typically)
 * @param {string} params.dxAtomic - Input amount of token A in atomic units
 * @param {number} params.maxImpactPct - Max price impact per leg (default 5%)
 * @param {boolean} params.log - Enable debug logging
 * @returns {Promise<Object>} { ok, legs, profitPct, profitAtomic, ... }
 */
async function simulateTriangularRoute({ pools, tokenA, tokenB, tokenC, dxAtomic, maxImpactPct = 5, log = false }) {
  if (!pools || pools.length !== 3) {
    return { ok: false, reason: 'need-3-pools' };
  }

  const [poolAB, poolBC, poolCA] = pools;
  const dxA = D(dxAtomic);

  if (dxA.lte(0)) {
    return { ok: false, reason: 'zero-input' };
  }

  // === LEG 1: A → B ===
  const leg1 = await simulateLeg({
    pool: poolAB,
    inputMint: tokenA,
    outputMint: tokenB,
    dxAtomic: dxA.toString(),
    log
  });

  if (!leg1.ok) {
    return { ok: false, reason: `leg1-failed: ${leg1.reason}`, failedLeg: 1 };
  }

  // Check price impact
  if (D(leg1.priceImpactPct).gt(maxImpactPct)) {
    return { ok: false, reason: `leg1-impact: ${D(leg1.priceImpactPct).toFixed(2)}%`, failedLeg: 1 };
  }

  // === LEG 2: B → C ===
  const leg2 = await simulateLeg({
    pool: poolBC,
    inputMint: tokenB,
    outputMint: tokenC,
    dxAtomic: leg1.dyAtomic,
    log
  });

  if (!leg2.ok) {
    return { ok: false, reason: `leg2-failed: ${leg2.reason}`, failedLeg: 2 };
  }

  if (D(leg2.priceImpactPct).gt(maxImpactPct)) {
    return { ok: false, reason: `leg2-impact: ${D(leg2.priceImpactPct).toFixed(2)}%`, failedLeg: 2 };
  }

  // === LEG 3: C → A ===
  const leg3 = await simulateLeg({
    pool: poolCA,
    inputMint: tokenC,
    outputMint: tokenA,
    dxAtomic: leg2.dyAtomic,
    log
  });

  if (!leg3.ok) {
    return { ok: false, reason: `leg3-failed: ${leg3.reason}`, failedLeg: 3 };
  }

  if (D(leg3.priceImpactPct).gt(maxImpactPct)) {
    return { ok: false, reason: `leg3-impact: ${D(leg3.priceImpactPct).toFixed(2)}%`, failedLeg: 3 };
  }

  // === CALCULATE PROFIT ===
  const outA = D(leg3.dyAtomic).floor();
  const profitA = outA.minus(dxA);
  const profitPct = profitA.div(dxA).mul(100);

  // Sanity check - reject unrealistic profits
  if (!profitPct.isFinite() || profitPct.abs().gt(50)) {
    return {
      ok: false,
      reason: 'unrealistic-profit',
      profitPct: profitPct.toString(),
      legs: [leg1, leg2, leg3]
    };
  }

  // Check if any leg used SDK
  const isSdkVerified = leg1.isSdkVerified || leg2.isSdkVerified || leg3.isSdkVerified;

  return {
    ok: true,
    legs: [leg1, leg2, leg3],
    tokenA,
    tokenB,
    tokenC,
    dxAtomic: dxA.toString(),
    outAtomic: outA.toString(),
    profitAtomic: profitA.toString(),
    profitPct: profitPct.toString(),
    isSdkVerified,
    pools: pools.map(p => p.poolAddress),
    types: pools.map(p => normalizeType(p)),
    vias: [leg1.via, leg2.via, leg3.via]
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  simulateLeg,
  simulateTriangularRoute,
  getStats,
  resetStats
};

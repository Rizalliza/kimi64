'use strict';
/**
 * _engine.js - Triangular Arbitrage Route Discovery
 * 
 * Finds A → B → C → A routes and evaluates profitability.
 * Supports cross-DEX routes: Meteora DLMM, Orca Whirlpool, Raydium CLMM/CPMM
 * 
 * Uses:
 * - _utils.js for helpers
 * - _sdk.js for DEX quotes
 * - _math.js for CPMM calculations
 * - _simulate.js for leg simulation
 */

const { D, normalizeType, normalizeDex, hasReserves, shortMint, shortAddr, TOKENS } = require('./_utils');
const sdk = require('./_sdk');
const { simulateTriangularRoute, getStats: getSimStats, resetStats: resetSimStats } = require('./_simulate');
const { liquidityScore, canSimulateMath } = require('./_math');

// ============================================================================
// POOL FILTERING & INDEXING
// ============================================================================

/**
 * Filter pools that can be used for arbitrage
 * @param {Array} pools - All pools
 * @param {boolean} log - Enable diagnostic logging
 * @returns {Array} Usable pools
 */
function filterUsablePools(pools, log = false) {

  if (!Array.isArray(pools) || pools.length === 0) { if (log) console.warn('[engine] filterUsablePools: no input pools'); return []; }

  const sdkReady = sdk.isReady && sdk.isReady();
  const sdkAvailable = (sdk.getAvailable && sdk.getAvailable()) || { dlmm: false, whirlpool: false, clmm: false };

  const filtered = { dlmm: 0, whirlpool: 0, clmm: 0, cpmm: 0 };
  const reasons = { noReserves: 0, noSdk: 0, invalid: 0 };

  const usable = pools.filter(pool => {
    if (!pool.poolAddress || !pool.baseMint || !pool.quoteMint) {
      reasons.invalid++;
      return false;
    }

    const type = normalizeType(pool);

    // CPMM: needs reserves for math simulation
    if (type === 'cpmm') {
      if (hasReserves(pool)) {
        return true;
      }
      filtered.cpmm++;
      reasons.noReserves++;
      return false;
    }

    // DLMM: SDK preferred, but can fallback to math with reserves
    if (type === 'dlmm') {
      if (sdkReady && sdkAvailable.dlmm) return true;
      if (hasReserves(pool)) return true; // Fallback to CPMM approximation
      filtered.dlmm++;
      reasons.noReserves++;
      return false;
    }

    // Whirlpool: SDK preferred, but can fallback to math with reserves
    if (type === 'whirlpool') {
      if (sdkReady && sdkAvailable.whirlpool) return true;
      if (hasReserves(pool)) return true; // Fallback to CPMM approximation
      filtered.whirlpool++;
      reasons.noSdk++;
      return false;
    }

    // CLMM: SDK preferred, but can fallback to math with reserves
    if (type === 'clmm') {
      if (sdkReady && sdkAvailable.clmm) return true;
      if (hasReserves(pool)) return true; // Fallback to CPMM approximation
      filtered.clmm++;
      reasons.noSdk++;
      return false;
    }

    // Unknown type - allow if has reserves
    if (hasReserves(pool)) return true;

    return false;
  });

  if (log) {
    const totalFiltered = Object.values(filtered).reduce((a, b) => a + b, 0);
    if (totalFiltered > 0) {
      console.log(`[engine] Pools filtered out: ${totalFiltered}`);
      console.log(`[engine]   By type: ${JSON.stringify(filtered)}`);
      console.log(`[engine]   Reasons: noReserves=${reasons.noReserves}, noSdk=${reasons.noSdk}, invalid=${reasons.invalid}`);
    }
  }
  return usable;
}

/**
 * Build pair index for fast lookup
 * @param {Array} pools 
 * @returns {Map<string, Array>}
 */
function buildPairIndex(pools) {
  const index = new Map();

  for (const pool of pools) {
    const base = pool.baseMint;
    const quote = pool.quoteMint;

    // Index both directions
    const key1 = `${base}|${quote}`;
    const key2 = `${quote}|${base}`;

    if (!index.has(key1)) index.set(key1, []);
    if (!index.has(key2)) index.set(key2, []);

    index.get(key1).push(pool);
    index.get(key2).push(pool);
  }

  return index;
}

/**
 * Pick best pools by liquidity score
 * @param {Array} pools 
 * @param {number} limit 
 * @returns {Array}
 */
function pickBestPools(pools, limit = 5) {
  if (!pools || pools.length === 0) return [];
  if (pools.length <= limit) return pools;

  const scored = pools.map(p => ({
    pool: p,
    score: liquidityScore(p)
  }));

  scored.sort((a, b) => b.score.cmp(a.score));

  return scored.slice(0, limit).map(s => s.pool);
}

// ============================================================================
// ROUTE DISCOVERY
// ============================================================================

/**
 * Find B candidates (intermediate tokens)
 * @param {Array} pools - Usable pools
 * @param {Set} tokenASet - Token A mints
 * @param {string} tokenC - Token C mint
 * @returns {Set<string>}
 */
function findBCandidates(pools, tokenASet, tokenC) {
  const bCandidates = new Set();

  for (const pool of pools) {
    const base = pool.baseMint;
    const quote = pool.quoteMint;

    const hasA = tokenASet.has(base) || tokenASet.has(quote);
    const hasC = base === tokenC || quote === tokenC;

    // Pool connects A to something else (potential B)
    if (hasA && !hasC) {
      const other = tokenASet.has(base) ? quote : base;
      if (other !== tokenC && !tokenASet.has(other)) {
        bCandidates.add(other);
      }
    }
  }

  return bCandidates;
}

/**
 * Diagnostic: analyze pool data for routing issues
 */
function diagnosePoolData(pools, tokenA, tokenC, log = false) {
  if (!log) return;

  console.log(`\n[engine] === POOL DIAGNOSIS ===`);

  // Count by type
  const byType = {};
  const byDex = {};

  for (const p of pools) {
    const type = normalizeType(p);
    const dex = normalizeDex(p);
    byType[type] = (byType[type] || 0) + 1;
    byDex[dex] = (byDex[dex] || 0) + 1;
  }

  console.log(`[engine] By type: ${JSON.stringify(byType)}`);
  console.log(`[engine] By DEX: ${JSON.stringify(byDex)}`);

  // Check SOL/USDC presence by type
  const solPools = { dlmm: 0, whirlpool: 0, clmm: 0, cpmm: 0 };
  const usdcPools = { dlmm: 0, whirlpool: 0, clmm: 0, cpmm: 0 };

  for (const p of pools) {
    const type = normalizeType(p);
    const hasSol = p.baseMint === tokenA || p.quoteMint === tokenA;
    const hasUsdc = p.baseMint === tokenC || p.quoteMint === tokenC;

    if (hasSol) solPools[type] = (solPools[type] || 0) + 1;
    if (hasUsdc) usdcPools[type] = (usdcPools[type] || 0) + 1;
  }

  console.log(`[engine] SOL pools: ${JSON.stringify(solPools)}`);
  console.log(`[engine] USDC pools: ${JSON.stringify(usdcPools)}`);

  // Check for potential cross-DEX routes
  const solUsdcDirect = pools.filter(p =>
    (p.baseMint === tokenA && p.quoteMint === tokenC) ||
    (p.quoteMint === tokenA && p.baseMint === tokenC)
  );

  console.log(`[engine] Direct SOL/USDC pools: ${solUsdcDirect.length}`);
  if (solUsdcDirect.length > 0) {
    const directByDex = {};
    for (const p of solUsdcDirect) {
      const dex = normalizeDex(p);
      directByDex[dex] = (directByDex[dex] || 0) + 1;
    }
    console.log(`[engine] SOL/USDC by DEX: ${JSON.stringify(directByDex)}`);
  }

  console.log(`[engine] === END DIAGNOSIS ===\n`);
}

/**
 * Find triangular arbitrage routes
 * 
 * @param {Object} params
 * @param {Array} params.pools - Pool array
 * @param {string} params.tokenA - Start/end token (e.g., SOL)
 * @param {string} params.tokenC - Middle token (e.g., USDC)
 * @param {string} params.dxAtomic - Input amount in atomic units
 * @param {number} params.poolsPerLeg - Max pools to try per leg
 * @param {number} params.maxRoutes - Max routes to return
 * @param {number} params.maxImpactPct - Max price impact per leg
 * @param {boolean} params.logRoutes - Log route discovery
 * @param {boolean} params.logLegs - Log individual leg simulations
 * @returns {Promise<Array>} Sorted routes by profitability
 */
async function findTriangularRoutes({
  pools,
  tokenA = TOKENS.SOL,
  tokenC = TOKENS.USDC,
  dxAtomic,
  poolsPerLeg = 5,
  maxRoutes = 100,
  maxImpactPct = 5,
  logRoutes = false,
  logLegs = false
} = {}) {

  const stats = {
    attempted: 0,
    simFailed: 0,
    impactSkip: 0,
    duplicates: 0
  };

  // Reset simulation stats and start timer
  const startTime = Date.now();
  resetSimStats();



  // Filter usable pools
  const usable = filterUsablePools(pools, logRoutes);
  if (logRoutes) {
    const inputCount = Array.isArray(pools) ? pools.length : 0;
    console.log(`[engine] Input pools: ${inputCount}`);
    console.log(`[engine] Usable pools: ${usable.length}`);

    const typeCount = {}; for (const p of usable) { const t = normalizeType(p); typeCount[t] = (typeCount[t] || 0) + 1; }
    console.log(`[engine] Types: ${JSON.stringify(typeCount)}`);

    diagnosePoolData(usable, tokenA, tokenC, true);
  }

  if (logRoutes) {
    console.log(`[engine] Input pools: ${pools.length}`);
    console.log(`[engine] Usable pools: ${usable.length}`);

    // Type breakdown
    const typeCount = {};
    for (const p of usable) {
      const t = normalizeType(p);
      typeCount[t] = (typeCount[t] || 0) + 1;
    }
    console.log(`[engine] Types: ${JSON.stringify(typeCount)}`);

    // Diagnose pool data
    diagnosePoolData(usable, tokenA, tokenC, true);
  }

  if (usable.length === 0) {
    console.warn('[engine] No usable pools');
    return [];
  }

  // Build index
  const pairIndex = buildPairIndex(usable);

  // Token sets
  const tokenASet = new Set([tokenA]);

  // Find B candidates
  const bCandidates = findBCandidates(usable, tokenASet, tokenC);

  if (logRoutes) {
    console.log(`[engine] B candidates: ${bCandidates.size}`);
    if (bCandidates.size <= 20) {
      const bList = Array.from(bCandidates).map(m => shortMint(m)).join(', ');
      console.log(`[engine] B tokens: ${bList}`);
    }
  }

  if (bCandidates.size === 0) {
    console.warn('[engine] No B candidates found');
    return [];
  }

  // Find routes
  const routes = [];
  const seenRouteKeys = new Set();

  for (const tokenB of bCandidates) {
    if (routes.length >= maxRoutes) break;

    // Get pools for each leg
    const poolsAB = [
      ...(pairIndex.get(`${tokenA}|${tokenB}`) || []),
    ];

    const poolsBC = [
      ...(pairIndex.get(`${tokenB}|${tokenC}`) || []),
    ];

    const poolsCA = [
      ...(pairIndex.get(`${tokenC}|${tokenA}`) || []),
    ];

    // Skip if any leg is missing
    if (!poolsAB.length || !poolsBC.length || !poolsCA.length) {
      continue;
    }

    // Pick best pools per leg
    const capAB = pickBestPools(poolsAB, poolsPerLeg);
    const capBC = pickBestPools(poolsBC, poolsPerLeg);
    const capCA = pickBestPools(poolsCA, poolsPerLeg);

    // Try all combinations
    for (const pAB of capAB) {
      if (routes.length >= maxRoutes) break;

      for (const pBC of capBC) {
        if (routes.length >= maxRoutes) break;

        for (const pCA of capCA) {
          if (routes.length >= maxRoutes) break;

          // Deduplication
          const routeKey = [pAB.poolAddress, pBC.poolAddress, pCA.poolAddress].sort().join('|');
          if (seenRouteKeys.has(routeKey)) {
            stats.duplicates++;
            continue;
          }
          seenRouteKeys.add(routeKey);

          stats.attempted++;

          // Simulate route
          const result = await simulateTriangularRoute({
            pools: [pAB, pBC, pCA],
            tokenA,
            tokenB,
            tokenC,
            dxAtomic,
            maxImpactPct,
            log: logLegs
          });

          if (!result.ok) {
            if (result.reason?.includes('impact')) {
              stats.impactSkip++;
            } else {
              stats.simFailed++;
            }
            continue;
          }

          // Add route metadata
          routes.push({
            ...result,
            dexes: [normalizeDex(pAB), normalizeDex(pBC), normalizeDex(pCA)]
          });
        }
      }
    }
  }
}


async function topFlashloanCandidates() {
  // Sort by profit (descending)
  routes.sort((a, b) => D(b.profitPct).cmp(D(a.profitPct)));

  // Log stats
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const simStats = getSimStats();

  if (logRoutes) {
    console.log(`[engine] Stats:`);
    console.log(`  Time: ${elapsed}s`);
    console.log(`  Routes attempted: ${stats.attempted}`);
    console.log(`  Duplicates skipped: ${stats.duplicates}`);
    console.log(`  Sim failures: ${stats.simFailed}`);
    console.log(`  Impact skips: ${stats.impactSkip}`);
    console.log(`  Routes found: ${routes.length}`);
    console.log(`  SDK calls: ${simStats.sdkCalls}, success: ${simStats.sdkSuccess}`);
    console.log(`  Math calls: ${simStats.mathCalls}, success: ${simStats.mathSuccess}`);

    // Top routes
    console.log(`[engine] Top ${Math.min(10, routes.length)} routes:`);
    for (const r of routes.slice(0, 10)) {
      const sdkMark = r.isSdkVerified ? '✔' : '⚠️';
      console.log(`  ${D(r.profitPct).toFixed(4)}% | ${r.dexes.join('→')} ${sdkMark}`);
    }
  }

  return routes;
}




// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  findTriangularRoutes,
  topFlashloanCandidates,
  filterUsablePools,
  buildPairIndex,
  pickBestPools,
  findBCandidates,
  diagnosePoolData
};

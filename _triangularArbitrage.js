'use strict';

/**
 * Clean Triangular Arbitrage Engine
 * Built from scratch to diagnose routing issues
 * 
 * Focuses on:
 * 1. Clear pool selection logic (no mysterious filtering)
 * 2. Multi-DEX route support
 * 3. Transparent simulation results
 */

const { D, normalizeType, normalizeDex, shortMint, shortAddr, TOKENS, hasReserves } = require('./_utils');
const sdk = require('./_sdk');
const math = require('./_math');

// ============================================================================
// POOL UTILITIES
// ============================================================================

function isPoolUsable(pool) {
  if (!pool.poolAddress || !pool.baseMint || !pool.quoteMint) {
    return { ok: false, reason: 'missing-basic-fields' };
  }

  const type = normalizeType(pool);

  // All pool types need reserves
  if (!hasReserves(pool)) {
    return { ok: false, reason: `no-reserves[${type}]` };
  }

  return { ok: true };
}

function getPoolKey(pool) {
  const base = pool.baseMint.toLowerCase();
  const quote = pool.quoteMint.toLowerCase();
  return base < quote ? `${base}|${quote}` : `${quote}|${base}`;
}

function findPoolsForPair(pools, tokenMintA, tokenMintB) {
  const aLower = tokenMintA.toLowerCase();
  const bLower = tokenMintB.toLowerCase();

  return pools.filter(p => {
    const base = p.baseMint.toLowerCase();
    const quote = p.quoteMint.toLowerCase();

    return (base === aLower && quote === bLower) ||
      (base === bLower && quote === aLower);
  });
}

// ============================================================================
// SINGLE LEG SIMULATION
// ============================================================================

async function simulateSwapLeg(pool, inputMint, outputMint, inputAmount) {
  const type = normalizeType(pool);
  const inputAtomic = D(inputAmount);

  if (inputAtomic.lte(0)) {
    return { ok: false, reason: 'zero-input', type };
  }

  // Verify pool has the tokens
  const base = pool.baseMint.toLowerCase();
  const quote = pool.quoteMint.toLowerCase();
  const inLower = inputMint.toLowerCase();
  const outLower = outputMint.toLowerCase();

  const hasIn = base === inLower || quote === inLower;
  const hasOut = base === outLower || quote === outLower;

  if (!hasIn || !hasOut) {
    return {
      ok: false,
      reason: 'token-mismatch',
      pool: `${shortMint(pool.baseMint)}/${shortMint(pool.quoteMint)}`,
      expected: `${shortMint(inputMint)}→${shortMint(outputMint)}`,
      type
    };
  }

  const swapForY = quote === inLower;

  // Skip SDK - use math simulation only (SDK returns broken quotes)
  // TODO: Fix SDK implementation before re-enabling

  // Fallback to math simulation
  if (hasReserves(pool)) {
    try {
      // Force CPMM for DLMM/CLMM (they need SDKs for exact sim)
      let result;
      if (type === 'dlmm' || type === 'clmm') {
        result = math.simulateCpmm(pool, inputMint, inputAtomic.toString());
      } else {
        result = math.simulateMath(pool, inputMint, inputAtomic.toString());
      }

      if (result && result.ok && D(result.dyAtomic).gt(0)) {
        return {
          ok: true,
          dyAtomic: result.dyAtomic,
          priceImpactPct: result.priceImpactPct || '0',
          feePaid: result.feePaid || '0',
          via: `math-${type}`,
          isSdk: false,
          type
        };
      }

      if (result && !result.ok) {
        return result;
      }
    } catch (e) {
      return { ok: false, reason: `error: ${e.message.slice(0, 30)}`, type };
    }
  }

  return {
    ok: false,
    reason: `no-reserves[${type}]`,
    type
  };
}

// ============================================================================
// TRIANGULAR ROUTE SIMULATION
// ============================================================================

async function simulateTriangularArbitrage(leg1Pool, leg2Pool, leg3Pool, tokenA, tokenB, tokenC, inputAtomic) {
  const input = D(inputAtomic);
  const dex1 = normalizeDex(leg1Pool);
  const dex2 = normalizeDex(leg2Pool);
  const dex3 = normalizeDex(leg3Pool);
  const type1 = normalizeType(leg1Pool);
  const type2 = normalizeType(leg2Pool);
  const type3 = normalizeType(leg3Pool);

  // LEG 1: A → B
  const leg1Result = await simulateSwapLeg(leg1Pool, tokenA, tokenB, input.toString());
  if (!leg1Result.ok) {
    return { ok: false, reason: `leg1-failed: ${leg1Result.reason}` };
  }

  // LEG 2: B → C
  const leg2Result = await simulateSwapLeg(leg2Pool, tokenB, tokenC, leg1Result.dyAtomic);
  if (!leg2Result.ok) {
    return { ok: false, reason: `leg2-failed: ${leg2Result.reason}` };
  }

  // LEG 3: C → A
  const leg3Result = await simulateSwapLeg(leg3Pool, tokenC, tokenA, leg2Result.dyAtomic);
  if (!leg3Result.ok) {
    return { ok: false, reason: `leg3-failed: ${leg3Result.reason}` };
  }

  // Calculate profit
  const outputA = D(leg3Result.dyAtomic);
  const profitAtomic = outputA.minus(input);
  const profitPct = profitAtomic.div(input).mul(100);

  return {
    ok: true,
    input: input.toString(),
    output: outputA.toString(),
    profitAtomic: profitAtomic.toString(),
    profitPct: profitPct.toString(),
    legs: [
      { token: tokenA, to: tokenB, amount: input.toString(), result: leg1Result },
      { token: tokenB, to: tokenC, amount: leg1Result.dyAtomic, result: leg2Result },
      { token: tokenC, to: tokenA, amount: leg2Result.dyAtomic, result: leg3Result }
    ],
    route: {
      dexes: [dex1, dex2, dex3],
      types: [type1, type2, type3],
      pools: [leg1Pool.poolAddress, leg2Pool.poolAddress, leg3Pool.poolAddress]
    },
    verificationMethods: [leg1Result.isSdk ? 'sdk' : 'math', leg2Result.isSdk ? 'sdk' : 'math', leg3Result.isSdk ? 'sdk' : 'math']
  };
}

// ============================================================================
// ROUTE DISCOVERY
// ============================================================================

async function findArbitrageRoutes(pools, inputAtomic, options = {}) {
  const tokenA = options.tokenA || TOKENS.SOL;
  const tokenC = options.tokenC || TOKENS.USDC;
  const maxImpactPct = options.maxImpactPct || 5;
  const maxRoutes = options.maxRoutes || 100;
  const logVerbose = options.logVerbose !== false;

  console.log(`\n🔍 Triangular Arbitrage Finder`);
  console.log(`   Input: ${D(inputAtomic).div(1e9).toFixed(4)} SOL`);
  console.log(`   Start/End token: ${shortMint(tokenA)}`);
  console.log(`   Intermediate token: ${shortMint(tokenC)}`);

  // ========== STEP 1: Filter usable pools ==========
  const usable = [];
  const filterStats = {};

  for (const pool of pools) {
    const check = isPoolUsable(pool);
    if (check.ok) {
      usable.push(pool);
    } else {
      filterStats[check.reason] = (filterStats[check.reason] || 0) + 1;
    }
  }

  console.log(`\n✅ Pool filtering:`);
  console.log(`   Total: ${pools.length}`);
  console.log(`   Usable: ${usable.length}`);
  if (Object.keys(filterStats).length > 0) {
    console.log(`   Rejected:`);
    for (const [reason, count] of Object.entries(filterStats)) {
      console.log(`     ${reason}: ${count}`);
    }
  }

  // Type breakdown
  const typeCount = {};
  for (const p of usable) {
    const t = normalizeType(p);
    typeCount[t] = (typeCount[t] || 0) + 1;
  }
  console.log(`   By type: ${JSON.stringify(typeCount)}`);

  // ========== STEP 2: Find intermediate token candidates ==========
  const bCandidates = new Set();

  for (const pool of usable) {
    const base = pool.baseMint.toLowerCase();
    const quote = pool.quoteMint.toLowerCase();
    const aLower = tokenA.toLowerCase();
    const cLower = tokenC.toLowerCase();

    const hasA = base === aLower || quote === aLower;
    const hasC = base === cLower || quote === cLower;

    if (hasA && !hasC) {
      const other = base === aLower ? quote : base;
      if (other !== aLower && other !== cLower) {
        bCandidates.add(other);
      }
    }
  }

  console.log(`\n🔄 Intermediate token candidates (B): ${bCandidates.size}`);
  if (bCandidates.size > 0 && bCandidates.size <= 20) {
    console.log(`   ${Array.from(bCandidates).map(m => shortMint(m)).join(', ')}`);
  }

  if (bCandidates.size === 0) {
    console.log(`❌ No intermediate tokens found! Cannot form triangular routes.`);
    return [];
  }

  // ========== STEP 3: Find routes ==========
  const routes = [];
  let routesAttempted = 0;
  let routesFailed = 0;
  let impactSkipped = 0;
  const seenCombos = new Set();

  console.log(`\n🔗 Testing routes...`);

  for (const tokenB of bCandidates) {
    if (routes.length >= maxRoutes) break;

    // Find pools for each leg
    const poolsAB = findPoolsForPair(usable, tokenA, tokenB);
    const poolsBC = findPoolsForPair(usable, tokenB, tokenC);
    const poolsCA = findPoolsForPair(usable, tokenC, tokenA);

    if (poolsAB.length === 0 || poolsBC.length === 0 || poolsCA.length === 0) {
      continue;
    }

    // Limit pools per leg to avoid explosion
    const limit = 3;
    const pAB = poolsAB.slice(0, limit);
    const pBC = poolsBC.slice(0, limit);
    const pCA = poolsCA.slice(0, limit);

    // Try combinations
    for (const legA of pAB) {
      for (const legB of pBC) {
        for (const legC of pCA) {
          if (routes.length >= maxRoutes) break;

          // Dedup
          const key = [legA.poolAddress, legB.poolAddress, legC.poolAddress].sort().join('|');
          if (seenCombos.has(key)) continue;
          seenCombos.add(key);

          routesAttempted++;

          // Simulate
          const result = await simulateTriangularArbitrage(
            legA, legB, legC,
            tokenA, tokenB, tokenC,
            inputAtomic
          );

          if (!result.ok) {
            routesFailed++;
            if (logVerbose && routesFailed <= 3) {
              console.log(`   ✗ Route failed: ${result.reason}`);
            }
            continue;
          }

          // Check impact
          const maxImpact = Math.max(
            ...result.legs.map(l => D(l.result.priceImpactPct || 0).toNumber())
          );
          if (maxImpact > maxImpactPct) {
            impactSkipped++;
            continue;
          }

          routes.push(result);
        }
      }
    }
  }

  // ========== STEP 4: Sort and return ==========
  routes.sort((a, b) => D(b.profitPct).cmp(D(a.profitPct)));

  console.log(`\n📊 Results:`);
  console.log(`   Routes attempted: ${routesAttempted}`);
  console.log(`   Routes failed: ${routesFailed}`);
  console.log(`   Impact skipped: ${impactSkipped}`);
  console.log(`   Routes found: ${routes.length}`);

  if (routes.length > 0) {
    console.log(`\n🏆 Top routes:`);
    for (let i = 0; i < Math.min(10, routes.length); i++) {
      const r = routes[i];
      const dexStr = r.route.dexes.join('→');
      const methods = r.verificationMethods.map(m => m === 'sdk' ? '✅' : '⚠️').join('');
      console.log(`   ${i + 1}. ${D(r.profitPct).toFixed(4)}% | ${dexStr} | ${methods}`);
    }
  }

  return routes;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  findArbitrageRoutes,
  simulateTriangularArbitrage,
  simulateSwapLeg,
  isPoolUsable,
  findPoolsForPair
};

// node _triangularArbitrage.js pools_meta.json

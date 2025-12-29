'use strict';
/**
 * _poolFetcher.js - Pool Data Filtering & Normalization
 * 
 * Features:
 * - Filter pools by token pairs (SOL + USDC)
 * - Minimum liquidity threshold filtering
 * - Deduplication by DEX + poolType
 * - Normalize to canonical pool shape
 * - Extract enriched pool data
 */

const { D, normalizeType, normalizeDex } = require('./_utils');

const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

function getLiquidity(pool) {
  if (typeof pool.liquidity === 'number' && pool.liquidity > 0) {
    return D(pool.liquidity);
  }

  const reserves = getReserves(pool);
  if (reserves.x.gt(0) && reserves.y.gt(0)) {
    const decimalsBase = getDecimals(pool).base || 0;
    const decimalsQuote = getDecimals(pool).quote || 0;
    const x = reserves.x.div(Math.pow(10, decimalsBase));
    const y = reserves.y.div(Math.pow(10, decimalsQuote));
    return x.mul(y).sqrt();
  }

  return D(0);
}

function getDecimals(pool) {
  let base = 0;
  let quote = 0;

  if (typeof pool.baseDecimals === 'number') base = pool.baseDecimals;
  else if (pool.baseDecimals?.decimals) base = pool.baseDecimals.decimals;
  else if (typeof pool.decimalsX === 'number') base = pool.decimalsX;

  if (typeof pool.quoteDecimals === 'number') quote = pool.quoteDecimals;
  else if (pool.quoteDecimals?.decimals) quote = pool.quoteDecimals.decimals;
  else if (typeof pool.decimalsY === 'number') quote = pool.decimalsY;

  return { base, quote };
}

function getReserves(pool) {
  let x = D(0);
  let y = D(0);

  if (pool.xReserve) x = D(pool.xReserve);
  if (pool.yReserve) y = D(pool.yReserve);

  return { x, y };
}

function hasSOLPair(pool) {
  const base = pool.baseMint;
  const quote = pool.quoteMint;

  const hasSOL = base === TOKENS.SOL || quote === TOKENS.SOL;

  return hasSOL;
}
function hasUSDCPair(pool) {
  const base = pool.baseMint;
  const quote = pool.quoteMint;


  const hasUSDC = base === TOKENS.USDC || quote === TOKENS.USDC;

  return hasUSDC;
}

function meetsLiquidityThreshold(pool, minLpUsdc) {
  if (!minLpUsdc || minLpUsdc <= 0) return true;

  const lp = getLiquidity(pool);
  return lp.gte(D(minLpUsdc));
}

/**
 * Normalize pool to canonical shape
 * @param {Object} pool - Raw pool data
 * @returns {Object} Normalized pool
 */
function toCanonicalShape(pool) {
  const decimals = getDecimals(pool);
  const reserves = getReserves(pool);

  return {
    poolAddress: pool.poolAddress || pool.address,
    dex: normalizeDex(pool),
    type: normalizeType(pool),
    baseMint: pool.baseMint || pool.mint_x,
    quoteMint: pool.quoteMint || pool.mint_y,
    baseDecimals: decimals.base,
    quoteDecimals: decimals.quote,
    feeBps: pool.feeBps || (typeof pool.fee === 'number' ? pool.fee * 10000 : 25),
    slippageBps: pool.slippageBps || 10,
    vaults: {
      xVault: pool.vaults?.xVault || null,
      yVault: pool.vaults?.yVault || null
    }
  };
}

/**
 * Normalize pool to enriched shape (with reserves & computed fields)
 * @param {Object} pool - Raw pool data
 * @returns {Object} Enriched pool
 */
function toEnrichedShape(pool) {
  const canonical = toCanonicalShape(pool);
  const reserves = getReserves(pool);

  return {
    ...canonical,
    xReserve: reserves.x.toString(),
    yReserve: reserves.y.toString(),
    liquidity: getLiquidity(pool).toString(),
    reserveSource: pool.reserveSource || 'computed',
    updatedAtMs: pool.updatedAtMs || Date.now(),

    dlmm: pool.dlmm ? {
      binStep: pool.dlmm.binStep,
      activeId: pool.dlmm.activeId
    } : undefined,

    clmm: pool.clmm ? {
      sqrtPriceX64: pool.clmm.sqrtPriceX64,
      liquidity: pool.clmm.liquidity,
      currentTick: pool.clmm.currentTick,
      tickArrays: pool.clmm.tickArrays
    } : undefined
  };
}

/**
 * Filter pools by criteria
 * @param {Array} pools - Pool array
 * @param {Object} options
 * @param {number} options.minLpUsdc - Minimum liquidity in USDC
 * @param {boolean} options.solOrUsdcOnly - Only pools containing SOL or USDC (OR logic)
 * @param {boolean} options.deduplicateByDexType - Remove duplicates by DEX + type
 * @param {boolean} options.log - Enable logging
 * @returns {Object} { pools, stats }
 */
function filterPools(pools, {
  minLpUsdc = 0,
  solOrUsdcOnly = true,
  deduplicateByDexType = true,
  log = false
} = {}) {
  const stats = {
    input: pools.length,
    noTokenPair: 0,
    lowLiquidity: 0,
    duplicate: 0,
    output: 0
  };

  const filtered = [];
  const seenDexType = new Set();

  for (const pool of pools) {
    if (!pool.poolAddress && !pool.address) continue;

    if (solOrUsdcOnly && !hasSOLPair(pool) && !hasUSDCPair(pool)) {
      stats.noTokenPair++;
      continue;
    }

    if (minLpUsdc > 0 && !meetsLiquidityThreshold(pool, minLpUsdc)) {
      stats.lowLiquidity++;
      continue;
    }

    if (deduplicateByDexType) {
      const dex = normalizeDex(pool);
      const type = normalizeType(pool);
      const key = `${dex}|${type}`;

      if (seenDexType.has(key)) {
        stats.duplicate++;
        continue;
      }
      seenDexType.add(key);
    }

    filtered.push(pool);
    stats.output++;
  }

  if (log) {
    console.log(`[poolFetcher] Input: ${stats.input}`);
    console.log(`[poolFetcher] Filtered out:`);
    console.log(`  No SOL or USDC: ${stats.noTokenPair}`);
    console.log(`  Low liquidity: ${stats.lowLiquidity}`);
    console.log(`  Duplicates (DEX+type): ${stats.duplicate}`);
    console.log(`[poolFetcher] Output: ${stats.output}`);
  }

  return { pools: filtered, stats };
}

/**
 * Process pools and return in requested format
 * @param {Array} rawPools - Raw pool data
 * @param {Object} options
 * @param {string} options.format - 'canonical' or 'enriched'
 * @param {number} options.minLpUsdc - Minimum liquidity
 * @param {boolean} options.solOrUsdcOnly - Filter for SOL or USDC pools
 * @param {boolean} options.log - Enable logging
 * @returns {Array} Normalized and filtered pools
 */
function processPools(rawPools, {
  format = 'enriched',
  minLpUsdc = 0,
  solOrUsdcOnly = true,
  log = false
} = {}) {
  const { pools: filtered, stats } = filterPools(rawPools, {
    minLpUsdc,
    solOrUsdcOnly,
    deduplicateByDexType: true,
    log
  });

  const normalizer = format === 'canonical' ? toCanonicalShape : toEnrichedShape;

  return filtered.map(normalizer);
}

module.exports = {
  toCanonicalShape,
  toEnrichedShape,
  filterPools,
  processPools,
  hasUSDCPair,
  hasSOLPair,
  meetsLiquidityThreshold,
  getLiquidity,
  getDecimals,
  getReserves,
  TOKENS
};

// node _poolFetcher.js pools_meta.json output=pools_metaEnriched.json --sol. --usdc
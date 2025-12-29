'use strict';

/**
 * sdkAdapter.js - STREAMLINED VERSION
 * 
 * Single-call-only pattern - NO cascading fallbacks, NO retries
 * Designed for Solana's 400ms block time
 */

const { PublicKey } = require('@solana/web3.js');


// ============================================================================
// CONFIGURATION - Tuned for speed
// ============================================================================
const RATE_LIMIT_CONFIG = {
  minDelayMs: 50,            // 50ms between requests (20 req/sec max)
  maxRetries: 0,             // NO retries - single call only
  logLevel: 'error'          // 'none', 'error', 'warn', 'info'
};

// ============================================================================
// SIMPLE RATE LIMITER
// ============================================================================
let lastRequestTime = 0;
let stats = { total: 0, success: 0, failed: 0 };

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  const wait = Math.max(0, RATE_LIMIT_CONFIG.minDelayMs - elapsed);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
  stats.total++;
}

function getStats() {
  return {
    ...stats,
    successRate: stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) + '%' : 'N/A'
  };
}

function resetStats() {
  stats = { total: 0, success: 0, failed: 0 };
}

// ============================================================================
// POOL CACHE
// ============================================================================
const poolCache = new Map();
const POOL_CACHE_TTL = 60000; // 60 seconds

function getCachedPool(address) {
  const cached = poolCache.get(address);
  if (cached && Date.now() - cached.ts < POOL_CACHE_TTL) {
    return cached.pool;
  }
  return null;
}

function setCachedPool(address, pool) {
  poolCache.set(address, pool, { ts: Date.now() });
}

function clearCache() {
  poolCache.clear();
}

// ============================================================================
// LAZY SDK LOADING
// ============================================================================
const loadMeteora = require('@meteora-ag/dlmm');
let DLMM = null;
let BN = null;
let sdkReady = false;

try {
  const mod = require('@meteora-ag/dlmm');
  DLMM = mod?.DLMM ?? mod?.default ?? mod;
  BN = require('bn.js');
  sdkReady = !!DLMM && typeof DLMM.create === 'function';
  if (sdkReady) console.log('[sdk] Meteora DLMM loaded');
} catch (e) {
  console.warn('[sdk] Meteora DLMM not available');
}

// ============================================================================
// SINGLE-CALL QUOTE FUNCTIONS
// ============================================================================

/**
 * Quote DLMM swap - SINGLE CALL ONLY
 */
const MeteoraKit = require('./utils/meteoraKit.js');

async function quoteMeteora(connection, pool, inputMint, dxAtomic) {

  if (!sdkReady) return null;

  await rateLimit();

  try {
    // Use cached pool if available
    let dlmmPool = getCachedPool(pool.poolAddress);
    if (!dlmmPool) {
      dlmmPool = await DLMM.create(connection, new PublicKey(pool.poolAddress));
      setCachedPool(pool.poolAddress, dlmmPool);
    }

    const swapForY = (inputMint === pool.baseMint);
    const binArrays = await dlmmPool.getBinArrayForSwap(swapForY);
    const slippage = new BN(pool.slippageBps || 10);

    const quote = await dlmmPool.quoteMeteoraSwap(
      new BN(dxAtomic.toString()),
      swapForY,
      slippage,
      binArrays,
      false
    );

    stats.success++;

    return {
      dyAtomic: quote.outAmount.toString(),
      feePaidAtomic: quote.fee?.toString() || '0',
      priceImpactPct: quote.priceImpactPct?.toString() || '0',
      outDecimals: swapForY ? pool.quoteDecimals : pool.baseDecimals
    };
  } catch (e) {
    stats.failed++;
    if (RATE_LIMIT_CONFIG.logLevel !== 'none') {
      console.warn(`[sdk] DLMM quote failed ${pool.poolAddress?.slice(0, 8)}: ${e.message?.slice(0, 40)}`);
    }
    return null;
  }
}
let WhirlpoolSDK = null;
let whirlpoolReady = false;

try {
  WhirlpoolSDK = require('@orca-so/whirlpools-sdk');
  whirlpoolReady = !!WhirlpoolSDK && typeof WhirlpoolSDK.buildWhirlpoolClient === 'function';
  if (whirlpoolReady) console.log('[sdk] Orca Whirlpool loaded');
} catch (e) {
  console.warn('[sdk] Orca Whirlpool not available');
}

/**
 * Quote Orca Whirlpool - SINGLE CALL ONLY
 */
async function quoteWhirlpool(connection, pool, inputMint, dxAtomic) {
  if (!whirlpoolReady || !WhirlpoolSDK) return null;

  await rateLimit();

  try {
    const { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken } = WhirlpoolSDK;
    const { Percentage } = require('@orca-so/common-sdk');
    const BN = require('bn.js');

    const dummyWallet = {
      publicKey: new PublicKey('11111111111111111111111111111111'),
      signTransaction: async tx => tx,
      signAllTransactions: async txs => txs
    };

    const ctx = WhirlpoolContext.from(connection, dummyWallet, WhirlpoolSDK.ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);
    const whirlpool = await client.getPool(new PublicKey(pool.poolAddress));

    const slippage = Percentage.fromFraction(pool.slippageBps || 10, 10000);
    const quote = await swapQuoteByInputToken(
      whirlpool,
      new PublicKey(inputMint),
      new BN(dxAtomic.toString()),
      slippage,
      ctx.program.programId,
      ctx.fetcher
    );

    stats.success++;

    return {
      dyAtomic: quote.estimatedAmountOut.toString(),
      feePaidAtomic: '0',
      priceImpactPct: '0'
    };
  } catch (e) {
    stats.failed++;
    if (RATE_LIMIT_CONFIG.logLevel !== 'none') {
      console.warn(`[sdk] Whirlpool quote failed ${pool.poolAddress?.slice(0, 8)}: ${e.message?.slice(0, 40)}`);
    }
    return null;
  }
}


let RaydiumSDK = null;
let raydiumReady = false;

try {
  RaydiumSDK = require('@raydium-io/raydium-sdk-v2');
  raydiumReady = !!RaydiumSDK && typeof RaydiumSDK.Raydium === 'function';
  if (raydiumReady) console.log('[sdk] Raydium CLMM loaded');
} catch (e) {
  console.warn('[sdk] Raydium CLMM not available');
}

/**
 * Quote Raydium CLMM - SINGLE CALL ONLY
 */
async function quoteClmm(connection, pool, inputMint, dxAtomic) {
  if (!raydiumReady || !RaydiumSDK) return null;

  await rateLimit();

  try {
    const { Raydium } = RaydiumSDK;

    const raydium = await Raydium.load({
      connection,
      cluster: 'mainnet',
      disableFeatureCheck: true
    });

    const poolInfo = await raydium.clmm.getPoolInfoFromRpc(pool.poolAddress);
    if (!poolInfo) {
      stats.failed++;
      return null;
    }

    const slippage = (pool.slippageBps || 10) / 10000;
    const result = await raydium.clmm.computeAmountOut({
      poolInfo,
      amountIn: dxAtomic.toString(),
      tokenIn: new PublicKey(inputMint),
      slippage
    });

    const outAmt = result?.minAmountOut || result?.amountOut;
    if (!outAmt) {
      stats.failed++;
      return null;
    }

    stats.success++;
    return {
      dyAtomic: outAmt.toString(),
      feePaidAtomic: '0',
      priceImpactPct: result?.priceImpact?.toString() || '0'
    };
  } catch (e) {
    stats.failed++;
    if (RATE_LIMIT_CONFIG.logLevel !== 'none') {
      console.warn(`[sdk] CLMM quote failed ${pool.poolAddress?.slice(0, 8)}: ${e.message?.slice(0, 40)}`);
    }
    return null;
  }
}
/**
 * UNIFIED QUOTE - Routes to correct SDK based on pool type
 * SINGLE CALL - No fallbacks, no retries
 */
async function quoteExactIn(connection, pool, inputMint, outputMint, dxAtomic) {
  const type = (pool.type || '').toLowerCase();

  if (type === 'dlmm') {
    return await quoteMeteora(connection, pool, inputMint, dxAtomic);
  }

  if (type === 'whirlpool') {
    return await quoteWhirlpool(connection, pool, inputMint, dxAtomic);
  }

  if (type === 'clmm') {
    return await quoteClmm(connection, pool, inputMint, dxAtomic);
  }

  return null;
}
// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  MeteoraKit,
  quoteExactIn,
  quoteMeteora,
  quoteWhirlpool,
  quoteClmm,
  getStats,
  resetStats,
  clearCache,
  isReady: () => sdkReady,
  RATE_LIMIT_CONFIG
};

'use strict';
/**
 * _sdk.js - Unified SDK Interface (Swiss Army Knife)
 * 
 * Single interface for all DEX interactions:
 * - Meteora DLMM
 * - Orca Whirlpool  
 * - Raydium CLMM
 * - Raydium CPMM (math-only, no SDK needed)
 */

const { PublicKey } = require('@solana/web3.js');
const { D, normalizeType, sleep, getSwapDecimals } = require('./_utils');
const sdk = require('./_sdkAdapter');

// ============================================================================
// MODULE STATE
// ============================================================================
let connection = null;
let initialized = false;

// SDK modules (lazy loaded)
let DLMM = null;
let BN = null;
let WhirlpoolSDK = null;
let RaydiumSDK = null;

// Availability flags
const available = {
  dlmm: false,
  whirlpool: false,
  clmm: false
};

// Stats tracking
const stats = {
  calls: { dlmm: 0, whirlpool: 0, clmm: 0 },
  success: { dlmm: 0, whirlpool: 0, clmm: 0 },
  errors: { dlmm: 0, whirlpool: 0, clmm: 0 },
  lastError: null
};

// Rate limiting
const rateLimiter = {
  lastCall: 0,
  minDelay: 50,
  backoffUntil: 0,
  consecutive429s: 0
};

// Pool cache (reduces RPC calls)
const poolCache = new Map();
const CACHE_TTL = 30000;

// ============================================================================
// RATE LIMITING HELPERS
// ============================================================================
async function waitForRateLimit() {
  const now = Date.now();

  // Check backoff
  if (rateLimiter.backoffUntil > now) {
    await sleep(rateLimiter.backoffUntil - now);
  }

  // Min delay between calls
  const elapsed = now - rateLimiter.lastCall;
  if (elapsed < rateLimiter.minDelay) {
    await sleep(rateLimiter.minDelay - elapsed);
  }

  rateLimiter.lastCall = Date.now();
}

function handle429() {
  rateLimiter.consecutive429s++;
  const backoff = Math.min(60000, 250 * Math.pow(2, Math.min(10, rateLimiter.consecutive429s)));
  rateLimiter.backoffUntil = Date.now() + backoff;
  console.warn(`[sdk] Rate limited. Backing off ${backoff}ms`);
}

function handleSuccess() {
  rateLimiter.consecutive429s = 0;
}

// ============================================================================
// POOL CACHE HELPERS
// ============================================================================
function getCachedPool(address) {
  const entry = poolCache.get(address);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    poolCache.delete(address);
    return null;
  }
  return entry.pool;
}

function setCachedPool(address, pool) {
  if (!address || !pool) return;
  poolCache.set(address, { pool, ts: Date.now() });
}

function clearCache() {
  poolCache.clear();
}

// ============================================================================
// INITIALIZATION
// ============================================================================
async function initialize(conn) {
  if (!conn) throw new Error('Connection required');
  connection = conn;

  console.log('[sdk] Initializing unified SDK...');

  // Try to load Meteora DLMM
  try {
    const dlmmModule = require('@meteora-ag/dlmm');
    DLMM = dlmmModule.DLMM || dlmmModule.default || dlmmModule;
    BN = require('bn.js');

    if (DLMM && typeof DLMM.create === 'function') {
      available.dlmm = true;
      console.log('[sdk] ✓ Meteora DLMM loaded');
    }
  } catch (e) {
    console.log('[sdk] ✗ Meteora DLMM not available:', e.message);
  }

  // Try to load Orca Whirlpool
  try {
    WhirlpoolSDK = require('@orca-so/whirlpools-sdk');

    if (WhirlpoolSDK && WhirlpoolSDK.buildWhirlpoolClient) {
      available.whirlpool = true;
      console.log('[sdk] ✓ Orca Whirlpool loaded');
    }
  } catch (e) {
    console.log('[sdk] ✗ Orca Whirlpool not available:', e.message);
  }

  // Try to load Raydium SDK
  try {
    RaydiumSDK = require('@raydium-io/raydium-sdk-v2'); '@orca-so/whirlpools-sdk'

    if (RaydiumSDK && RaydiumSDK.Raydium) {
      available.clmm = true;
      console.log('[sdk] ✓ Raydium CLMM loaded');
    } else {
      console.log('[sdk] ⚠ Raydium SDK loaded but CLMM class not found');
    }
  } catch (e) {
    console.log('[sdk] ✗ Raydium CLMM not available:', e.message);
  }

  initialized = true;

  const availableList = Object.entries(available)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ') || 'none';

  console.log(`[sdk] Initialized. Available: ${availableList}`);

  return available;
}

function isReady() {
  return initialized && connection !== null;
}

function getAvailable() {
  return { ...available };
}

// ============================================================================
// QUOTE FUNCTIONS
// ============================================================================

/**
 * Quote Meteora DLMM
 */
async function quoteDlmm(pool, inputMint, dxAtomic) {
  if (!available.dlmm || !DLMM || !BN) return null;

  stats.calls.dlmm++;

  try {
    await waitForRateLimit();

    // Get or create pool instance
    let dlmmPool = getCachedPool(pool.poolAddress);

    if (!dlmmPool) {
      dlmmPool = await DLMM.create(connection, new PublicKey(pool.poolAddress));
      setCachedPool(pool.poolAddress, dlmmPool);
    }

    // Determine swap direction
    const swapForY = (inputMint === pool.baseMint);

    // Get bin arrays
    const binArrays = await dlmmPool.getBinArrayForSwap(swapForY);

    // Quote swap
    const quote = await dlmmPool.swapQuote(
      new BN(dxAtomic.toString()),
      swapForY,
      new BN(100), // 1% slippage
      binArrays
    );

    if (!quote || !quote.outAmount) {
      stats.errors.dlmm++;
      return null;
    }

    handleSuccess();
    stats.success.dlmm++;

    return {
      dyAtomic: quote.outAmount.toString(),
      priceImpactPct: quote.priceImpact?.toString() || '0',
      feeRate: pool.fee || 0.003,
      via: 'sdk-dlmm'
    };

  } catch (e) {
    stats.errors.dlmm++;
    stats.lastError = e.message;

    if (e.message?.includes('429')) {
      handle429();
    }

    return null;
  }
}

/**
 * Quote Orca Whirlpool
 */
async function quoteWhirlpool(pool, inputMint, dxAtomic) {
  if (!available.whirlpool || !WhirlpoolSDK) return null;

  stats.calls.whirlpool++;

  try {
    await waitForRateLimit();

    const { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken } = WhirlpoolSDK;
    const { Percentage } = require('@orca-so/common-sdk');

    // Create dummy wallet for read-only operations
    const dummyWallet = {
      publicKey: new PublicKey('11111111111111111111111111111111'),
      signTransaction: async (tx) => tx,
      signAllTransactions: async (txs) => txs
    };

    const ctx = WhirlpoolContext.from(connection, dummyWallet, WhirlpoolSDK.ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);
    const whirlpool = await client.getPool(new PublicKey(pool.poolAddress));

    const slippage = Percentage.fromFraction(100, 10000); // 1%

    const quote = await swapQuoteByInputToken(
      whirlpool,
      new PublicKey(inputMint),
      new BN(dxAtomic.toString()),
      slippage,
      ctx.program.programId,
      ctx.fetcher
    );

    if (!quote || !quote.estimatedAmountOut) {
      stats.errors.whirlpool++;
      return null;
    }

    handleSuccess();
    stats.success.whirlpool++;

    return {
      dyAtomic: quote.estimatedAmountOut.toString(),
      priceImpactPct: '0',
      feeRate: pool.fee || 0.003,
      via: 'sdk-whirlpool'
    };

  } catch (e) {
    stats.errors.whirlpool++;
    stats.lastError = e.message;

    if (e.message?.includes('429')) {
      handle429();
    }

    return null;
  }
}

/**
 * Quote Raydium CLMM
 */
async function quoteClmm(pool, inputMint, dxAtomic) {
  if (!available.clmm || !RaydiumSDK) return null;

  stats.calls.clmm++;

  try {
    await waitForRateLimit();

    const { Raydium } = RaydiumSDK;

    // Initialize Raydium
    const raydium = await Raydium.load({
      connection,
      cluster: 'mainnet',
      disableFeatureCheck: true
    });

    // Get pool info
    const poolInfo = await raydium.clmm.getPoolInfoFromRpc(pool.poolAddress);

    if (!poolInfo) {
      stats.errors.clmm++;
      return null;
    }

    // Get quote
    const result = await raydium.clmm.computeAmountOut({
      poolInfo,
      amountIn: dxAtomic.toString(),
      tokenIn: new PublicKey(inputMint),
      slippage: 0.01 // 1%
    });

    const outAmount = result?.minAmountOut || result?.amountOut;

    if (!outAmount) {
      stats.errors.clmm++;
      return null;
    }

    handleSuccess();
    stats.success.clmm++;

    return {
      dyAtomic: outAmount.toString(),
      priceImpactPct: result?.priceImpact?.toString() || '0',
      feeRate: pool.fee || 0.0025,
      via: 'sdk-clmm'
    };

  } catch (e) {
    stats.errors.clmm++;
    stats.lastError = e.message;

    if (e.message?.includes('429')) {
      handle429();
    }

    return null;
  }
}

/**
 * Unified quote - routes to correct SDK
 */
async function quote(pool, inputMint, dxAtomic) {
  if (!initialized) {
    console.warn('[sdk] Not initialized. Call sdk.initialize(connection) first.');
    return null;
  }

  const type = normalizeType(pool);

  switch (type) {
    case 'dlmm':
      return await quoteDlmm(pool, inputMint, dxAtomic);

    case 'whirlpool':
      return await quoteWhirlpool(pool, inputMint, dxAtomic);

    case 'clmm':
      return await quoteClmm(pool, inputMint, dxAtomic);

    case 'cpmm':
      // CPMM uses math, no SDK needed
      return null;

    default:
      return null;
  }
}

// ============================================================================
// STATS
// ============================================================================
function getStats() {
  const now = Date.now();
  const backoffMs = Math.max(0, rateLimiter.backoffUntil - now);

  return {
    calls: { ...stats.calls },
    success: { ...stats.success },
    errors: { ...stats.errors },
    lastError: stats.lastError,
    cacheSize: poolCache.size,
    rateLimiter: {
      consecutive429s: rateLimiter.consecutive429s,
      backoffRemaining: backoffMs > 0 ? `${Math.ceil(backoffMs / 1000)}s` : 'none'
    }
  };
}

function resetStats() {
  stats.calls = { dlmm: 0, whirlpool: 0, clmm: 0 };
  stats.success = { dlmm: 0, whirlpool: 0, clmm: 0 };
  stats.errors = { dlmm: 0, whirlpool: 0, clmm: 0 };
  stats.lastError = null;
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  // Lifecycle
  initialize,
  isReady,
  getAvailable,

  // Quoting
  quote,
  quoteDlmm,
  quoteWhirlpool,
  quoteClmm,

  // Stats
  getStats,
  resetStats,
  clearCache,

  // Connection access
  getConnection: () => connection
};

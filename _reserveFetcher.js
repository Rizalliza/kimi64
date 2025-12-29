'use strict';
/**
 * _reserveFetcher.js - Intelligent Reserve Data Fetcher
 * 
 * Hydrates incomplete pool data by fetching reserves from on-chain sources.
 * 
 * Features:
 * - Multi-source fetching (Meteora DLMM, Orca Whirlpool, Raydium CLMM/CPMM)
 * - Smart caching to reduce RPC calls
 * - Graceful fallback when SDK unavailable
 * - Batch processing with progress tracking
 * - Error resilience (continues on failures)
 * 
 * Usage:
 *   const fetcher = new ReserveFetcher(connection);
 *   const hydrated = await fetcher.hydratePoolsWithReserves(pools);
 */

const { PublicKey } = require('@solana/web3.js');
const { D, normalizeType, sleep } = require('./_utils');

class ReserveFetcher {
  constructor(connection, options = {}) {
    this.connection = connection;
    this.sdks = {
      dlmm: null,
      whirlpool: null,
      raydium: null
    };
    this.cache = new Map();
    this.stats = {
      total: 0,
      hydrated: 0,
      cached: 0,
      failed: 0,
      skipped: 0,
      byType: {}
    };
    this.options = {
      cacheTTL: options.cacheTTL || 600000,
      rpcTimeout: options.rpcTimeout || 10000,
      batchSize: options.batchSize || 10,
      retries: options.retries || 2,
      log: options.log !== false,
      ...options
    };
  }

  async initialize() {
    if (this.options.log) console.log('[reserveFetcher] Initializing SDKs...');

    try {
      const DLMM = await import('@meteora-ag/dlmm');
      this.sdks.dlmm = DLMM;
      if (this.options.log) console.log('  ✓ Meteora DLMM loaded');
    } catch (e) {
      if (this.options.log) console.log('  ✗ Meteora DLMM unavailable:', e.message);
    }

    try {
      const WhirlpoolSDK = await import('@orca-so/whirlpools-sdk');
      this.sdks.whirlpool = WhirlpoolSDK;
      if (this.options.log) console.log('  ✓ Orca Whirlpool loaded');
    } catch (e) {
      if (this.options.log) console.log('  ✗ Orca Whirlpool unavailable:', e.message);
    }

    try {
      const RaydiumSDK = await import('@raydium-io/raydium-sdk-v2');
      this.sdks.raydium = RaydiumSDK;
      if (this.options.log) console.log('  ✓ Raydium SDK loaded');
    } catch (e) {
      if (this.options.log) console.log('  ✗ Raydium SDK unavailable:', e.message);
    }
  }

  /**
   * Main entry point: hydrate pool array with reserve data
   */
  async hydratePoolsWithReserves(pools, onProgress = null) {
    if (!Array.isArray(pools)) return [];

    this.stats.total = pools.length;
    const hydrated = [];

    for (let i = 0; i < pools.length; i += this.options.batchSize) {
      const batch = pools.slice(i, i + this.options.batchSize);
      const results = await Promise.all(
        batch.map(p => this.hydratePoolReserves(p).catch(e => ({
          ...p,
          _hydrationError: e.message
        })))
      );

      hydrated.push(...results);

      if (onProgress) {
        onProgress({
          current: Math.min(i + this.options.batchSize, pools.length),
          total: pools.length,
          hydrated: this.stats.hydrated,
          cached: this.stats.cached,
          failed: this.stats.failed
        });
      }

      if (i + this.options.batchSize < pools.length) {
        await sleep(100);
      }
    }

    return hydrated;
  }

  /**
   * Hydrate a single pool with reserves
   */
  async hydratePoolReserves(pool) {
    const type = normalizeType(pool);
    this.stats.byType[type] = (this.stats.byType[type] || 0) + 1;

    if (!pool.poolAddress) {
      this.stats.skipped++;
      return pool;
    }

    if (this.hasCompleteReserves(pool)) {
      this.stats.skipped++;
      return pool;
    }

    const cacheKey = `${pool.poolAddress}:${type}`;
    const cached = this.cache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < this.options.cacheTTL)) {
      this.stats.cached++;
      return { ...pool, ...cached.data };
    }

    try {
      let reserves = null;

      if (type === 'dlmm') {
        reserves = await this.fetchDLMMReserves(pool);
      } else if (type === 'whirlpool') {
        reserves = await this.fetchWhirlpoolReserves(pool);
      } else if (type === 'clmm') {
        reserves = await this.fetchCLMMReserves(pool);
      } else if (type === 'cpmm') {
        reserves = await this.fetchCPMMReserves(pool);
      }

      if (reserves) {
        const hydrated = { ...pool, ...reserves };
        this.cache.set(cacheKey, { data: reserves, timestamp: Date.now() });
        this.stats.hydrated++;
        return hydrated;
      }
    } catch (e) {
      this.stats.failed++;
      if (this.options.log) {
        console.log(`  ⚠ Failed to fetch reserves for ${pool.poolAddress.slice(0, 8)}: ${e.message}`);
      }
    }

    return pool;
  }

  /**
   * Check if pool has complete reserve data
   */
  hasCompleteReserves(pool) {
    try {
      const xRes = pool.xReserve;
      const yRes = pool.yReserve;
      if (xRes === null || xRes === undefined || yRes === null || yRes === undefined) {
        return false;
      }
      const x = D(xRes);
      const y = D(yRes);
      const hasBase = pool.baseDecimals !== null && pool.baseDecimals !== undefined;
      const hasQuote = pool.quoteDecimals !== null && pool.quoteDecimals !== undefined;
      return x.gt(0) && y.gt(0) && hasBase && hasQuote;
    } catch (e) {
      return false;
    }
  }

  /**
   * Fetch DLMM reserves from Meteora SDK
   */
  async fetchDLMMReserves(pool) {
    if (!this.sdks.dlmm) return null;

    try {
      const { LbClient } = this.sdks.dlmm;
      const lbClient = new LbClient(this.connection);
      const lbPair = await lbClient.getLbPair(
        new PublicKey(pool.poolAddress)
      );

      if (!lbPair || !lbPair.reserveX || !lbPair.reserveY) {
        return null;
      }

      return {
        xReserve: lbPair.reserveX.toString(),
        yReserve: lbPair.reserveY.toString(),
        baseDecimals: lbPair.tokenXDecimals || 9,
        quoteDecimals: lbPair.tokenYDecimals || 6,
        reserveSource: 'dlmm-sdk'
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Fetch Whirlpool reserves from Orca SDK
   */
  async fetchWhirlpoolReserves(pool) {
    if (!this.sdks.whirlpool) return null;

    try {
      const { buildWhirlpoolClient } = this.sdks.whirlpool;
      const client = buildWhirlpoolClient(this.connection);
      const whirlpool = await client.getPool(
        new PublicKey(pool.poolAddress)
      );

      if (!whirlpool || !whirlpool.liquidity) {
        return null;
      }

      return {
        xReserve: (whirlpool.vaultA?.amount?.toString?.() || '0'),
        yReserve: (whirlpool.vaultB?.amount?.toString?.() || '0'),
        baseDecimals: pool.baseDecimals || 9,
        quoteDecimals: pool.quoteDecimals || 6,
        sqrtPriceX64: whirlpool.sqrtPrice?.toString?.(),
        currentTick: whirlpool.tickCurrentIndex,
        reserveSource: 'whirlpool-sdk'
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Fetch CLMM reserves from Raydium SDK
   */
  async fetchCLMMReserves(pool) {
    if (!this.sdks.raydium) return null;

    try {
      // First priority: use existing pool data if available
      if (pool.xReserve && pool.yReserve) {
        return {
          xReserve: pool.xReserve.toString(),
          yReserve: pool.yReserve.toString(),
          baseDecimals: pool.baseDecimals || 9,
          quoteDecimals: pool.quoteDecimals || 6,
          reserveSource: 'clmm-pool-data'
        };
      }

      // Fallback: Try SDK fetch with pool address
      const rSDK = this.sdks.raydium;
      if (rSDK.fetchPoolByAddress) {
        const poolData = await rSDK.fetchPoolByAddress({
          connection: this.connection,
          poolAddress: pool.poolAddress
        });

        if (poolData && (poolData.baseReserve || poolData.quoteReserve)) {
          return {
            xReserve: (poolData.baseReserve || '0').toString(),
            yReserve: (poolData.quoteReserve || '0').toString(),
            baseDecimals: poolData.baseDecimals || pool.baseDecimals || 9,
            quoteDecimals: poolData.quoteDecimals || pool.quoteDecimals || 6,
            liquidity: poolData.liquidity?.toString?.(),
            currentTick: poolData.currentTick,
            reserveSource: 'raydium-clmm-sdk'
          };
        }
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Fetch CPMM reserves from on-chain (via token accounts)
   */
  async fetchCPMMReserves(pool) {
    try {
      // CRITICAL: Check if pool already has reserve data (most CPMM do!)
      if (pool.xReserve && pool.yReserve) {
        return {
          xReserve: pool.xReserve.toString(),
          yReserve: pool.yReserve.toString(),
          baseDecimals: pool.baseDecimals || 9,
          quoteDecimals: pool.quoteDecimals || 6,
          reserveSource: 'cpmm-pool-data'
        };
      }

      // Fallback: Try to fetch from vault accounts if addresses provided
      const vaultX = pool.vaults?.xVault || pool.vaultX || pool.vault0;
      const vaultY = pool.vaults?.yVault || pool.vaultY || pool.vault1;

      if (!vaultX || !vaultY) {
        return null;
      }

      const [accountX, accountY] = await Promise.all([
        this.connection.getTokenAccountBalance(new PublicKey(vaultX)),
        this.connection.getTokenAccountBalance(new PublicKey(vaultY))
      ]);

      if (!accountX?.value?.amount || !accountY?.value?.amount) {
        return null;
      }

      return {
        xReserve: accountX.value.amount,
        yReserve: accountY.value.amount,
        baseDecimals: pool.baseDecimals || accountX.value.decimals || 9,
        quoteDecimals: pool.quoteDecimals || accountY.value.decimals || 6,
        reserveSource: 'cpmm-on-chain'
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Get fetcher statistics
   */
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.total > 0
        ? ((this.stats.hydrated + this.stats.skipped) / this.stats.total * 100).toFixed(1) + '%'
        : '0%'
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }
}

// ============================================================================
// CONVENIENCE FUNCTION
// ============================================================================

/**
 * One-shot hydration (initialize, fetch, done)
 */
async function hydratePoolsOnDemand(connection, pools, options = {}) {
  const fetcher = new ReserveFetcher(connection, options);
  await fetcher.initialize();
  const hydrated = await fetcher.hydratePoolsWithReserves(pools);

  if (options.log) {
    const stats = fetcher.getStats();
    console.log(`\n[reserveFetcher] Results:`);
    console.log(`  Total: ${stats.total}`);
    console.log(`  Hydrated: ${stats.hydrated}`);
    console.log(`  From cache: ${stats.cached}`);
    console.log(`  Failed: ${stats.failed}`);
    console.log(`  Skipped: ${stats.skipped}`);
    console.log(`  Success rate: ${stats.successRate}`);
  }

  return hydrated;
}

module.exports = {
  ReserveFetcher,
  hydratePoolsOnDemand
};

// node _reserveFetcher.js triRoute.json | jq '.[] | select(.baseSymbol == "TRI" and .quoteSymbol == "USDC")'
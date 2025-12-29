#!/usr/bin/env node
'use strict';
/**
 * _poolFetcher.js - Multi-DEX Pool Fetcher
 * 
 * Fetches pools from:
 * - Meteora DLMM API
 * - Orca Whirlpool API
 * - Raydium CPMM API
 * - Raydium CLMM API
 * 
 * Outputs normalized "metadata pools" ready for reserve enrichment.
 * 
 * Usage:
 *   
 * node _poolFetcher.js --output=output/mData_metPool.json --min-liquidity=n>750000  --include-sol --include-usdc --dex=meteora
 * 
 * node _poolFetcher.js --output=output/mData_orcaPool --min-liquidity=n>750000  --include-sol --include-usdc --dex=orca
 * 
 * node _poolFetcher.js --output=output/mData_rayPool --min-liquidity=n>750000  --include-sol --include-usdc --dex=raydium
 * 
 * node _poolFetcher.js --output=output/mData_metPool --min-liquidity=n>750000  --include-sol --include-usdc --dex=meteora
 * 
 * Options:
 *   --output=<file>      Output file (default: pools_meta.json)
 *   --min-liquidity=<n>  Minimum liquidity filter (default: 1000)
 *   --include-sol        Only include pools with SOL
 *   --include-usdc       Only include pools with USDC
 *   --dex=<name>         Only fetch from specific DEX (meteora|orca|raydium)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

// Known token decimals
const TOKEN_DECIMALS = {
  [TOKENS.SOL]: 9,
  [TOKENS.USDC]: 6,
  [TOKENS.USDT]: 6,
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': 9,  // bSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 9,  // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 9, // jitoSOL
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 6,  // JUP
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 5, // BONK
};

// API Endpoints
const APIS = {
  // Meteora DLMM
  METEORA_DLMM: 'https://dlmm-api.meteora.ag/pair/all',

  // Orca Whirlpool
  ORCA_WHIRLPOOL: 'https://api.mainnet.orca.so/v1/whirlpool/list',

  // Raydium
  RAYDIUM_CPMM: 'https://api-v3.raydium.io/pools/info/list?poolType=standard&poolSortField=liquidity&sortType=desc&pageSize=500&page=1',
  RAYDIUM_CLMM: 'https://api-v3.raydium.io/pools/info/list?poolType=concentrated&poolSortField=liquidity&sortType=desc&pageSize=500&page=1',
};

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDecimals(mint) {
  return TOKEN_DECIMALS[mint] ?? 9; // Default to 9 if unknown
}

function hasSol(baseMint, quoteMint) {
  return baseMint === TOKENS.SOL || quoteMint === TOKENS.SOL;
}

function hasUsdc(baseMint, quoteMint) {
  return baseMint === TOKENS.USDC || quoteMint === TOKENS.USDC;
}

/**
 * Normalize reserve value to string
 * Handles both atomic (integer) and human (decimal) formats
 * Returns null if invalid
 */
function normalizeReserve(value, decimals = 0) {
  if (value === null || value === undefined) return null;

  // Convert to string
  const str = String(value).trim();
  if (!str || str === '0' || str === 'null') return null;

  // Check if it's a valid number
  const num = parseFloat(str);
  if (!isFinite(num) || num <= 0) return null;

  // If it has a decimal point and decimals info provided, 
  // it might be human format - convert to atomic
  if (str.includes('.') && decimals > 0) {
    // Human format like "35479.306257799" -> atomic
    const parts = str.split('.');
    const wholePart = parts[0] || '0';
    const decimalPart = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);
    return wholePart + decimalPart;
  }

  // Already atomic or no decimals info - return as-is
  return str.replace(/\..*$/, ''); // Remove any decimals for safety
}

// ============================================================================
// METEORA DLMM FETCHER
// ============================================================================

/**
 * Fetch and normalize Meteora DLMM pools
 * 
 * API Response shape:
 * {
 *   "address": "poolAddress",
 *   "name": "SOL-USDC",
 *   "mint_x": "So111...",
 *   "mint_y": "EPjFWd...",
 *   "reserve_x": "vaultXAddress",
 *   "reserve_y": "vaultYAddress",
 *   "reserve_x_amount": "123456789",
 *   "reserve_y_amount": "987654321",
 *   "bin_step": 20,
 *   "base_fee_percentage": "0.02",
 *   "liquidity": "1234567.89"
 * }
 */
async function fetchMeteoraDlmm(options = {}) {
  console.log('[fetcher] Fetching Meteora DLMM pools...');

  try {
    const response = await fetch(APIS.METEORA_DLMM);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const pools = Array.isArray(data) ? data : (data.data || data.pools || []);

    console.log(`[fetcher] Meteora DLMM: ${pools.length} raw pools`);

    const normalized = [];

    for (const raw of pools) {
      // Extract required fields
      const poolAddress = raw.address;
      if (!poolAddress) continue;

      // Mints - Meteora uses mint_x/mint_y
      const baseMint = raw.mint_x;
      const quoteMint = raw.mint_y;
      if (!baseMint || !quoteMint) continue;

      // Filter by SOL/USDC if requested
      if (options.includeSol && !hasSol(baseMint, quoteMint)) continue;
      if (options.includeUsdc && !hasUsdc(baseMint, quoteMint)) continue;

      // Liquidity filter
      const liquidity = parseFloat(raw.liquidity || raw.tvl || 0);
      if (options.minLiquidity && liquidity < options.minLiquidity) continue;

      // Decimals - try to get from token info or lookup
      const baseDecimals = raw.mint_x_decimals ?? getDecimals(baseMint);
      const quoteDecimals = raw.mint_y_decimals ?? getDecimals(quoteMint);

      // Fee - Meteora uses base_fee_percentage (e.g., "0.02" means 0.02%)
      let fee = parseFloat(raw.base_fee_percentage || 0.02);
      if (fee > 1) fee = fee / 10000; // Convert from basis points
      else if (fee > 0.01) fee = fee / 100; // Convert from percentage

      const xVault = raw.reserve_x;
      const yVault = raw.reserve_y;

      const xReserve = normalizeReserve(raw.reserve_x_amount, baseDecimals);
      const yReserve = normalizeReserve(raw.reserve_y_amount, quoteDecimals);
      const hasReserves = !!(xReserve && yReserve);

      normalized.push({
        poolAddress,
        dex: 'meteora',
        type: 'dlmm',

        baseMint,
        quoteMint,
        baseDecimals,
        quoteDecimals,

        fee,
        binStep: raw.bin_step || 20,

        vaults: (xVault && yVault) ? { xVault, yVault } : null,

        xReserve,
        yReserve,

        reserveSource: hasReserves ? 'cache' : 'none',
        hasReserves,
        isMathReady: hasReserves,

        dlmm: {
          bins: []
        },

        _raw: raw
      });
    }

    console.log(`[fetcher] Meteora DLMM: ${normalized.length} pools after filtering`);
    return normalized;

  } catch (e) {
    console.error(`[fetcher] Meteora DLMM error: ${e.message}`);
    return [];
  }
}

// ============================================================================
// ORCA WHIRLPOOL FETCHER
// ============================================================================

/**
 * Fetch and normalize Orca Whirlpool pools
 * 
 * API Response shape:
 * {
 *   "address": "whirlpoolAddress",
 *   "tokenA": { "mint": "So111...", "symbol": "SOL", "decimals": 9 },
 *   "tokenB": { "mint": "EPjFWd...", "symbol": "USDC", "decimals": 6 },
 *   "tokenVaultA": "vaultAAddress",
 *   "tokenVaultB": "vaultBAddress",
 *   "tickSpacing": 64,
 *   "feeRate": 3000,  // In hundredths of a basis point (3000 = 0.3%)
 *   "liquidity": "123456789",
 *   "sqrtPrice": "123456789",
 *   "tickCurrentIndex": 12345
 * }
 */
async function fetchOrcaWhirlpool(options = {}) {
  console.log('[fetcher] Fetching Orca Whirlpool pools...');

  try {
    const response = await fetch(APIS.ORCA_WHIRLPOOL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const pools = Array.isArray(data) ? data : (data.whirlpools || data.data || []);

    console.log(`[fetcher] Orca Whirlpool: ${pools.length} raw pools`);

    const normalized = [];

    for (const raw of pools) {
      const poolAddress = raw.address;
      if (!poolAddress) continue;

      // Mints - Orca uses tokenA/tokenB objects
      const baseMint = raw.tokenA?.mint || raw.tokenMintA;
      const quoteMint = raw.tokenB?.mint || raw.tokenMintB;
      if (!baseMint || !quoteMint) continue;

      // Filter
      if (options.includeSol && !hasSol(baseMint, quoteMint)) continue;
      if (options.includeUsdc && !hasUsdc(baseMint, quoteMint)) continue;

      // Liquidity filter (Orca liquidity is in raw units)
      const liquidity = parseFloat(raw.tvl || raw.liquidity || 0);
      if (options.minLiquidity && liquidity < options.minLiquidity) continue;

      // Decimals
      const baseDecimals = raw.tokenA?.decimals ?? getDecimals(baseMint);
      const quoteDecimals = raw.tokenB?.decimals ?? getDecimals(quoteMint);

      // Fee - Orca feeRate is in hundredths of a basis point
      // 3000 = 0.3% = 0.003
      let fee = parseFloat(raw.feeRate || 3000);
      if (fee > 100) fee = fee / 1000000; // Convert from hundredths of bp

      normalized.push({
        poolAddress,
        dex: 'orca',
        type: 'whirlpool',

        baseMint,
        quoteMint,
        baseDecimals,
        quoteDecimals,

        fee,
        tickSpacing: raw.tickSpacing || 64,

        vaults: null,

        hasReserves: false,
        isMathReady: false,

        clmm: {
          sqrtPriceX64: raw.sqrtPrice || null,
          liquidity: raw.liquidity || null,
          currentTickIndex: raw.tickCurrentIndex || null,
          tickArrays: []
        },

        reserveSource: 'none',

        _raw: raw
      });
    }

    console.log(`[fetcher] Orca Whirlpool: ${normalized.length} pools after filtering`);
    return normalized;

  } catch (e) {
    console.error(`[fetcher] Orca Whirlpool error: ${e.message}`);
    return [];
  }
}

// ============================================================================
// RAYDIUM CPMM FETCHER
// ============================================================================

/**
 * Fetch and normalize Raydium CPMM pools
 * 
 * API Response shape (v3):
 * {
 *   "type": "Standard",
 *   "id": "poolAddress",
 *   "mintA": { "address": "So111...", "symbol": "SOL", "decimals": 9 },
 *   "mintB": { "address": "EPjFWd...", "symbol": "USDC", "decimals": 6 },
 *   "vaultA": "vaultAAddress",
 *   "vaultB": "vaultBAddress",
 *   "mintAmountA": 123456789,
 *   "mintAmountB": 987654321,
 *   "feeRate": 0.0025,
 *   "tvl": 1234567.89,
 *   "lpMint": { "address": "lpMintAddress" }
 * }
 */
async function fetchRaydiumCpmm(options = {}) {
  console.log('[fetcher] Fetching Raydium CPMM pools...');

  try {
    const response = await fetch(APIS.RAYDIUM_CPMM);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const json = await response.json();
    const pools = json.data?.data || json.data || [];

    console.log(`[fetcher] Raydium CPMM: ${pools.length} raw pools`);

    const normalized = [];

    for (const raw of pools) {
      const poolAddress = raw.id || raw.poolId || raw.address;
      if (!poolAddress) continue;

      // Mints - Raydium v3 uses mintA/mintB objects
      const baseMint = raw.mintA?.address || raw.baseMint || raw.mintA;
      const quoteMint = raw.mintB?.address || raw.quoteMint || raw.mintB;
      if (!baseMint || !quoteMint) continue;

      // Filter
      if (options.includeSol && !hasSol(baseMint, quoteMint)) continue;
      if (options.includeUsdc && !hasUsdc(baseMint, quoteMint)) continue;

      // Liquidity filter
      const liquidity = parseFloat(raw.tvl || raw.liquidity || 0);
      if (options.minLiquidity && liquidity < options.minLiquidity) continue;

      // Decimals
      const baseDecimals = raw.mintA?.decimals ?? getDecimals(baseMint);
      const quoteDecimals = raw.mintB?.decimals ?? getDecimals(quoteMint);

      // Fee - Raydium feeRate is already decimal (0.0025 = 0.25%)
      let fee = parseFloat(raw.feeRate || 0.0025);
      if (fee > 1) fee = fee / 10000; // Convert from basis points if needed

      const xVault = raw.vaultA || raw.vault?.a;
      const yVault = raw.vaultB || raw.vault?.b;

      const xReserve = normalizeReserve(raw.mintAmountA || raw.vaultAmountA, baseDecimals);
      const yReserve = normalizeReserve(raw.mintAmountB || raw.vaultAmountB, quoteDecimals);
      const hasReserves = !!(xReserve && yReserve);

      normalized.push({
        poolAddress,
        dex: 'raydium',
        type: 'cpmm',

        baseMint,
        quoteMint,
        baseDecimals,
        quoteDecimals,

        fee,

        vaults: (xVault && yVault) ? { xVault, yVault } : null,

        xReserve,
        yReserve,

        reserveSource: hasReserves ? 'cache' : 'none',
        hasReserves,
        isMathReady: hasReserves,

        _raw: raw
      });
    }

    console.log(`[fetcher] Raydium CPMM: ${normalized.length} pools after filtering`);
    return normalized;

  } catch (e) {
    console.error(`[fetcher] Raydium CPMM error: ${e.message}`);
    return [];
  }
}

// ============================================================================
// RAYDIUM CLMM FETCHER
// ============================================================================

/**
 * Fetch and normalize Raydium CLMM pools
 * 
 * Similar to CPMM but with concentrated liquidity fields
 */
async function fetchRaydiumClmm(options = {}) {
  console.log('[fetcher] Fetching Raydium CLMM pools...');

  try {
    const response = await fetch(APIS.RAYDIUM_CLMM);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const json = await response.json();
    const pools = json.data?.data || json.data || [];

    console.log(`[fetcher] Raydium CLMM: ${pools.length} raw pools`);

    const normalized = [];

    for (const raw of pools) {
      const poolAddress = raw.id || raw.poolId || raw.address;
      if (!poolAddress) continue;

      // Mints
      const baseMint = raw.mintA?.address || raw.baseMint || raw.mintA;
      const quoteMint = raw.mintB?.address || raw.quoteMint || raw.mintB;
      if (!baseMint || !quoteMint) continue;

      // Filter
      if (options.includeSol && !hasSol(baseMint, quoteMint)) continue;
      if (options.includeUsdc && !hasUsdc(baseMint, quoteMint)) continue;

      // Liquidity filter
      const liquidity = parseFloat(raw.tvl || raw.liquidity || 0);
      if (options.minLiquidity && liquidity < options.minLiquidity) continue;

      // Decimals
      const baseDecimals = raw.mintA?.decimals ?? getDecimals(baseMint);
      const quoteDecimals = raw.mintB?.decimals ?? getDecimals(quoteMint);

      // Fee
      let fee = parseFloat(raw.feeRate || raw.tradeFeeRate || 0.0025);
      if (fee > 1) fee = fee / 10000;

      normalized.push({
        poolAddress,
        dex: 'raydium',
        type: 'clmm',

        baseMint,
        quoteMint,
        baseDecimals,
        quoteDecimals,

        fee,
        tickSpacing: raw.config?.tickSpacing || raw.tickSpacing || 1,

        vaults: null,

        hasReserves: false,
        isMathReady: false,

        clmm: {
          sqrtPriceX64: raw.price?.toString() || null,
          liquidity: raw.liquidity?.toString() || null,
          currentTickIndex: raw.tickCurrent || null,
          tickArrays: []
        },

        reserveSource: 'none',

        _raw: raw
      });
    }

    console.log(`[fetcher] Raydium CLMM: ${normalized.length} pools after filtering`);
    return normalized;

  } catch (e) {
    console.error(`[fetcher] Raydium CLMM error: ${e.message}`);
    return [];
  }
}

// ============================================================================
// MAIN FETCHER
// ============================================================================

/**
 * Fetch pools from all DEXes
 */
async function fetchAllPools(options = {}) {
  const allPools = [];
  const targetDex = options.dex?.toLowerCase();

  // Meteora DLMM
  if (!targetDex || targetDex === 'meteora') {
    const meteoraPools = await fetchMeteoraDlmm(options);
    allPools.push(...meteoraPools);
    await sleep(500); // Rate limit
  }

  // Orca Whirlpool
  if (!targetDex || targetDex === 'orca') {
    const orcaPools = await fetchOrcaWhirlpool(options);
    allPools.push(...orcaPools);
    await sleep(500);
  }

  // Raydium CPMM
  if (!targetDex || targetDex === 'raydium') {
    const raydiumCpmmPools = await fetchRaydiumCpmm(options);
    allPools.push(...raydiumCpmmPools);
    await sleep(500);
  }

  // Raydium CLMM
  if (!targetDex || targetDex === 'raydium') {
    const raydiumClmmPools = await fetchRaydiumClmm(options);
    allPools.push(...raydiumClmmPools);
  }

  // Summary
  console.log(`\n[fetcher] === SUMMARY ===`);
  console.log(`[fetcher] Total pools: ${allPools.length}`);

  // By DEX
  const byDex = {};
  for (const p of allPools) {
    byDex[p.dex] = (byDex[p.dex] || 0) + 1;
  }
  console.log(`[fetcher] By DEX: ${JSON.stringify(byDex)}`);

  // By type
  const byType = {};
  for (const p of allPools) {
    byType[p.type] = (byType[p.type] || 0) + 1;
  }
  console.log(`[fetcher] By type: ${JSON.stringify(byType)}`);

  // SOL/USDC pairs
  const solPools = allPools.filter(p => hasSol(p.baseMint, p.quoteMint));
  const usdcPools = allPools.filter(p => hasUsdc(p.baseMint, p.quoteMint));
  const solUsdcDirect = allPools.filter(p =>
    (p.baseMint === TOKENS.SOL && p.quoteMint === TOKENS.USDC) ||
    (p.baseMint === TOKENS.USDC && p.quoteMint === TOKENS.SOL)
  );

  console.log(`[fetcher] SOL pairs: ${solPools.length}`);
  console.log(`[fetcher] USDC pairs: ${usdcPools.length}`);
  console.log(`[fetcher] Direct SOL/USDC: ${solUsdcDirect.length}`);

  // With reserves
  const withReserves = allPools.filter(p => p.xReserve && p.yReserve);
  console.log(`[fetcher] With reserves: ${withReserves.length}`);

  // With vaults (can be enriched)
  const withVaults = allPools.filter(p => p.vaults?.xVault && p.vaults?.yVault);
  console.log(`[fetcher] With vaults (enrichable): ${withVaults.length}`);

  return allPools;
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(args) {
  const opts = {
    output: 'pools_meta.json',
    minLiquidity: 1000,
    includeSol: false,
    includeUsdc: false,
    dex: null,
  };

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');

      switch (key) {
        case 'output':
          opts.output = val;
          break;
        case 'min-liquidity':
          opts.minLiquidity = parseFloat(val);
          break;
        case 'include-sol':
          opts.includeSol = true;
          break;
        case 'include-usdc':
          opts.includeUsdc = true;
          break;
        case 'dex':
          opts.dex = val;
          break;
      }
    }
  }

  return opts;
}

async function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  console.log('═'.repeat(60));
  console.log('MULTI-DEX POOL FETCHER');
  console.log('═'.repeat(60));
  console.log(`\nOptions:`);
  console.log(`  Output: ${opts.output}`);
  console.log(`  Min liquidity: $${opts.minLiquidity}`);
  console.log(`  Include SOL: ${opts.includeSol}`);
  console.log(`  Include USDC: ${opts.includeUsdc}`);
  console.log(`  DEX filter: ${opts.dex || 'all'}`);
  console.log('');

  const pools = await fetchAllPools(opts);

  // Save to file
  const outputPath = path.resolve(opts.output);
  fs.writeFileSync(outputPath, JSON.stringify(pools, null, 2));
  console.log(`\n✅ Saved ${pools.length} pools to ${outputPath}`);

  console.log('\n' + '═'.repeat(60));
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  });
}

// Exports for use as module
module.exports = {
  fetchAllPools,
  fetchMeteoraDlmm,
  fetchOrcaWhirlpool,
  fetchRaydiumCpmm,
  fetchRaydiumClmm,
  TOKENS,
  APIS,
};

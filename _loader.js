'use strict';
/**
 * _loader.js - Pool Data Loading and Enrichment
 * 
 * Handles:
 * - Loading pools from JSON files
 * - Normalizing various pool formats
 * - Enriching reserves from RPC
 * - Validating pool data
 */

const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const { D, normalizeType, normalizeDex, hasReserves, getFeeRate, getTokenDecimals, TOKENS } = require('./_utils');

// ============================================================================
// POOL NORMALIZATION
// ============================================================================

/**
 * Normalize a single pool from various formats
 * Handles Meteora, Raydium, Orca data structures
 * 
 * CRITICAL: Must extract mints correctly from all DEX formats:
 * - Meteora DLMM: mint_x/mint_y or baseToken.mint/quoteToken.mint
 * - Orca Whirlpool: tokenA.mint/tokenB.mint or tokenMintA/tokenMintB
 * - Raydium CPMM: mintA.address/mintB.address or baseMint/quoteMint
 * - Raydium CLMM: mintA.address/mintB.address or tokenA.mint/tokenB.mint
 * 
 * @param {Object} raw - Raw pool data
 * @returns {Object|null} Normalized pool or null if invalid
 */
function normalizePool(raw) {
  if (!raw) return null;
  
  // Extract pool address
  const poolAddress = raw.poolAddress || raw.id || raw.address || 
                      raw.pairAddress || raw.pool_address || 
                      raw._original?.id || raw._raw?.address || null;
  
  if (!poolAddress) return null;
  
  // Extract mints - CRITICAL: handle ALL variations
  // Priority order matters - more specific fields first
  const baseMint = 
    // Direct fields
    raw.baseMint ||
    // Raydium v3 mintA object
    raw.mintA?.address ||
    // Orca tokenA object
    raw.tokenA?.mint ||
    // Meteora raw fields
    raw.mint_x ||
    // Legacy fields
    raw.baseToken?.mint ||
    raw.tokenMintA ||
    // Nested _original
    raw._original?.baseMint ||
    raw._original?.mint_x ||
    raw._original?.mintA?.address ||
    raw._original?.tokenA?.mint ||
    // Nested raw
    raw.raw?.mint_x ||
    raw.raw?.mintA ||
    // Nested _raw
    raw._raw?.mint_x ||
    raw._raw?.mintA?.address ||
    null;
                   
  const quoteMint = 
    raw.quoteMint ||
    raw.mintB?.address ||
    raw.tokenB?.mint ||
    raw.mint_y ||
    raw.quoteToken?.mint ||
    raw.tokenMintB ||
    raw._original?.quoteMint ||
    raw._original?.mint_y ||
    raw._original?.mintB?.address ||
    raw._original?.tokenB?.mint ||
    raw.raw?.mint_y ||
    raw.raw?.mintB ||
    raw._raw?.mint_y ||
    raw._raw?.mintB?.address ||
    null;
  
  if (!baseMint || !quoteMint) return null;
  
  // Extract decimals - DON'T HARDCODE, get from token
  // Priority: pool field > token object > lookup > fallback
  let baseDecimals = 
    raw.baseDecimals ??
    raw.mintA?.decimals ??
    raw.tokenA?.decimals ??
    raw.baseToken?.decimals ??
    raw._original?.baseDecimals ??
    raw._original?.mintA?.decimals ??
    raw._original?.tokenA?.decimals ??
    raw._original?.baseToken?.decimals ??
    raw.tokenADecimals ??
    raw.decimalsA ??
    raw._raw?.mintA?.decimals;
                     
  let quoteDecimals = 
    raw.quoteDecimals ??
    raw.mintB?.decimals ??
    raw.tokenB?.decimals ??
    raw.quoteToken?.decimals ??
    raw._original?.quoteDecimals ??
    raw._original?.mintB?.decimals ??
    raw._original?.tokenB?.decimals ??
    raw._original?.quoteToken?.decimals ??
    raw.tokenBDecimals ??
    raw.decimalsB ??
    raw._raw?.mintB?.decimals;
  
  // If decimals still undefined, look up from known tokens
  if (baseDecimals === undefined || baseDecimals === null) {
    baseDecimals = getTokenDecimals(baseMint);
  }
  if (quoteDecimals === undefined || quoteDecimals === null) {
    quoteDecimals = getTokenDecimals(quoteMint);
  }
  
  // Final fallback - SHOULD RARELY BE NEEDED
  if (!Number.isFinite(baseDecimals)) baseDecimals = 9;
  if (!Number.isFinite(quoteDecimals)) quoteDecimals = 6;
  
  // Extract reserves - handle all field name variations
const xReserveRaw = 
  raw.xReserve || 
  raw.reserve_x_amount || 
  raw.liquidityX ||
  raw.mintAmountA ||
  raw.vaultAmountA ||
  raw.tokenAAmount || 
  raw._original?.xReserve ||
  raw._original?.reserve_x_amount ||
  raw.raw?.reserve_x_amount || 
  raw._raw?.reserve_x_amount ||
  raw._raw?.mintAmountA ||
  null;

const yReserveRaw = 
  raw.yReserve || 
  raw.reserve_y_amount || 
  raw.liquidityY ||
  raw.mintAmountB ||
  raw.vaultAmountB ||
  raw.tokenBAmount || 
  raw._original?.yReserve ||
  raw._original?.reserve_y_amount ||
  raw.raw?.reserve_y_amount ||
  raw._raw?.reserve_y_amount ||
  raw._raw?.mintAmountB ||
  null;

// Normalize reserves to ATOMIC integer strings.
// Some APIs return human amounts (e.g. "20215.46355") while others return atomic u64.
function normalizeReserveToAtomic(v, decimals) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  // Already atomic integer
  if (/^\d+$/.test(s)) return s;
  // Human decimal (or scientific); convert.
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    try {
      const a = humanToAtomic(s, decimals);
      return a?.toString?.() ?? String(a);
    } catch (e) {
      return null;
    }
  }
  return null;
}

const xReserve = normalizeReserveToAtomic(xReserveRaw, baseDecimals);
const yReserve = normalizeReserveToAtomic(yReserveRaw, quoteDecimals);

// Extract type and dex
  const type = normalizeType(raw);
  const dex = normalizeDex(raw);
  
  // Extract fee
  const fee = getFeeRate(raw);
  
  // Extract vault addresses (for reserve fetching)
  // CRITICAL: These must correspond to base/quote correctly
  const vaultX = 
    raw.vaultX || 
    raw.vaults?.xVault ||
    raw.vaultA ||
    raw.vaults?.aVault ||
    raw.tokenVaultA ||
    raw.reserve_x || 
    raw.raw?.reserve_x || 
    raw.raw?.vault_x ||
    raw.raw?.vault_a ||
    raw.raw?.vaultA ||
    raw._raw?.reserve_x ||
    raw._raw?.vaultA ||
    raw._original?.vaultX ||
    raw._original?.vaults?.xVault ||
    null;
    
  const vaultY = 
    raw.vaultY || 
    raw.vaults?.yVault ||
    raw.vaultB ||
    raw.vaults?.bVault ||
    raw.tokenVaultB ||
    raw.reserve_y ||
    raw.raw?.reserve_y ||
    raw.raw?.vault_y ||
    raw.raw?.vault_b ||
    raw.raw?.vaultB ||
    raw._raw?.reserve_y ||
    raw._raw?.vaultB ||
    raw._original?.vaultY ||
    raw._original?.vaults?.yVault ||
    null;
  
  return {
    poolAddress,
    baseMint,
    quoteMint,
    baseDecimals,
    quoteDecimals,
    xReserve: xReserve?.toString() || null,
    yReserve: yReserve?.toString() || null,
    // Include both flat and nested vaults for compatibility
    vaultX,
    vaultY,
    vaults: (vaultX && vaultY) ? { xVault: vaultX, yVault: vaultY } : null,
    type,
    dex,
    fee: fee.toString(),
    _raw: raw
  };
}

// ============================================================================
// FILE LOADING
// ============================================================================

/**
 * Load pools from JSON file
 * 
 * @param {string} filePath - Path to JSON file
 * @param {Object} options
 * @returns {Array} Normalized pools
 */
function loadPoolsFromFile(filePath, { log = false } = {}) {
  const abs = path.resolve(filePath);
  
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }
  
  const content = fs.readFileSync(abs, 'utf8');
  let json;
  
  try {
    json = JSON.parse(content);
  } catch (e) {
    throw new Error(`Invalid JSON in ${filePath}: ${e.message}`);
  }
  
  // Handle various formats
  let rawPools;
  if (Array.isArray(json)) {
    rawPools = json;
  } else if (json.pools) {
    rawPools = json.pools;
  } else if (json.data) {
    rawPools = json.data;
  } else {
    rawPools = Object.values(json);
  }
  
  if (log) {
    console.log(`[loader] Loaded ${rawPools.length} raw pools from ${path.basename(filePath)}`);
  }
  
  // Normalize
  const normalized = rawPools
    .map(normalizePool)
    .filter(p => p !== null);
  
  if (log) {
    console.log(`[loader] ${normalized.length} pools after normalization`);
    
    // Type breakdown
    const typeCount = {};
    for (const p of normalized) {
      typeCount[p.type] = (typeCount[p.type] || 0) + 1;
    }
    console.log(`[loader] Types: ${JSON.stringify(typeCount)}`);
    
    // DEX breakdown
    const dexCount = {};
    for (const p of normalized) {
      dexCount[p.dex] = (dexCount[p.dex] || 0) + 1;
    }
    console.log(`[loader] DEXes: ${JSON.stringify(dexCount)}`);
    
    // Reserve status
    const withReserves = normalized.filter(hasReserves).length;
    console.log(`[loader] With reserves: ${withReserves}/${normalized.length}`);
    
    // Check for SOL/USDC pairs
    const solPools = normalized.filter(p => 
      p.baseMint === TOKENS.SOL || p.quoteMint === TOKENS.SOL
    ).length;
    const usdcPools = normalized.filter(p => 
      p.baseMint === TOKENS.USDC || p.quoteMint === TOKENS.USDC
    ).length;
    console.log(`[loader] SOL pairs: ${solPools}, USDC pairs: ${usdcPools}`);
  }
  
  return normalized;
}

// ============================================================================
// RESERVE ENRICHMENT
// ============================================================================

/**
 * Parse SPL Token account data to extract balance
 * @param {Buffer} data - Account data
 * @returns {BigInt|null}
 */
function parseSplTokenAccountAmount(data) {
  if (!data || !Buffer.isBuffer(data) || data.length < 72) return null;
  try {
    return data.readBigUInt64LE(64);
  } catch {
    return null;
  }
}

/**
 * Fetch fresh reserves for pools via RPC
 * 
 * @param {Array} pools - Pools to enrich
 * @param {Connection} connection - Solana connection
 * @param {Object} options
 * @returns {Promise<Array>} Enriched pools
 */
async function enrichReserves(pools, connection, { log = false, batchSize = 100 } = {}) {
  if (!connection) {
    console.warn('[loader] No connection provided for reserve enrichment');
    return pools;
  }
  
  // Collect vault addresses that need fetching
  const vaultsToPools = new Map();
  
  for (const pool of pools) {
    // Skip if already has reserves
    if (hasReserves(pool)) continue;
    
    // Need vault addresses
    if (!pool.vaultX || !pool.vaultY) continue;
    
    try {
      const vaultXPk = new PublicKey(pool.vaultX);
      const vaultYPk = new PublicKey(pool.vaultY);
      
      vaultsToPools.set(pool.vaultX, { pool, isX: true, pubkey: vaultXPk });
      vaultsToPools.set(pool.vaultY, { pool, isX: false, pubkey: vaultYPk });
    } catch (e) {
      // Invalid pubkey, skip
    }
  }
  
  if (vaultsToPools.size === 0) {
    if (log) console.log('[loader] No vaults to fetch (all pools have reserves or no vault addresses)');
    return pools;
  }
  
  if (log) {
    console.log(`[loader] Fetching ${vaultsToPools.size} vault accounts...`);
  }
  
  // Batch fetch
  const vaultAddrs = Array.from(vaultsToPools.keys());
  const vaultPubkeys = vaultAddrs.map(addr => vaultsToPools.get(addr).pubkey);
  
  let updated = 0;
  let failed = 0;
  
  for (let i = 0; i < vaultPubkeys.length; i += batchSize) {
    const batch = vaultPubkeys.slice(i, i + batchSize);
    const batchAddrs = vaultAddrs.slice(i, i + batchSize);
    
    try {
      const accounts = await connection.getMultipleAccountsInfo(batch);
      
      for (let j = 0; j < accounts.length; j++) {
        const acc = accounts[j];
        const addr = batchAddrs[j];
        const { pool, isX } = vaultsToPools.get(addr);
        
        if (acc?.data) {
          try {
            const dataView = new DataView(acc.data.buffer, acc.data.byteOffset);
            const amount = dataView.getBigUint64(64, true);
            
            if (isX) {
              pool.xReserve = amount.toString();
            } else {
              pool.yReserve = amount.toString();
            }
            
            updated++;
          } catch (e) {
            failed++;
          }
        } else {
          failed++;
        }
      }
    } catch (e) {
      if (log) console.warn(`[loader] Batch fetch error: ${e.message}`);
      failed += batch.length;
    }
  }
  
  if (log) {
    console.log(`[loader] Reserves: ${updated} updated, ${failed} failed`);
  }
  
  return pools;
}

// ============================================================================
// MAIN LOADER
// ============================================================================

/**
 * Load and prepare pools for arbitrage scanning
 * 
 * @param {Object} params
 * @param {string} params.filePath - Path to pool JSON file
 * @param {Connection} params.connection - Solana connection for reserve enrichment
 * @param {boolean} params.enrichReservesFlag - Whether to fetch fresh reserves
 * @param {boolean} params.log - Enable logging
 * @returns {Promise<Array>}
 */
async function loadPools({ filePath, connection = null, enrichReservesFlag = true, log = false } = {}) {
  // Load from file
  const pools = loadPoolsFromFile(filePath, { log });
  
  // Enrich reserves if connection provided
  if (enrichReservesFlag && connection) {
    await enrichReserves(pools, connection, { log });
  }
  
  // Final stats
  if (log) {
    const withReserves = pools.filter(hasReserves).length;
    console.log(`[loader] Final: ${pools.length} pools, ${withReserves} with reserves`);
  }
  
  return pools;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  loadPools,
  loadPoolsFromFile,
  enrichReserves,
  normalizePool
};

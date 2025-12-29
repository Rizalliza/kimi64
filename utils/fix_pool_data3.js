#!/usr/bin/env node
/**
 * fix_pool_data3.js (refactored)
 *
 * Generates: output/FINAL_reserves_pool_array_fixed.json
 * - Normalizes poolType/type/dex casing
 * - Promotes vault addresses to top-level (vaultA/vaultB/reserve_x/reserve_y/tokenVaultA/tokenVaultB)
 * - Ensures xReserve/yReserve are the *amounts* (atomic integer strings) when present
 * - Correctly scales Meteora DLMM base_fee_percentage as bps -> fraction (fee = bps/10000)
 * - Optional: --stripAmounts to null out xReserve/yReserve and rely on live fetcher enrichment
 *
 * Usage:
 *   node fix_pool_data3.js --in pools_meta.json --out pools_metaEnriched.json
 *   node fix_pool_data3.js --in output/FINAL_reserves_pool_array.json --out output/FINAL_reserves_pool_array_fixed.json --stripAmounts
 *   node fix_pool_data3.js --in input.json --out output.json --dropOriginal
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const WSOL_MINT = SOL_MINT;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function toStr(v) {
  if (v === undefined || v === null) return '';
  return String(v);
}
function toLowerStr(v) {
  return toStr(v).toLowerCase();
}
function isObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}
function pick(obj, paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (!isObject(cur) || !(part in cur)) { ok = false; break; }
      cur = cur[part];
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}
function asDecIntStr(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return undefined;
    return Math.trunc(v).toString();
  }
  const s = String(v).trim();
  if (!s) return undefined;
  if (s.includes('.')) return s.split('.')[0];
  if (/^-?\d+$/.test(s)) return s;
  return undefined;
}
function asNum(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function normalizePoolType(poolType, dex) {
  const t = toLowerStr(poolType);

  if (t.includes('whirlpool')) return 'clmm';
  if (t.includes('dlmm') || t.includes('liquidity_bins') || t.includes('bin')) return 'dlmm';
  if (t.includes('damm')) return 'cpmm';
  if (t.includes('clmm') || t.includes('concentrated')) return 'clmm';
  if (t.includes('cpmm') || t.includes('amm') || t.includes('constant')) return 'cpmm';

  if (dex === 'orca') return 'clmm';
  if (dex === 'meteora') return 'dlmm';
  if (dex === 'raydium') return 'cpmm';
  return t || 'cpmm';
}

/**
 * Meteora DLMM base_fee_percentage is in bps (e.g. 1.5 => 1.5 bps => 0.00015)
 * => fee = base_fee_percentage / 10000
 */
function inferFeeFraction(pool) {
  const direct = asNum(pool.fee ?? pool.feeRate ?? pool.feePct);
  if (direct !== undefined) return direct;

  const rawFee = pick(pool, [
    'raw.base_fee_percentage',
    '_original.raw.base_fee_percentage',
    '_original.base_fee_percentage',
  ]);
  const rawFeeNum = asNum(rawFee);
  const dex = toLowerStr(pool.dex ?? pool._original?.dex);
  const ptype = normalizePoolType(pool.poolType ?? pool.type ?? pool._original?.poolType, dex);

  if (rawFeeNum !== undefined) {
    if (dex === 'meteora' && ptype === 'dlmm') return rawFeeNum / 10000;

    if (rawFeeNum <= 0.01) return rawFeeNum;        // already fraction
    if (rawFeeNum <= 100) return rawFeeNum / 100;   // percent -> fraction
    return rawFeeNum / 10000;                       // bps -> fraction
  }

  return 0.003;
}

function inferDecimals(mint, symbol, fallback) {
  const m = toStr(mint);
  const s = toStr(symbol).toUpperCase();
  if (m === SOL_MINT || m === WSOL_MINT || s === 'SOL' || s === 'WSOL') return 9;
  if (m === USDC_MINT || s === 'USDC') return 6;
  const f = asNum(fallback);
  if (f !== undefined) return f;
  return 9;
}

function buildToken(meta, side /* 'base' | 'quote' */) {
  const prefix = side === 'base' ? 'x' : 'y';
  const mint = pick(meta, [
    `${side}Token.mint`,
    `${side}Mint`,
    `raw.mint_${prefix}`,
    `_original.raw.mint_${prefix}`,
    `_original.${side}Token.mint`,
  ]);
  const symbol = pick(meta, [
    `${side}Token.symbol`,
    `${side}Symbol`,
    `_original.${side}Token.symbol`,
  ]);
  const dec = pick(meta, [
    `${side}Token.decimals`,
    `${side}Decimals`,
    `priceCalculation.${side}Decimals`,
    `_original.priceCalculation.${side}Decimals`,
    `_original.${side}Token.decimals`,
  ]);
  const decimals = inferDecimals(mint, symbol, dec);
  return { mint: toStr(mint), symbol: toStr(symbol), decimals };
}

function resolveVaults(meta) {
  const reserveX = pick(meta, ['raw.reserve_x', '_original.raw.reserve_x', 'reserve_x', 'vaultA', 'tokenVaultA']);
  const reserveY = pick(meta, ['raw.reserve_y', '_original.raw.reserve_y', 'reserve_y', 'vaultB', 'tokenVaultB']);

  const tokenVaultA = pick(meta, ['raw.tokenVaultA', '_original.raw.tokenVaultA', 'tokenVaultA']);
  const tokenVaultB = pick(meta, ['raw.tokenVaultB', '_original.raw.tokenVaultB', 'tokenVaultB']);

  const vaultA = tokenVaultA || reserveX;
  const vaultB = tokenVaultB || reserveY;

  return {
    reserve_x: reserveX ? toStr(reserveX) : undefined,
    reserve_y: reserveY ? toStr(reserveY) : undefined,
    tokenVaultA: tokenVaultA ? toStr(tokenVaultA) : undefined,
    tokenVaultB: tokenVaultB ? toStr(tokenVaultB) : undefined,
    vaultA: vaultA ? toStr(vaultA) : undefined,
    vaultB: vaultB ? toStr(vaultB) : undefined,
  };
}

function resolveReserveAmounts(meta) {
  const xAmt = pick(meta, [
    'xReserve', 'liquidityX',
    'raw.reserve_x_amount', '_original.raw.reserve_x_amount',
    'reserve_x_amount', 'reserveXAmount',
  ]);
  const yAmt = pick(meta, [
    'yReserve', 'liquidityY',
    'raw.reserve_y_amount', '_original.raw.reserve_y_amount',
    'reserve_y_amount', 'reserveYAmount',
  ]);
  return { xReserve: asDecIntStr(xAmt), yReserve: asDecIntStr(yAmt) };
}

function normalizeOne(pool, opts) {
  if (!isObject(pool)) return null;

  const poolAddress = toStr(
    pool.poolAddress ||
    pool.id ||
    pool.address ||
    pool._original?.id ||
    pool.raw?.address ||
    pool._original?.raw?.address
  );
  if (!poolAddress) return null;

  const dex = toLowerStr(pool.dex || pool._original?.dex || pool.raw?.dex || pool._original?.raw?.dex);
  const poolType = normalizePoolType(pool.poolType || pool.type || pool._original?.poolType || pool.raw?.poolType, dex);

  // Ensure we have a top-level raw if _original.raw exists (helps your fetcher even if _original gets dropped later)
  const raw = isObject(pool.raw) ? pool.raw : (isObject(pool._original?.raw) ? pool._original.raw : undefined);

  const baseToken0 = buildToken({ ...pool, raw, _original: pool._original }, 'base');
  const quoteToken0 = buildToken({ ...pool, raw, _original: pool._original }, 'quote');

  const baseMint = baseToken0.mint || toStr(pool.baseMint);
  const quoteMint = quoteToken0.mint || toStr(pool.quoteMint);

  const baseDecimals = inferDecimals(
    baseMint,
    baseToken0.symbol,
    pool.baseDecimals ?? pool._original?.baseDecimals ?? pool.priceCalculation?.baseDecimals ?? pool._original?.priceCalculation?.baseDecimals
  );
  const quoteDecimals = inferDecimals(
    quoteMint,
    quoteToken0.symbol,
    pool.quoteDecimals ?? pool._original?.quoteDecimals ?? pool.priceCalculation?.quoteDecimals ?? pool._original?.priceCalculation?.quoteDecimals
  );

  const fee = inferFeeFraction({ ...pool, dex, poolType, raw, _original: pool._original });

  const tvlNum = asNum(pick(pool, ['tvl.tvl', 'liquidity.tvl', 'tvl', '_original.liquidity.tvl', '_original.tvl.tvl', '_original.tvl']));
  const volume24h = asNum(pick(pool, ['volume24h', '_original.volume24h', 'raw.trade_volume_24h', '_original.raw.trade_volume_24h'])) ?? 0;

  const vaults = resolveVaults({ ...pool, raw, _original: pool._original });
  const { xReserve, yReserve } = resolveReserveAmounts({ ...pool, raw, _original: pool._original });

  const keepAmounts = !opts.stripAmounts;

  const out = {
    poolAddress,
    id: poolAddress,
    dex,
    poolType,
    type: poolType,

    baseToken: { mint: baseMint, symbol: baseToken0.symbol, decimals: baseDecimals },
    quoteToken: { mint: quoteMint, symbol: quoteToken0.symbol, decimals: quoteDecimals },
    baseMint,
    quoteMint,
    baseDecimals,
    quoteDecimals,

    fee,
    tvl: tvlNum !== undefined ? (pool.tvl && typeof pool.tvl === 'object' ? pool.tvl : { tvl: tvlNum }) : (pool.tvl || pool.liquidity || null),
    volume24h,

    // vaults for fetcher
    ...Object.fromEntries(Object.entries(vaults).filter(([, v]) => v)),

    // cached amounts (strings or null; never floats)
    xReserve: keepAmounts ? (xReserve ?? null) : null,
    yReserve: keepAmounts ? (yReserve ?? null) : null,
    liquidityX: keepAmounts ? (xReserve ?? null) : null,
    liquidityY: keepAmounts ? (yReserve ?? null) : null,

    _original: opts.dropOriginal ? undefined : (pool._original || pool),
    raw: opts.dropOriginal ? undefined : raw,

    hasFullMetadata: true,
    dataSource: pool.dataSource || 'FINAL_reserves_pool_array_fixed',
  };

  if (out.xReserve !== null && out.xReserve !== undefined) out.xReserve = toStr(out.xReserve);
  if (out.yReserve !== null && out.yReserve !== undefined) out.yReserve = toStr(out.yReserve);
  if (out.liquidityX !== null && out.liquidityX !== undefined) out.liquidityX = toStr(out.liquidityX);
  if (out.liquidityY !== null && out.liquidityY !== undefined) out.liquidityY = toStr(out.liquidityY);

  if (!out.baseToken.symbol) out.baseToken.symbol = (out.baseMint === SOL_MINT) ? 'SOL' : 'UNKNOWN';
  if (!out.quoteToken.symbol) out.quoteToken.symbol = (out.quoteMint === USDC_MINT) ? 'USDC' : 'UNKNOWN';

  return out;
}

function parseArgs(argv) {
  const out = { in: null, out: null, stripAmounts: false, dropOriginal: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in' && argv[i + 1]) { out.in = argv[++i]; continue; }
    if (a === '--out' && argv[i + 1]) { out.out = argv[++i]; continue; }
    if (a === '--stripAmounts') { out.stripAmounts = true; continue; }
    if (a === '--dropOriginal') { out.dropOriginal = true; continue; }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);

  const inputPath = args.in || path.join(process.cwd(), 'output', 'FINAL_reserves_pool_array.json');
  const outputPath = args.out || path.join(process.cwd(), 'output', 'FINAL_reserves_pool_array_fixed.json');

  if (!fs.existsSync(inputPath)) {
    console.error('[fix_pool_data3] Input JSON not found:', inputPath);
    process.exit(1);
  }

  const rawText = fs.readFileSync(inputPath, 'utf8');
  let arr;
  try {
    arr = JSON.parse(rawText);
  } catch (e) {
    console.error('[fix_pool_data3] Failed to parse JSON:', e.message);
    process.exit(1);
  }

  if (!Array.isArray(arr)) {
    console.error('[fix_pool_data3] Input must be an array of pools.');
    process.exit(1);
  }

  const opts = { stripAmounts: args.stripAmounts, dropOriginal: args.dropOriginal };

  let kept = 0;
  let dropped = 0;

  const fixed = [];
  for (const p of arr) {
    const n = normalizeOne(p, opts);
    if (!n) { dropped++; continue; }
    fixed.push(n);
    kept++;
  }

  const byDex = {};
  const byType = {};
  let withAmounts = 0;

  for (const p of fixed) {
    byDex[p.dex] = (byDex[p.dex] || 0) + 1;
    byType[p.poolType] = (byType[p.poolType] || 0) + 1;
    if (p.xReserve && p.yReserve) withAmounts++;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(fixed, null, 2), 'utf8');

  console.log('[fix_pool_data3] Done.');
  console.log(`  Input pools:  ${arr.length}`);
  console.log(`  Output pools: ${kept}  (dropped: ${dropped})`);
  console.log(`  With cached amounts: ${withAmounts}/${kept}  (stripAmounts=${opts.stripAmounts})`);
  console.log('  By DEX:', byDex);
  console.log('  By Type:', byType);
  console.log('  Output:', outputPath);
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizePoolType,
  inferFeeFraction,
  normalizeOne,
};

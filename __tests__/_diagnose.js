#!/usr/bin/env node
'use strict';
/**
 * _diagnose.js - Pool Data Diagnostic Tool
 * 
 * Analyzes pool JSON to identify why certain DEXes might not appear in routes.
 * 
 * Usage:
 *   node _diagnose.js poolMeta/samplePools_rawCanonicalize.json
 *    node _diagnose.js poolsMeta/mData_metPool.json
 *  node _diagnose.js poolsMeta/mData_orcaPool.json
 * node _diagnose.js poolsMeta/metaEnrichedTrimmed.json
 */


'use strict';
/**
 * _diagnose.js - Pool Data Diagnostic Tool
 * 
 * Analyzes pool JSON to identify why certain DEXes might not appear in routes.
 * 
 * Usage:
 *   node _diagnose.js <pools.json>
 */

const fs = require('fs');
const path = require('path');

const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

function normalizeType(raw) {
  const t = (raw?.type || raw?.poolType || '').toString().toLowerCase();
  if (t.includes('dlmm') || t.includes('bin')) return 'dlmm';
  if (t.includes('whirlpool')) return 'whirlpool';
  if (t.includes('clmm') || t.includes('concentrated')) return 'clmm';
  if (t.includes('cpmm') || t.includes('amm')) return 'cpmm';
  return 'unknown';
}

function normalizeDex(raw) {
  const d = (raw?.dex || raw?.source || '').toString().toLowerCase();
  if (d.includes('meteora')) return 'meteora';
  if (d.includes('orca')) return 'orca';
  if (d.includes('raydium')) return 'raydium';
  return 'unknown';
}

function hasReserves(p) {
  const x = parseFloat(p?.xReserve || p?.reserve_x_amount || p?.liquidityX || 0);
  const y = parseFloat(p?.yReserve || p?.reserve_y_amount || p?.liquidityY || 0);
  return x > 0 && y > 0;
}

function getMints(p) {
  const baseMint = p.baseMint || p.mint_x || p.mintA || p.baseToken?.mint || null;
  const quoteMint = p.quoteMint || p.mint_y || p.mintB || p.quoteToken?.mint || null;
  return { baseMint, quoteMint };
}

function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.log('Usage: node _diagnose.js <pools.json>');
    process.exit(1);
  }

  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  const content = fs.readFileSync(abs, 'utf8');
  let json = JSON.parse(content);

  // Normalize to array
  if (!Array.isArray(json)) {
    if (json.pools) json = json.pools;
    else if (json.data) json = json.data;
    else json = Object.values(json);
  }

  console.log('═'.repeat(60));
  console.log('POOL DATA DIAGNOSTIC');
  console.log('═'.repeat(60));
  console.log(`\nFile: ${path.basename(filePath)}`);
  console.log(`Total pools: ${json.length}`);

  // Analyze by type
  const byType = { dlmm: [], whirlpool: [], clmm: [], cpmm: [], unknown: [] };
  const byDex = { meteora: [], orca: [], raydium: [], unknown: [] };

  for (const p of json) {
    const type = normalizeType(p);
    const dex = normalizeDex(p);
    byType[type] = byType[type] || [];
    byType[type].push(p);
    byDex[dex] = byDex[dex] || [];
    byDex[dex].push(p);
  }

  console.log('\n📊 By Type:');
  for (const [type, pools] of Object.entries(byType)) {
    if (pools.length === 0) continue;
    const withReserves = pools.filter(hasReserves).length;
    console.log(`   ${type}: ${pools.length} (${withReserves} with reserves)`);
  }

  console.log('\n📊 By DEX:');
  for (const [dex, pools] of Object.entries(byDex)) {
    if (pools.length === 0) continue;
    const withReserves = pools.filter(hasReserves).length;
    console.log(`   ${dex}: ${pools.length} (${withReserves} with reserves)`);
  }

  // Analyze SOL/USDC pairs
  console.log('\n🔍 SOL/USDC Pair Analysis:');

  for (const [type, pools] of Object.entries(byType)) {
    if (pools.length === 0) continue;

    const solPools = pools.filter(p => {
      const { baseMint, quoteMint } = getMints(p);
      return baseMint === TOKENS.SOL || quoteMint === TOKENS.SOL;
    });

    const usdcPools = pools.filter(p => {
      const { baseMint, quoteMint } = getMints(p);
      return baseMint === TOKENS.USDC || quoteMint === TOKENS.USDC;
    });

    const solUsdcDirect = pools.filter(p => {
      const { baseMint, quoteMint } = getMints(p);
      return (baseMint === TOKENS.SOL && quoteMint === TOKENS.USDC) ||
        (baseMint === TOKENS.USDC && quoteMint === TOKENS.SOL);
    });

    console.log(`\n   ${type.toUpperCase()} (${pools.length} pools):`);
    console.log(`      With SOL: ${solPools.length}`);
    console.log(`      With USDC: ${usdcPools.length}`);
    console.log(`      SOL/USDC direct: ${solUsdcDirect.length}`);

    if (solPools.length === 0 && usdcPools.length === 0) {
      console.log(`      ⚠️  NO SOL OR USDC PAIRS - cannot form triangular routes!`);
    } else if (solUsdcDirect.length === 0) {
      console.log(`      ⚠️  No direct SOL/USDC - need intermediate tokens`);
    }

    // Show sample of B tokens available
    if (solPools.length > 0) {
      const bTokens = new Set();
      for (const p of solPools.slice(0, 50)) {
        const { baseMint, quoteMint } = getMints(p);
        const other = baseMint === TOKENS.SOL ? quoteMint : baseMint;
        if (other && other !== TOKENS.SOL && other !== TOKENS.USDC) {
          bTokens.add(other?.slice(0, 8) + '...');
        }
      }
      if (bTokens.size > 0) {
        console.log(`      Sample B tokens: ${Array.from(bTokens).slice(0, 5).join(', ')}`);
      }
    }
  }

  // Check for potential issues
  console.log('\n🔧 Potential Issues:');

  // Check decimals
  const badDecimals = json.filter(p => {
    const bd = p.baseDecimals ?? p.baseToken?.decimals;
    const qd = p.quoteDecimals ?? p.quoteToken?.decimals;
    return bd === undefined || qd === undefined;
  });
  if (badDecimals.length > 0) {
    console.log(`   ⚠️  ${badDecimals.length} pools missing decimals`);
  }

  // Check for missing reserves
  const noReserves = json.filter(p => !hasReserves(p));
  if (noReserves.length > 0) {
    console.log(`   ⚠️  ${noReserves.length} pools without reserves`);
    // Break down by type
    for (const [type, pools] of Object.entries(byType)) {
      const missing = pools.filter(p => !hasReserves(p)).length;
      if (missing > 0) {
        console.log(`      ${type}: ${missing} missing`);
      }
    }
  }

  // Check for missing vault addresses (needed for enrichment)
  const noVaults = json.filter(p => {
    const vx = p.vaultX || p.reserve_x || p.tokenVaultA;
    const vy = p.vaultY || p.reserve_y || p.tokenVaultB;
    return !vx || !vy;
  });
  if (noVaults.length > 0) {
    console.log(`   ⚠️  ${noVaults.length} pools without vault addresses (cannot enrich)`);
  }

  // Recommendations
  console.log('\n💡 Recommendations:');

  const cpmmSolPools = (byType.cpmm || []).filter(p => {
    const { baseMint, quoteMint } = getMints(p);
    return baseMint === TOKENS.SOL || quoteMint === TOKENS.SOL;
  });

  const cpmmUsdcPools = (byType.cpmm || []).filter(p => {
    const { baseMint, quoteMint } = getMints(p);
    return baseMint === TOKENS.USDC || quoteMint === TOKENS.USDC;
  });

  if (cpmmSolPools.length === 0 || cpmmUsdcPools.length === 0) {
    console.log('   1. Fetch more CPMM pools with SOL/USDC pairs from Raydium API');
    console.log('      Example: https://api-v3.raydium.io/pools/info/list?poolType=standard&pageSize=100');
  }

  if ((byType.whirlpool || []).length === 0) {
    console.log('   2. Add Orca Whirlpool data from Orca API');
    console.log('      Example: https://api.mainnet.orca.so/v1/whirlpool/list');
  }

  if (noReserves.length > json.length * 0.5) {
    console.log('   3. Run with reserve enrichment enabled (remove --no-enrich flag)');
  }

  console.log('\n' + '═'.repeat(60));
}

main();

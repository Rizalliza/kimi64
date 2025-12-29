#!/usr/bin/env node
'use strict';
/**
 * _diagnose_pools.js - Understand why pool types aren't in routes
 * 
 * Usage: node _diagnose_pools.js output/metaEnrichedTrimmed.json
 * 
 * node _diagnose_pools.js _pools_enriched_test.json
 */

const fs = require('fs');
const path = require('path');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function shortMint(m) {
  return m ? `${m.slice(0, 6)}...${m.slice(-4)}` : '???';
}

function normalizeType(pool) {
  const t = (pool?.type || pool?.poolType || '').toLowerCase();
  if (t.includes('dlmm')) return 'dlmm';
  if (t.includes('whirlpool')) return 'whirlpool';
  if (t.includes('clmm')) return 'clmm';
  if (t.includes('cpmm') || t.includes('amm')) return 'cpmm';
  return 'cpmm';
}

function hasReserves(pool) {
  const x = parseFloat(pool?.xReserve || pool?.reserve_x_amount || 0);
  const y = parseFloat(pool?.yReserve || pool?.reserve_y_amount || 0);
  return x > 0 && y > 0;
}

function diagnose(filePath) {
  console.log('═'.repeat(70));
  console.log('POOL COMPOSITION DIAGNOSTIC');
  console.log('═'.repeat(70));

  // Load pools
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const pools = Array.isArray(raw) ? raw : (raw.pools || raw.data || Object.values(raw));

  console.log(`\nLoaded ${pools.length} pools\n`);

  // Group by type
  const byType = { dlmm: [], whirlpool: [], clmm: [], cpmm: [] };

  for (const p of pools) {
    const type = normalizeType(p);
    if (byType[type]) {
      byType[type].push(p);
    }
  }

  // =========================================================================
  // 1. Overview
  // =========================================================================
  console.log('[1] POOL COUNT BY TYPE');
  console.log('-'.repeat(70));
  for (const [type, arr] of Object.entries(byType)) {
    console.log(`  ${type.toUpperCase()}: ${arr.length} pools`);
  }

  // =========================================================================
  // 2. SOL/USDC availability per type
  // =========================================================================
  console.log('\n[2] SOL/USDC PAIRS PER TYPE');
  console.log('-'.repeat(70));

  for (const [type, arr] of Object.entries(byType)) {
    if (arr.length === 0) continue;

    const withSol = arr.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    const withUsdc = arr.filter(p => p.baseMint === USDC || p.quoteMint === USDC);
    const solUsdc = arr.filter(p =>
      (p.baseMint === SOL && p.quoteMint === USDC) ||
      (p.baseMint === USDC && p.quoteMint === SOL)
    );
    const withReserves = arr.filter(hasReserves);

    console.log(`\n  ${type.toUpperCase()} (${arr.length} pools):`);
    console.log(`    With reserves: ${withReserves.length}`);
    console.log(`    With SOL: ${withSol.length}`);
    console.log(`    With USDC: ${withUsdc.length}`);
    console.log(`    SOL/USDC direct: ${solUsdc.length}`);

    if (withSol.length === 0 && withUsdc.length === 0) {
      console.log(`    ⚠️  NO SOL OR USDC PAIRS - cannot form triangular routes!`);
    }
  }

  // =========================================================================
  // 3. Sample pools per type
  // =========================================================================
  console.log('\n[3] SAMPLE POOLS PER TYPE');
  console.log('-'.repeat(70));

  for (const [type, arr] of Object.entries(byType)) {
    if (arr.length === 0) continue;

    console.log(`\n  ${type.toUpperCase()} samples:`);

    // Show up to 3 samples
    for (const p of arr.slice(0, 3)) {
      const base = shortMint(p.baseMint);
      const quote = shortMint(p.quoteMint);
      console.log(`    ${shortMint(p.poolAddress)} | ${base} / ${quote}`);
    }
  }

  // =========================================================================
  // 4. CPMM Deep Dive
  // =========================================================================
  const cpmmPools = byType.cpmm;
  if (cpmmPools.length > 0) {
    console.log('\n[4] CPMM DEEP DIVE');
    console.log('-'.repeat(70));

    // Get all unique tokens in CPMM
    const cpmmTokens = new Set();
    for (const p of cpmmPools) {
      if (p.baseMint) cpmmTokens.add(p.baseMint);
      if (p.quoteMint) cpmmTokens.add(p.quoteMint);
    }

    console.log(`  Unique tokens in CPMM pools: ${cpmmTokens.size}`);
    console.log(`  Has SOL: ${cpmmTokens.has(SOL) ? 'YES' : 'NO'}`);
    console.log(`  Has USDC: ${cpmmTokens.has(USDC) ? 'YES' : 'NO'}`);

    // Check if any CPMM pool has SOL or USDC
    const cpmmWithSol = cpmmPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    const cpmmWithUsdc = cpmmPools.filter(p => p.baseMint === USDC || p.quoteMint === USDC);

    if (cpmmWithSol.length > 0) {
      console.log(`\n  CPMM pools with SOL (${cpmmWithSol.length}):`);
      for (const p of cpmmWithSol.slice(0, 5)) {
        const other = p.baseMint === SOL ? p.quoteMint : p.baseMint;
        console.log(`    ${shortMint(p.poolAddress)} | SOL / ${shortMint(other)}`);
      }
    } else {
      console.log(`\n  ❌ NO CPMM pools have SOL!`);
    }

    if (cpmmWithUsdc.length > 0) {
      console.log(`\n  CPMM pools with USDC (${cpmmWithUsdc.length}):`);
      for (const p of cpmmWithUsdc.slice(0, 5)) {
        const other = p.baseMint === USDC ? p.quoteMint : p.baseMint;
        console.log(`    ${shortMint(p.poolAddress)} | USDC / ${shortMint(other)}`);
      }
    } else {
      console.log(`\n  ❌ NO CPMM pools have USDC!`);
    }

    // Check reserves
    const cpmmWithReserves = cpmmPools.filter(hasReserves);
    console.log(`\n  CPMM with reserves: ${cpmmWithReserves.length}/${cpmmPools.length}`);

    if (cpmmWithReserves.length === 0) {
      console.log(`  ❌ NO CPMM pools have reserves - they can't be simulated!`);
      const sample = cpmmPools[0];
      console.log(`  Sample pool reserves:`);
      console.log(`    xReserve: ${sample.xReserve}`);
      console.log(`    yReserve: ${sample.yReserve}`);
      console.log(`    reserve_x_amount: ${sample.reserve_x_amount}`);
      console.log(`    reserve_y_amount: ${sample.reserve_y_amount}`);
      if (sample.raw) {
        console.log(`    raw.reserve_x_amount: ${sample.raw.reserve_x_amount}`);
        console.log(`    raw.reserve_y_amount: ${sample.raw.reserve_y_amount}`);
      }
    }
  }

  // =========================================================================
  // 5. CLMM Deep Dive
  // =========================================================================
  const clmmPools = byType.clmm;
  if (clmmPools.length > 0) {
    console.log('\n[5] CLMM DEEP DIVE');
    console.log('-'.repeat(70));

    const clmmWithSol = clmmPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    const clmmWithUsdc = clmmPools.filter(p => p.baseMint === USDC || p.quoteMint === USDC);

    console.log(`  CLMM with SOL: ${clmmWithSol.length}`);
    console.log(`  CLMM with USDC: ${clmmWithUsdc.length}`);

    if (clmmWithSol.length > 0) {
      console.log(`\n  CLMM pools with SOL:`);
      for (const p of clmmWithSol.slice(0, 5)) {
        const other = p.baseMint === SOL ? p.quoteMint : p.baseMint;
        console.log(`    ${shortMint(p.poolAddress)} | SOL / ${shortMint(other)}`);
      }
    }
  }

  // =========================================================================
  // 6. RECOMMENDATIONS
  // =========================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('RECOMMENDATIONS');
  console.log('═'.repeat(70));

  const issues = [];

  // Check CPMM
  if (cpmmPools.length > 0) {
    const cpmmWithSol = cpmmPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    const cpmmWithUsdc = cpmmPools.filter(p => p.baseMint === USDC || p.quoteMint === USDC);
    const cpmmWithReserves = cpmmPools.filter(hasReserves);

    if (cpmmWithSol.length === 0 && cpmmWithUsdc.length === 0) {
      issues.push('CPMM pools have NO SOL or USDC pairs - fetch Raydium pools with SOL/USDC');
    } else if (cpmmWithReserves.length === 0) {
      issues.push('CPMM pools have no reserves - check _loader.js reserve extraction');
    }
  }

  // Check CLMM
  if (clmmPools.length > 0) {
    const clmmWithSol = clmmPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    if (clmmWithSol.length === 0) {
      issues.push('CLMM pools have no SOL pairs - fetch Raydium CLMM pools with SOL');
    }
  }

  // Check Whirlpool
  if (byType.whirlpool.length === 0) {
    issues.push('No Whirlpool pools in data - fetch from Orca API');
  }

  if (issues.length === 0) {
    console.log('\n✓ Pool data looks complete for triangular arbitrage');
  } else {
    console.log('\n🔴 Issues preventing cross-DEX routes:\n');
    for (const issue of issues) {
      console.log(`   • ${issue}`);
    }
    console.log('\n💡 Solution: Fetch additional pool data that includes:');
    console.log('   - Raydium CPMM: SOL/X and X/USDC pools');
    console.log('   - Raydium CLMM: SOL/X and X/USDC pools');
    console.log('   - Orca Whirlpool: SOL/X and X/USDC pools');
  }

  console.log('\n' + '═'.repeat(70));
}

// Run
const filePath = process.argv[2];
if (!filePath) {
  console.log('Usage: node _diagnose_pools.js <pools.json>');
  process.exit(1);
}

diagnose(filePath);

//  node _diagnose_pools.js pool_orca_only.json
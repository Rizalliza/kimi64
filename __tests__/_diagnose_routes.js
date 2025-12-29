#!/usr/bin/env node
'use strict';
/**
 * _diagnose_routes.js - Why aren't certain pool types in routes?
 * 
 * Usage: node _diagnose_routes.js pools_enriched.json
 */
const { PublicKey, Connection } = require('@solana/web3.js');
const { D, normalizeType, normalizeDex, hasReserves, TOKENS, shortMint } = require('./_utils');
const { loadPoolsFromFile } = require('./_loader');


const opts = {
  input: null,
  output: 'pools_enriched.json',
  rpcUrl: process.env.RPC_URL || 'https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy',
  batchSize: 100,
  forceRefresh: false,
};
const connection = new Connection(opts.rpcUrl, {
  rpcUrl: process.env.RPC_URL || 'https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy',
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 30000,

});
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function diagnose(filePath) {
  console.log('═'.repeat(70));
  console.log('ROUTE COMPOSITION DIAGNOSTIC');
  console.log('═'.repeat(70));

  const pools = loadPoolsFromFile(filePath, { log: false });
  console.log(`\nLoaded ${pools.length} pools\n`);

  // =========================================================================
  // 1. POOLS BY TYPE WITH SOL/USDC
  // =========================================================================
  console.log('[1] POOLS WITH SOL OR USDC BY TYPE');
  console.log('-'.repeat(70));

  const types = ['dlmm', 'whirlpool', 'clmm', 'cpmm'];

  for (const type of types) {
    const typePools = pools.filter(p => p.type === type);
    const withSol = typePools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    const withUsdc = typePools.filter(p => p.baseMint === USDC || p.quoteMint === USDC);
    const withReservesCount = typePools.filter(hasReserves).length;
    const solUsdc = typePools.filter(p =>
      (p.baseMint === SOL && p.quoteMint === USDC) ||
      (p.baseMint === USDC && p.quoteMint === SOL)
    );

    console.log(`\n${type.toUpperCase()}:`);
    console.log(`  Total: ${typePools.length}`);
    console.log(`  With reserves: ${withReservesCount}`);
    console.log(`  With SOL: ${withSol.length}`);
    console.log(`  With USDC: ${withUsdc.length}`);
    console.log(`  Direct SOL/USDC: ${solUsdc.length}`);

    if (typePools.length > 0 && withSol.length === 0 && withUsdc.length === 0) {
      console.log(`  ⚠️  No SOL or USDC pools - won't appear in SOL→B→USDC routes`);
    }
  }

  // =========================================================================
  // 2. B CANDIDATES BY POOL TYPE
  // =========================================================================
  console.log('\n' + '-'.repeat(70));
  console.log('[2] B CANDIDATES (INTERMEDIATE TOKENS) BY POOL TYPE');
  console.log('-'.repeat(70));

  // Find all B tokens that can form routes
  const bCandidates = new Map(); // bMint -> { types: Set, abPools: [], bcPools: [] }

  for (const pool of pools) {
    const hasSol = pool.baseMint === SOL || pool.quoteMint === SOL;
    const hasUsdc = pool.baseMint === USDC || pool.quoteMint === USDC;

    if (hasSol && !hasUsdc) {
      // This is an A-B pool (SOL to something)
      const bMint = pool.baseMint === SOL ? pool.quoteMint : pool.baseMint;
      if (!bCandidates.has(bMint)) {
        bCandidates.set(bMint, { types: new Set(), abPools: [], bcPools: [] });
      }
      bCandidates.get(bMint).types.add(pool.type);
      bCandidates.get(bMint).abPools.push(pool);
    }

    if (hasUsdc && !hasSol) {
      // This could be a B-C pool (something to USDC)
      const otherMint = pool.baseMint === USDC ? pool.quoteMint : pool.baseMint;
      if (bCandidates.has(otherMint)) {
        bCandidates.get(otherMint).bcPools.push(pool);
      }
    }
  }

  // Also need C-A pools (USDC to SOL)
  const caPools = pools.filter(p =>
    (p.baseMint === SOL && p.quoteMint === USDC) ||
    (p.baseMint === USDC && p.quoteMint === SOL)
  );

  console.log(`\nC→A pools (USDC→SOL): ${caPools.length}`);
  for (const p of caPools) {
    console.log(`  ${p.type} | ${p.dex} | ${shortMint(p.poolAddress)}`);
  }

  // Filter to valid routes
  const validBs = [];
  for (const [bMint, data] of bCandidates) {
    if (data.abPools.length > 0 && data.bcPools.length > 0 && caPools.length > 0) {
      validBs.push({ bMint, ...data });
    }
  }

  console.log(`\nValid B tokens (have A→B and B→C pools): ${validBs.length}`);

  // Group by pool type combinations
  const routesByTypes = new Map();

  for (const { bMint, abPools, bcPools } of validBs) {
    for (const ab of abPools) {
      for (const bc of bcPools) {
        for (const ca of caPools) {
          const key = `${ab.type}→${bc.type}→${ca.type}`;
          if (!routesByTypes.has(key)) {
            routesByTypes.set(key, []);
          }
          routesByTypes.get(key).push({ bMint, ab, bc, ca });
        }
      }
    }
  }

  console.log(`\nPossible route type combinations:`);
  const sortedCombos = Array.from(routesByTypes.entries()).sort((a, b) => b[1].length - a[1].length);

  for (const [combo, routes] of sortedCombos.slice(0, 15)) {
    console.log(`  ${combo}: ${routes.length} routes`);
  }

  // =========================================================================
  // 3. WHY CPMM ISN'T IN ROUTES
  // =========================================================================
  console.log('\n' + '-'.repeat(70));
  console.log('[3] CPMM ROUTE ANALYSIS');
  console.log('-'.repeat(70));

  const cpmmPools = pools.filter(p => p.type === 'cpmm');
  const cpmmSol = cpmmPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
  const cpmmUsdc = cpmmPools.filter(p => p.baseMint === USDC || p.quoteMint === USDC);
  const cpmmSolUsdc = cpmmPools.filter(p =>
    (p.baseMint === SOL && p.quoteMint === USDC) ||
    (p.baseMint === USDC && p.quoteMint === SOL)
  );

  console.log(`CPMM total: ${cpmmPools.length}`);
  console.log(`CPMM with SOL: ${cpmmSol.length}`);
  console.log(`CPMM with USDC: ${cpmmUsdc.length}`);
  console.log(`CPMM SOL/USDC direct: ${cpmmSolUsdc.length}`);

  if (cpmmSol.length === 0) {
    console.log(`\n⚠️  No CPMM pools have SOL - can't use for A→B leg`);
  }
  if (cpmmUsdc.length === 0) {
    console.log(`⚠️  No CPMM pools have USDC - can't use for B→C leg`);
  }
  if (cpmmSolUsdc.length === 0) {
    console.log(`⚠️  No CPMM SOL/USDC pools - can't use for C→A leg`);
  }

  // Check reserves on CPMM
  const cpmmWithReserves = cpmmPools.filter(hasReserves);
  console.log(`\nCPMM with reserves: ${cpmmWithReserves.length}/${cpmmPools.length}`);

  if (cpmmWithReserves.length === 0 && cpmmPools.length > 0) {
    console.log(`\n❌ CPMM pools have no reserves - they're filtered out!`);
    console.log(`   Sample CPMM pool:`);
    const sample = cpmmPools[0];
    console.log(`   xReserve: ${sample.xReserve}`);
    console.log(`   yReserve: ${sample.yReserve}`);
  }

  // =========================================================================
  // 4. WHY WHIRLPOOL ISN'T IN ROUTES
  // =========================================================================
  console.log('\n' + '-'.repeat(70));
  console.log('[4] WHIRLPOOL ROUTE ANALYSIS');
  console.log('-'.repeat(70));

  const wpPools = pools.filter(p => p.type === 'whirlpool');
  const wpSol = wpPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
  const wpUsdc = wpPools.filter(p => p.baseMint === USDC || p.quoteMint === USDC);
  const wpSolUsdc = wpPools.filter(p =>
    (p.baseMint === SOL && p.quoteMint === USDC) ||
    (p.baseMint === USDC && p.quoteMint === SOL)
  );

  console.log(`Whirlpool total: ${wpPools.length}`);
  console.log(`Whirlpool with SOL: ${wpSol.length}`);
  console.log(`Whirlpool with USDC: ${wpUsdc.length}`);
  console.log(`Whirlpool SOL/USDC direct: ${wpSolUsdc.length}`);

  // Check SDK availability
  console.log(`\nChecking Orca SDK availability...`);
  try {
    require.resolve('@orca-so/whirlpools-sdk');
    console.log(`✓ @orca-so/whirlpools-sdk is installed`);
  } catch {
    console.log(`❌ @orca-so/whirlpools-sdk is NOT installed`);
    console.log(`   Whirlpool pools require SDK - run: npm install @orca-so/whirlpools-sdk`);
  }

  // =========================================================================
  // 5. WHY CLMM ISN'T IN ROUTES
  // =========================================================================
  console.log('\n' + '-'.repeat(70));
  console.log('[5] CLMM ROUTE ANALYSIS');
  console.log('-'.repeat(70));

  const clmmPools = pools.filter(p => p.type === 'clmm');
  console.log(`CLMM total: ${clmmPools.length}`);

  if (clmmPools.length > 0) {
    const clmmSol = clmmPools.filter(p => p.baseMint === SOL || p.quoteMint === SOL);
    const clmmUsdc = clmmPools.filter(p => p.baseMint === USDC || p.quoteMint === USDC);
    console.log(`CLMM with SOL: ${clmmSol.length}`);
    console.log(`CLMM with USDC: ${clmmUsdc.length}`);
  }

  console.log(`\nChecking Raydium SDK availability...`);
  try {
    require.resolve('@raydium-io/raydium-sdk-v2');
    console.log(`✓ @raydium-io/raydium-sdk-v2 is installed`);
  } catch {
    console.log(`❌ @raydium-io/raydium-sdk-v2 is NOT installed`);
    console.log(`   CLMM pools require SDK - run: npm install @raydium-io/raydium-sdk-v2`);
  }

  // =========================================================================
  // 6. RECOMMENDATIONS
  // =========================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('RECOMMENDATIONS');
  console.log('═'.repeat(70));

  const recommendations = [];

  // CPMM
  if (cpmmPools.length > 0 && cpmmWithReserves.length === 0) {
    recommendations.push('CPMM pools have no reserves - check _loader.js reserve extraction');
  } else if (cpmmSol.length === 0 && cpmmUsdc.length === 0) {
    recommendations.push('CPMM pools don\'t have SOL/USDC pairs in your data');
  }

  // Whirlpool
  try {
    require.resolve('@orca-so/whirlpools-sdk');
  } catch {
    recommendations.push('Install Orca SDK: npm install @orca-so/whirlpools-sdk @orca-so/common-sdk');
  }

  // CLMM
  try {
    require.resolve('@raydium-io/raydium-sdk-v2');
  } catch {
    recommendations.push('Install Raydium SDK: npm install @raydium-io/raydium-sdk-v2');
  }

  // Routes
  const hasNonDlmmRoutes = sortedCombos.some(([combo]) => !combo.includes('dlmm') || combo.split('→').length > combo.match(/dlmm/g)?.length);
  if (!hasNonDlmmRoutes && sortedCombos.length > 0) {
    recommendations.push('Only DLMM routes are possible - add more pool types with SOL/USDC pairs');
  }

  if (recommendations.length === 0) {
    console.log('\n✓ No obvious issues - pool types should be in routes');
  } else {
    for (const rec of recommendations) {
      console.log(`\n⚠️  ${rec}`);
    }
  }

  console.log('\n');
}

// Run
const filePath = process.argv[2];
if (!filePath) {
  console.log('Usage: node _diagnose_routes.js <pools.json>');
  process.exit(1);
}

diagnose(filePath);

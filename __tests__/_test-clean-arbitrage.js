#!/usr/bin/env node
'use strict';

/**
 * Clean test runner for the new triangular arbitrage engine
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const tri = require('./_triangularArbitrage');
const { Connection, PublicKey } = require('@solana/web3.js');
const { TOKENS } = require('./_utils');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy';

async function main() {
  // Load pools
  const poolsPath = path.join(__dirname, 'pools.json');
  if (!fs.existsSync(poolsPath)) {
    console.error('❌ pools.json not found');
    process.exit(1);
  }

  const pools = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
  console.log(`📦 Loaded ${pools.length} pools`);

  // Initialize SDK
  const connection = new Connection(RPC_URL, 'confirmed');
  const sdk = require('./_sdk');
  
  console.log('\n🔌 Initializing SDK...');
  await sdk.initialize(connection);
  console.log('✅ SDK ready');

  // Find routes
  const inputAtomic = '10000000000'; // 10 SOL
  
  const routes = await tri.findArbitrageRoutes(pools, inputAtomic, {
    tokenA: TOKENS.SOL,
    tokenC: TOKENS.USDC,
    maxRoutes: 50,
    maxImpactPct: 5,
    logVerbose: true
  });

  // Save results
  const resultsPath = path.join(__dirname, 'clean_routes.json');
  fs.writeFileSync(resultsPath, JSON.stringify(routes, null, 2));
  console.log(`\n💾 Results saved to: ${resultsPath}`);

  // Print multi-DEX analysis
  if (routes.length > 0) {
    console.log('\n📈 Multi-DEX Analysis:');
    
    const dexCombos = {};
    for (const r of routes) {
      const combo = r.route.dexes.join('→');
      dexCombos[combo] = (dexCombos[combo] || 0) + 1;
    }

    const sorted = Object.entries(dexCombos).sort((a, b) => b[1] - a[1]);
    for (const [combo, count] of sorted) {
      console.log(`   ${combo}: ${count} routes`);
    }
  }
}

main().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});

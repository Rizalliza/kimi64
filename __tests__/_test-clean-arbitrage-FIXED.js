#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const tri = require('./_triangularArbitrage');
const { Connection, PublicKey } = require('@solana/web3.js');
const { TOKENS, hasReserves } = require('./_utils');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy';

async function main() {
  const poolsPath = path.join(__dirname, 'pools.json');
  if (!fs.existsSync(poolsPath)) {
    console.error('❌ pools.json not found');
    process.exit(1);
  }

  let pools = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
  
  // CRITICAL: Filter to only pools WITH reserves (no SDK available)
  pools = pools.filter(p => hasReserves(p));
  console.log(`📦 Loaded ${pools.length} pools with reserves\n`);

  const inputAtomic = '10000000000'; // 10 SOL
  
  const routes = await tri.findArbitrageRoutes(pools, inputAtomic, {
    tokenA: TOKENS.SOL,
    tokenC: TOKENS.USDC,
    maxRoutes: 50,
    maxImpactPct: 5,
    logVerbose: true
  });

  const resultsPath = path.join(__dirname, 'clean_routes_FIXED.json');
  fs.writeFileSync(resultsPath, JSON.stringify(routes, null, 2));
  console.log(`\n💾 Results saved to: ${resultsPath}`);

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

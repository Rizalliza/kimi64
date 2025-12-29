#!/usr/bin/env node
'use strict';

/**
 * math_smoketest.js
 *
 * Demonstrates that the CPMM math pipeline produces sensible outputs and
 * can detect a profitable triangle when reserves are coherent.
 *
 * Usage:
 *   node math_smoketest.js
 */

const { TOKENS, humanToAtomic } = require('./_utils');
const engine = require('./_engine');

const MINTS = {
  SOL: TOKENS.SOL,
  USDC: TOKENS.USDC,
  ALCH: 'ALCH111111111111111111111111111111111111111',
};

function cpmmPool({ name, baseMint, quoteMint, baseDecimals, quoteDecimals, baseHuman, quoteHuman, feeBps = 30 }) {
  return {
    poolAddress: name,
    dex: 'raydium',
    type: 'cpmm',
    baseMint,
    quoteMint,
    baseDecimals,
    quoteDecimals,
    xReserve: humanToAtomic(baseHuman, baseDecimals).toString(),
    yReserve: humanToAtomic(quoteHuman, quoteDecimals).toString(),
    feeBps,
    raw: {}
  };
}

async function main() {
  // Construct a triangle SOL -> ALCH -> USDC -> SOL
  // Prices implied:
  //  SOL/ALCH ~ 1 SOL = 1000 ALCH
  //  ALCH/USDC ~ 1 ALCH = 1.6 USDC
  //  USDC/SOL  ~ 1 SOL = 1400 USDC
  // This creates an arbitrage (1000*1.6=1600 USDC per SOL vs 1400 USDC per SOL).

  const pools = [
    cpmmPool({
      name: 'SOL-ALCH',
      baseMint: MINTS.SOL,
      quoteMint: MINTS.ALCH,
      baseDecimals: 9,
      quoteDecimals: 6,
      baseHuman: '100000',
      quoteHuman: '100000000',
      feeBps: 30,
    }),
    cpmmPool({
      name: 'ALCH-USDC',
      baseMint: MINTS.ALCH,
      quoteMint: MINTS.USDC,
      baseDecimals: 6,
      quoteDecimals: 6,
      baseHuman: '60000000',
      quoteHuman: '96000000',
      feeBps: 30,
    }),
    cpmmPool({
      name: 'USDC-SOL',
      baseMint: MINTS.USDC,
      quoteMint: MINTS.SOL,
      baseDecimals: 6,
      quoteDecimals: 9,
      baseHuman: '140000000',
      quoteHuman: '100000',
      feeBps: 30,
    }),
  ];

  const dxAtomic = humanToAtomic('1', 9).toString();

  const routes = await engine.findTriangularRoutes({
    pools,
    tokenA: MINTS.SOL,
    tokenC: MINTS.USDC,
    dxAtomic,
    poolsPerLeg: 3,
    maxRoutes: 10,
    maxImpactPct: 100,
    logRoutes: true,
    logLegs: true,
  });

  console.log(`
Found routes: ${routes.length}`);
  if (routes[0]) {
    console.log('Top route profitPct=', routes[0].profitPct, 'isSdkVerified=', routes[0].isSdkVerified);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

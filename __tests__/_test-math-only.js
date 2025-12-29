#!/usr/bin/env node
'use strict';

/**
 * Test triangular arbitrage using ONLY math simulation (no SDK)
 * This isolates if the problem is SDK or math calculation
 */

const fs = require('fs');
const path = require('path');
const { D, normalizeType, normalizeDex, shortMint, TOKENS, hasReserves } = require('./_utils');
const math = require('./_math');

function testMathSimulation() {
  console.log('🔬 Testing Math Simulation\n');

  // Load pools
  const pools = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools.json')));

  // Find a SOL-USDC route pair
  const solMint = TOKENS.SOL.toLowerCase();
  const usdcMint = TOKENS.USDC.toLowerCase();

  // Find pools with proper structure for math
  const dlmmPools = pools.filter(p => 
    normalizeType(p) === 'dlmm' && hasReserves(p)
  );

  const cpmmPools = pools.filter(p => 
    normalizeType(p) === 'cpmm' && hasReserves(p)
  );

  const clmmPools = pools.filter(p => 
    normalizeType(p) === 'clmm' && hasReserves(p)
  );

  console.log(`Pool counts:`);
  console.log(`  DLMM with reserves: ${dlmmPools.length}`);
  console.log(`  CPMM with reserves: ${cpmmPools.length}`);
  console.log(`  CLMM with reserves: ${clmmPools.length}`);

  if (dlmmPools.length === 0) {
    console.error('❌ No DLMM pools with reserves found');
    return;
  }

  // Pick first DLMM pool
  const pool1 = dlmmPools[0];
  console.log(`\n✅ Testing with pool: ${path.basename(pool1.poolAddress)}`);
  console.log(`   Type: ${normalizeType(pool1)}`);
  console.log(`   Pair: ${shortMint(pool1.baseMint)}/${shortMint(pool1.quoteMint)}`);
  console.log(`   xReserve: ${pool1.xReserve}`);
  console.log(`   yReserve: ${pool1.yReserve}`);

  // Try a math simulation
  const inputAtomic = '1000000000'; // 1 SOL
  const inputMint = TOKENS.SOL;
  const outputMint = pool1.baseMint === inputMint ? pool1.quoteMint : pool1.baseMint;

  console.log(`\n📊 Simulating swap: ${shortMint(inputMint)} → ${shortMint(outputMint)}`);
  console.log(`   Input: ${D(inputAtomic).div(1e9).toFixed(6)} SOL`);

  try {
    const result = math.simulateMath(pool1, inputMint, inputAtomic);

    if (result.ok) {
      console.log(`   ✅ Success`);
      console.log(`   Output: ${D(result.dyAtomic).toFixed(0)} (${D(result.dyAtomic).div(1e6).toFixed(6)} if 6 decimals)`);
      console.log(`   Impact: ${result.priceImpactPct}%`);
      console.log(`   Fee: ${result.feePaid || '0'}`);
      console.log(`   Via: ${result.via}`);

      // Check if output is reasonable
      const inputDecimal = D(inputAtomic);
      const outputDecimal = D(result.dyAtomic);
      const ratio = outputDecimal.div(inputDecimal);

      console.log(`\n📈 Reasonableness check:`);
      console.log(`   Input/Output ratio: ${ratio.toFixed(6)}`);
      console.log(`   (1.0 = fair, <1.0 = loss due to slippage/fees)`);

      if (ratio.gt(10)) {
        console.log(`   ⚠️  WARNING: Ratio > 10, simulation may be broken!`);
      }
    } else {
      console.log(`   ❌ Failed: ${result.reason}`);
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
  }

  // Test a complete 3-leg route with math only
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing 3-leg route (math only)`);
  console.log(`${'='.repeat(60)}\n`);

  const leg1 = dlmmPools.find(p => {
    const base = p.baseMint.toLowerCase();
    const quote = p.quoteMint.toLowerCase();
    return base === solMint || quote === solMint;
  });

  if (!leg1) {
    console.log('❌ No SOL pool found');
    return;
  }

  const intermediateToken = leg1.baseMint === TOKENS.SOL ? leg1.quoteMint : leg1.baseMint;
  console.log(`Intermediate token: ${shortMint(intermediateToken)}`);

  const leg2 = cpmmPools.find(p => {
    const base = p.baseMint.toLowerCase();
    const quote = p.quoteMint.toLowerCase();
    const intLower = intermediateToken.toLowerCase();
    const usdcLower = TOKENS.USDC.toLowerCase();
    return (base === intLower && quote === usdcLower) ||
           (base === usdcLower && quote === intLower);
  });

  if (!leg2) {
    console.log('❌ No intermediate→USDC pool found');
    return;
  }

  const leg3 = clmmPools.find(p => {
    const base = p.baseMint.toLowerCase();
    const quote = p.quoteMint.toLowerCase();
    return (base === usdcMint && quote === solMint) ||
           (base === solMint && quote === usdcMint);
  });

  if (!leg3) {
    console.log('❌ No USDC→SOL pool found');
    return;
  }

  console.log(`Leg 1: ${normalizeType(leg1).toUpperCase()} ${shortMint(leg1.baseMint)}/${shortMint(leg1.quoteMint)}`);
  console.log(`Leg 2: ${normalizeType(leg2).toUpperCase()} ${shortMint(leg2.baseMint)}/${shortMint(leg2.quoteMint)}`);
  console.log(`Leg 3: ${normalizeType(leg3).toUpperCase()} ${shortMint(leg3.baseMint)}/${shortMint(leg3.quoteMint)}`);

  // Simulate legs
  let currentAmount = '10000000000'; // 10 SOL
  console.log(`\nStarting amount: ${D(currentAmount).div(1e9).toFixed(4)} SOL`);

  const leg1Result = math.simulateMath(leg1, TOKENS.SOL, currentAmount);
  if (!leg1Result.ok) {
    console.log(`❌ Leg 1 failed: ${leg1Result.reason}`);
    return;
  }
  console.log(`✅ Leg 1: ${D(leg1Result.dyAtomic).toFixed(0)} ${shortMint(intermediateToken)}`);
  
  const leg2Result = math.simulateMath(leg2, intermediateToken, leg1Result.dyAtomic);
  if (!leg2Result.ok) {
    console.log(`❌ Leg 2 failed: ${leg2Result.reason}`);
    return;
  }
  console.log(`✅ Leg 2: ${D(leg2Result.dyAtomic).toFixed(0)} USDC`);

  const leg3Result = math.simulateMath(leg3, TOKENS.USDC, leg2Result.dyAtomic);
  if (!leg3Result.ok) {
    console.log(`❌ Leg 3 failed: ${leg3Result.reason}`);
    return;
  }
  console.log(`✅ Leg 3: ${D(leg3Result.dyAtomic).div(1e9).toFixed(4)} SOL`);

  const finalAmount = D(leg3Result.dyAtomic);
  const profit = finalAmount.minus(D(currentAmount));
  const profitPct = profit.div(D(currentAmount)).mul(100);

  console.log(`\n📊 Result:`);
  console.log(`   Input:  ${D(currentAmount).div(1e9).toFixed(4)} SOL`);
  console.log(`   Output: ${finalAmount.div(1e9).toFixed(4)} SOL`);
  console.log(`   Profit: ${profit.div(1e9).toFixed(6)} SOL (${profitPct.toFixed(4)}%)`);
}

testMathSimulation();

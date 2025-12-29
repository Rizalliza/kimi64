'use strict';
/**
 * _math.js - Mathematical Swap Simulation
 * 
 * Pure math calculations for different DEX types:
 * - CPMM (constant product)
 * - CLMM (concentrated liquidity)
 * - DLMM (bin-based liquidity)
 * 
 * All amounts use Decimal for precision.
 * Input: atomic units
 * Output: { dyAtomic, priceImpactPct, feePaid, via }
 */

const { D, hasReserves, getReserves, getFeeRate, getSwapDecimals, atomicToHuman, humanToAtomic } = require('./_utils');
const Decimal = require('decimal.js');

// ============================================================================
// CPMM (Constant Product Market Maker)
// ============================================================================

/**
 * Simulate CPMM swap: x * y = k
 * 
 * @param {Object} pool - Pool with xReserve, yReserve
 * @param {string} inputMint - Input token mint
 * @param {string} dxAtomic - Input amount in atomic units
 * @returns {Object} { ok, dyAtomic, priceImpactPct, feePaid, via }
 */
function simulateCpmm(pool, inputMint, dxAtomic) {
  const { x, y } = getReserves(pool);
  const fee = getFeeRate(pool);
  const dx = D(dxAtomic);
  
  if (x.lte(0) || y.lte(0) || dx.lte(0)) {
    return { ok: false, reason: 'invalid-reserves-or-input' };
  }
  
  // Get decimals based on swap direction
  const { inputDecimals, outputDecimals, swapForY } = getSwapDecimals(pool, inputMint);
  
  // Convert to human units for calculation
  const dxHuman = atomicToHuman(dx, inputDecimals);
  // FIXED: inputReserve/outputReserve based on swap direction
  const inputReserveHuman = atomicToHuman(swapForY ? x : y, inputDecimals);
  const outputReserveHuman = atomicToHuman(swapForY ? y : x, outputDecimals);
  
  // Calculate fee
  const feePaid = dxHuman.mul(fee);
  const dxAfterFee = dxHuman.minus(feePaid);
  
  if (dxAfterFee.lte(0)) {
    return { ok: false, reason: 'fee-exceeds-input' };
  }
  
  // Constant product: k = x * y
  const k = inputReserveHuman.mul(outputReserveHuman);
  const newInputRes = inputReserveHuman.plus(dxAfterFee);
  const newOutputRes = k.div(newInputRes);
  const dyHuman = outputReserveHuman.minus(newOutputRes);
  
  if (dyHuman.lte(0)) {
    return { ok: false, reason: 'zero-output' };
  }
  
  // Price impact
  const midPrice = outputReserveHuman.div(inputReserveHuman);
  const execPrice = dyHuman.div(dxAfterFee);
  const priceImpact = midPrice.gt(0) && execPrice.gt(0) 
    ? midPrice.minus(execPrice).abs().div(midPrice).mul(100)
    : D(0);
  
  // Convert output back to atomic
  const dyAtomic = humanToAtomic(dyHuman, outputDecimals);
  const feePaidAtomic = humanToAtomic(feePaid, inputDecimals);
  
  return {
    ok: true,
    dyAtomic: dyAtomic.toString(),
    dyHuman: dyHuman.toString(),
    dxHuman: dxHuman.toString(),
    priceImpactPct: priceImpact.toString(),
    feePaid: feePaidAtomic.toString(),
    midPrice: midPrice.toString(),
    execPrice: execPrice.toString(),
    via: 'math-cpmm'
  };
}

// ============================================================================
// DLMM (Discrete Liquidity Market Maker - Bin Based)
// ============================================================================

/**
 * Create default bins from pool reserves (fallback when no bin data)
 * Uses CPMM approximation with spread around mid price
 */
function createDefaultBins(pool) {
  const { x, y } = getReserves(pool);
  const { inputDecimals, outputDecimals } = getSwapDecimals(pool, pool.baseMint);
  
  const xHuman = atomicToHuman(x, inputDecimals);
  const yHuman = atomicToHuman(y, outputDecimals);
  
  let midPrice = D(pool.midPrice || pool.price || 0);
  
  if (midPrice.lte(0) && xHuman.gt(0) && yHuman.gt(0)) {
    midPrice = yHuman.div(xHuman);
  }
  
  if (midPrice.lte(0)) {
    midPrice = D(1);
  }
  
  // Distribute liquidity across 5 bins around mid price
  const totalLiquidity = xHuman.gt(0) ? xHuman : D(100000);
  const perBin = totalLiquidity.div(5);
  
  return [
    { price: midPrice.mul(0.98), liquidityX: perBin },
    { price: midPrice.mul(0.99), liquidityX: perBin },
    { price: midPrice, liquidityX: perBin },
    { price: midPrice.mul(1.01), liquidityX: perBin },
    { price: midPrice.mul(1.02), liquidityX: perBin }
  ];
}

/**
 * Simulate DLMM swap through bins
 * 
 * @param {Object} pool - Pool with bins or reserves
 * @param {string} inputMint - Input token mint
 * @param {string} dxAtomic - Input amount in atomic units
 * @returns {Object} { ok, dyAtomic, priceImpactPct, feePaid, via }
 */
function simulateDlmm(pool, inputMint, dxAtomic) {
  // DLMM without proper bin data: fall back to CPMM approximation
  return simulateCpmm(pool, inputMint, dxAtomic);
}

// ============================================================================
// CLMM (Concentrated Liquidity Market Maker)
// ============================================================================

/**
 * Generate default CLMM segments from pool data
 */
function generateClmmSegments(pool) {
  const { x, y } = getReserves(pool);
  const { inputDecimals, outputDecimals } = getSwapDecimals(pool, pool.baseMint);
  
  const xHuman = atomicToHuman(x, inputDecimals);
  const yHuman = atomicToHuman(y, outputDecimals);
  
  let sCurrent = D(pool.sqrtPriceCurrent || pool.sqrtPrice || 0);
  
  if (sCurrent.lte(0)) {
    const mid = D(pool.midPrice || pool.currentPrice || pool.price || 0);
    sCurrent = mid.gt(0) ? mid.sqrt() : D(1);
  }
  
  // Estimate liquidity: L ≈ x * sqrtP
  let liquidityEstimate = xHuman.mul(sCurrent);
  if (liquidityEstimate.lte(0)) {
    liquidityEstimate = D(pool.liquidity || 100000);
  }
  
  const Lthird = liquidityEstimate.div(3);
  
  return [
    { sqrtPriceLower: sCurrent.mul(0.95), sqrtPriceUpper: sCurrent, liquidity: Lthird },
    { sqrtPriceLower: sCurrent, sqrtPriceUpper: sCurrent.mul(1.05), liquidity: Lthird },
    { sqrtPriceLower: sCurrent.mul(1.05), sqrtPriceUpper: sCurrent.mul(1.1), liquidity: Lthird }
  ];
}

/**
 * Simulate CLMM swap through price segments
 * 
 * For now: use CPMM approximation (proper CLMM requires exact segment data)
 */
function simulateClmm(pool, inputMint, dxAtomic) {
  return simulateCpmm(pool, inputMint, dxAtomic);
}

// ============================================================================
// UNIFIED SIMULATION
// ============================================================================

/**
 * Simulate swap using appropriate math model based on pool type
 * 
 * @param {Object} pool - Pool object with type, reserves, etc.
 * @param {string} inputMint - Input token mint
 * @param {string} dxAtomic - Input amount in atomic units
 * @returns {Object} { ok, dyAtomic, priceImpactPct, feePaid, via, ... }
 */
function simulateMath(pool, inputMint, dxAtomic) {
  const type = (pool.type || '').toLowerCase();
  
  // Route to appropriate simulator
  switch (type) {
    case 'dlmm':
      return simulateDlmm(pool, inputMint, dxAtomic);
    
    case 'clmm':
    case 'concentrated':
      return simulateClmm(pool, inputMint, dxAtomic);
    
    case 'cpmm':
    case 'amm':
    case 'constant_product':
    default:
      return simulateCpmm(pool, inputMint, dxAtomic);
  }
}

/**
 * Check if pool can be simulated with math
 * @param {Object} pool 
 * @returns {boolean}
 */
function canSimulateMath(pool) {
  // All types can potentially be simulated if they have reserves
  return hasReserves(pool);
}

/**
 * Calculate liquidity score for pool ranking
 * @param {Object} pool 
 * @returns {Decimal}
 */
function liquidityScore(pool) {
  const { x, y } = getReserves(pool);
  if (x.lte(0) || y.lte(0)) return D(0);
  
  // Geometric mean of reserves (sqrt(x * y))
  return x.mul(y).sqrt();
}

module.exports = {
  // Individual simulators
  simulateCpmm,
  simulateDlmm,
  simulateClmm,
  
  // Unified interface
  simulateMath,
  canSimulateMath,
  liquidityScore,
  
  // Helpers
  createDefaultBins,
  generateClmmSegments
};

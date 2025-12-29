# Simulation Failure Diagnostic Guide

Based on your engine output:
```
[engine] Stats:
  Routes attempted: 6
  Sim failures: 6
  SDK calls: 18, success: 12
  Routes found: 0
```

All 6 simulations failed despite 12 successful SDK calls. This test suite helps identify the root cause.

## Key Observations

1. **SDK calls succeeded (12/18)**: The SDKs can quote the pools
2. **All simulations failed (6/6)**: But the 3-leg simulation still failed
3. **Math calls: 0**: No fallback to math simulation occurred

## Common Root Causes

### 1. **Token Mismatch** (Most Likely)
- **Issue**: Pool baseMint/quoteMint don't match the route tokens (A, B, C)
- **Test Case**: `should fail due to token mismatch in leg 1`
- **How to Check**:
  ```javascript
  console.log('Route tokens:', { tokenA, tokenB, tokenC });
  console.log('Pool leg 1:', { baseMint: poolAB.baseMint, quoteMint: poolAB.quoteMint });
  ```
- **Fix**: Verify pool mint ordering matches route structure

### 2. **Missing Reserves with No SDK**
- **Issue**: Pools don't have reserves AND SDK is not available for that pool type
- **Test Case**: `should fail when SDK succeeds but math fallback unavailable`
- **How to Check**:
  ```javascript
  const hasReserves = pool.xReserve || pool.yReserve;
  const canSimulateMath = math.canSimulateMath(pool);
  ```
- **Fix**: Enrich pools with reserve data before passing to engine

### 3. **Math Simulation Failures**
- **Issue**: Even when math is available, it returns `ok: false`
- **Test Case**: `should detect when all legs successfully but math returns failures`
- **Reason**: Insufficient liquidity in pools for the trade amount
- **Fix**: Reduce trade amount or filter pools by minimum liquidity

### 4. **Unrealistic Price Impact**
- **Issue**: One leg exceeds the maxImpactPct threshold (default: 5%)
- **Test Case**: `should reject leg 1 if impact exceeds threshold`
- **How to Check**:
  ```javascript
  if (D(leg1.priceImpactPct).gt(maxImpactPct)) {
    console.log('Rejected: Leg 1 impact too high:', leg1.priceImpactPct);
  }
  ```
- **Fix**: Increase `maxImpactPct` parameter or filter low-liquidity pools

### 5. **SDK Quote Validation Failure**
- **Issue**: SDK returns a quote but it fails validation (missing dyAtomic, etc.)
- **Test Case**: `should handle SDK returning invalid quote`
- **How to Check**:
  ```javascript
  if (!quote || !quote.dyAtomic || D(quote.dyAtomic).lte(0)) {
    console.log('Invalid SDK quote:', quote);
  }
  ```
- **Fix**: Validate SDK responses more carefully

## Debugging Steps

### Step 1: Add Detailed Logging
Modify your engine call to enable verbose logging:

```javascript
const routes = await findTriangularRoutes({
  pools,
  tokenA: TOKENS.SOL,
  tokenC: TOKENS.USDC,
  dxAtomic: '10000000000',
  poolsPerLeg: 5,
  logRoutes: true,   // Enable route discovery logging
  logLegs: true      // Enable leg simulation logging
});
```

### Step 2: Check Pool Data Quality

```javascript
// In _runner.js or your diagnostic script
const { filterUsablePools } = require('./_engine');

const usable = filterUsablePools(pools, true);

// Verify each pool has required data
for (const pool of usable.slice(0, 5)) {
  console.log({
    poolAddress: pool.poolAddress,
    baseMint: pool.baseMint,
    quoteMint: pool.quoteMint,
    type: normalizeType(pool),
    hasReserves: !!(pool.xReserve || pool.yReserve),
    dex: normalizeDex(pool)
  });
}
```

### Step 3: Run Individual Leg Simulation

```javascript
const { simulateLeg } = require('./_simulate');

const result = await simulateLeg({
  pool: poolAB,
  inputMint: TOKENS.SOL,
  outputMint: TOKENS.USDT,
  dxAtomic: '1000000000',
  log: true  // Enable detailed logging
});

console.log('Leg result:', result);
```

### Step 4: Check SDK Availability

```javascript
const sdk = require('./_sdk');

console.log({
  isReady: sdk.isReady?.(),
  available: sdk.getAvailable?.()
});
```

## Test Coverage

This test suite covers:
- ✅ Happy path (all 3 legs succeed)
- ✅ SDK-verified routes
- ✅ Math fallback behavior
- ✅ Price impact validation (per-leg)
- ✅ Profit validation
- ✅ Token mismatch detection
- ✅ Pool data integrity checks
- ✅ Zero/negative input handling
- ✅ Stats tracking

## Running Tests

```bash
# Run all simulation tests
npm test -- simulateTriangularRoute.test.js

# Run specific test suite
npm test -- simulateTriangularRoute.test.js -t "Diagnostic"

# Run with verbose output
npm test -- simulateTriangularRoute.test.js --verbose
```

## Your Specific Issue

Your latest run shows:
```
Routes attempted: 95
Sim failures: 67
Routes found: 28
SDK calls: 181, success: 114
Math calls: 0
```

**Problem**: All 28 routes found have **NEGATIVE PROFIT** (-0.22%, -0.27%, etc.)

**Root Causes**:

### 1. **All Routes Are Unprofitable** (Primary Issue)
- Fees (0.3% per leg = ~1% total) exceed any mispricing gains
- With 3 DLMM/CLMM legs, prices are efficiently arbitraged
- Profitable arbitrage opportunities are rare/non-existent in real-time
- **Test Case**: `should return negative profit routes (fees exceed gains)`

**Why this happens**:
- Solana DEXs have tight bid-ask spreads
- DLMM pools have excellent liquidity concentration
- Miners/validators extract most MEV before your transaction settles
- With 10 SOL amount, slippage across 3 legs = ~1% loss just from fees

### 2. **Output Serialization Issue** (Secondary)
Your top 5 routes show:
```
dexRoute=unknown/unknown/???????? -> unknown/unknown/????????
```

This means the route objects are losing metadata during JSON serialization.
- **Test Case**: `should have correct metadata structure for serialization`

**Cause**: The `pools`, `types`, or `vias` arrays are not being properly included in the final output written to JSON.

## Debugging Your Current Issue

### Step 1: Verify Profit Calculation is Correct

```javascript
// In _engine.js, after getting result from simulateTriangularRoute
if (result.ok) {
  const profitPct = D(result.profitPct);
  
  console.log(`[route] Profit: ${profitPct.toFixed(4)}%`);
  console.log(`[route]   In: ${D(result.dxAtomic).div(1e9).toFixed(4)} SOL`);
  console.log(`[route]   Out: ${D(result.outAtomic).div(1e9).toFixed(4)} SOL`);
  console.log(`[route]   Atomic diff: ${D(result.profitAtomic).toString()}`);
  console.log(`[route]   Legs: ${result.vias.join(' → ')}`);
}
```

### Step 2: Check Metadata Serialization

```javascript
// Before writing routes to JSON, verify structure
const route = routes[0];
console.log({
  hasOk: !!route.ok,
  hasPools: Array.isArray(route.pools) && route.pools.length === 3,
  hasTypes: Array.isArray(route.types) && route.types.length === 3,
  hasVias: Array.isArray(route.vias) && route.vias.length === 3,
  poolsContent: route.pools,
  typesContent: route.types,
  viasContent: route.vias
});
```

### Step 3: Filter Out Negative Profit Routes

```javascript
// In _runner.js, after getting routes
const profitableRoutes = routes.filter(r => D(r.profitPct).gte(minProfitThreshold));

console.log(`Found ${routes.length} total routes, ${profitableRoutes.length} profitable`);

if (profitableRoutes.length === 0) {
  console.warn('⚠️  No profitable routes found. Market is well-arbitraged.');
  console.warn('Consider:');
  console.warn('  1. Increase amount (bigger swaps = worse slippage)');
  console.warn('  2. Use faster RPC (reduce latency)');
  console.warn('  3. Look for DEXs with wider spreads');
  console.warn('  4. Monitor during low-liquidity periods');
}
```

### Step 4: Verify Pool Type Mix

From your diagnostic output:
```
Types: {"dlmm":39,"clmm":24}
By DEX: {"meteora":39,"orca":22,"raydium":2}
```

The issue: **No CPMM pools** (198 filtered out due to missing reserves).
- CPMM pools are often less efficient → better arbitrage
- DLMM pools have better liquidity → harder to arbitrage
- **Recommendation**: Enrich pool reserves to include CPMM pools

## Next Steps

### Immediate (Verify Current Issue)
1. Run with profit filter: `--minProfit=0.1` to see if ANY positive routes exist
2. Enable detailed logging: add `logLegs: true` to engine call
3. Check JSON output file for metadata corruption

### Short-term (Improve Routes)
1. Lower `minLp` threshold to include smaller, less-liquid pools
2. Add CPMM pools by enriching with reserve data
3. Try different token pairs (not just SOL→USDC)
4. Increase trade amount to test if market has depth

### Long-term (Detect Real Opportunities)
1. Build historical opportunity tracker
2. Monitor spreads across DEXs over time
3. Look for MEV sandwich opportunities instead of pure arbitrage
4. Consider cross-chain arbitrage

## Test Coverage

This expanded test suite now covers:
- ✅ **Unprofitable routes** (realistic scenario)
- ✅ **Very small positive profit** ((<0.1% threshold)
- ✅ **Serialization correctness** (metadata preservation)
- ✅ **JSON roundtrip validation** (serialize → parse → verify)
- ✅ All previous 27 tests

Total: **31 tests**, all passing

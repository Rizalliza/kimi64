'use strict';
/**
 * example_poolFetcher_usage.js
 * 
 * Shows how to use the poolFetcher with your actual data
 * to prepare pools for triangular arbitrage detection
 */

const fs = require('fs');
const { processPools, filterPools, toCanonicalShape, toEnrichedShape } = require('./_poolFetcher');
const { findTriangularRoutes } = require('./_engine');
const sdk = require('./_sdk');

const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

/**
 * Example 1: Basic filtering and normalization
 */
async function example1_BasicFiltering() {
  console.log('\n=== EXAMPLE 1: Basic Filtering ===');

  const rawPools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));

  const processed = processPools(rawPools, {
    format: 'enriched',
    minLpUsdc: 750000,
    solOrUsdcOnly: true,
    log: true
  });

  console.log(`✅ Processed ${processed.length} pools`);

  if (processed.length > 0) {
    console.log('\nFirst pool sample:');
    console.log(JSON.stringify(processed[0], null, 2).slice(0, 300) + '...');
  }

  return processed;
}

/**
 * Example 2: Two-shape approach (canonical + enriched)
 */
async function example2_TwoShapes() {
  console.log('\n=== EXAMPLE 2: Two Pool Shapes ===');

  const rawPools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));

  const { pools: filtered } = filterPools(rawPools, {
    minLpUsdc: 750000,
    solOrUsdcOnly: true,
    deduplicateByDexType: false,
    log: false
  });

  if (filtered.length === 0) {
    console.log('No pools match criteria');
    return;
  }

  const pool = filtered[0];

  const canonical = toCanonicalShape(pool);
  const enriched = toEnrichedShape(pool);

  console.log('CANONICAL SHAPE (lightweight):');
  console.log(JSON.stringify(canonical, null, 2));

  console.log('\nENRICHED SHAPE (full data):');
  console.log(JSON.stringify(enriched, null, 2));
}

/**
 * Example 3: Progressive filtering to understand where pools are lost
 */
async function example3_FilteringBreakdown() {
  console.log('\n=== EXAMPLE 3: Filtering Breakdown ===');

  const rawPools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));

  console.log(`Starting with ${rawPools.length} pools`);

  const step1 = filterPools(rawPools, {
    solOrUsdcOnly: true,
    minLpUsdc: 0,
    deduplicateByDexType: false,
    log: false
  });
  console.log(`After SOL or USDC filter: ${step1.pools.length} (removed ${step1.stats.noTokenPair})`);

  const step2 = filterPools(rawPools, {
    solOrUsdcOnly: true,
    minLpUsdc: 0,
    deduplicateByDexType: true,
    log: false
  });
  console.log(`After deduplication: ${step2.pools.length} (removed ${step2.stats.duplicate})`);

  const step3 = filterPools(rawPools, {
    solOrUsdcOnly: true,
    minLpUsdc: 750000,
    deduplicateByDexType: true,
    log: false
  });
  console.log(`After minLP > 750K: ${step3.pools.length} (removed ${step3.stats.lowLiquidity})`);

  console.log(`\n📊 Summary:`);
  console.log(`  Input: ${rawPools.length}`);
  console.log(`  Output: ${step3.pools.length}`);
  console.log(`  Filtered: ${rawPools.length - step3.pools.length}`);
  console.log(`    - No SOL or USDC: ${step1.stats.noTokenPair}`);
  console.log(`    - Duplicates: ${step2.stats.duplicate}`);
  console.log(`    - Low liquidity: ${step3.stats.lowLiquidity}`);
}

/**
 * Example 4: Lowering threshold to find more routes
 */
async function example4_LowerThreshold() {
  console.log('\n=== EXAMPLE 4: Lower Threshold Comparison ===');

  const rawPools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));

  const thresholds = [750000, 1000000];

  for (const threshold of thresholds) {
    const { pools: filtered } = filterPools(rawPools, {
      solOrUsdcOnly: false,
      minLpUsdc: threshold,
      deduplicateByDexType: true,
      log: false
    });

    console.log(`minLP = ${(threshold / 1000000).toFixed(1)}M USDC → ${filtered.length} pools`);
  }
}

/**
 * Example 5: Integration with route finder
 */
async function example5_FullPipeline() {
  console.log('\n=== EXAMPLE 5: Full Pipeline (Filter + Route Find) ===');

  try {
    const rawPools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));

    // Step 1: Filter pools
    console.log('Step 1: Filtering pools...');
    const processed = processPools(rawPools, {
      format: 'enriched',
      minLpUsdc: 750000,
      solOrUsdcOnly: true,
      log: true
    });

    if (processed.length === 0) {
      console.log('No pools match criteria');
      return;
    }

    // Step 2: Find routes
    console.log('\nStep 2: Finding triangular routes...');
    const routes = await findTriangularRoutes({
      pools: processed,
      tokenA: TOKENS.SOL,
      tokenC: TOKENS.USDC,
      dxAtomic: '10000000000',
      poolsPerLeg: 8,
      maxRoutes: 50,
      maxImpactPct: 5,
      logRoutes: true,
      logLegs: true
    });

    console.log(`\nFound ${routes.length} routes`);

    if (routes.length > 0) {
      console.log('\nTop 3 routes:');
      for (let i = 0; i < Math.min(3, routes.length); i++) {
        const r = routes[i];
        console.log(`${i + 1}. Profit: ${r.profitPct}% | Verified: ${r.isSdkVerified}`);
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

/**
 * Example 6: Save filtered pools to file
 */
async function example6_SaveResults() {
  console.log('\n=== EXAMPLE 6: Save Filtered Pools ===');

  const rawPools = JSON.parse(fs.readFileSync('./pools_meta.json', 'utf8'));

  const canonical = processPools(rawPools, {
    format: 'canonical',
    minLpUsdc: 750000,
    solOrUsdcOnly: true,
    log: false
  });

  const enriched = processPools(rawPools, {
    format: 'enriched',
    minLpUsdc: 750000,
    solOrUsdcOnly: true,
    log: false
  });

  fs.writeFileSync('./pools_canonical_filtered.json', JSON.stringify(canonical, null, 2));
  fs.writeFileSync('./pools_enriched_filtered.json', JSON.stringify(enriched, null, 2));

  console.log(`✅ Saved ${canonical.length} canonical pools → pools_canonical_filtered.json`);
  console.log(`✅ Saved ${enriched.length} enriched pools → pools_enriched_filtered.json`);
}

/**
 * Main: Run all examples
 */
async function main() {
  console.log('🚀 Pool Fetcher Usage Examples');
  console.log('================================');

  try {
    // Run examples
    //await example1_BasicFiltering();
    await example2_TwoShapes();
    //await example3_FilteringBreakdown();
    // await example4_LowerThreshold();
    await example6_SaveResults();

    // Uncomment to run full pipeline (requires SDK):
    await example5_FullPipeline();

    console.log('\n✅ All examples complete!');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();

//. node example_poolFetcher_usage.js pools_meta.json --usdc --sol --minlp=750000
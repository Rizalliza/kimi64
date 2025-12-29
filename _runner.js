'use strict';

/**
 * _runner.js - Main entry point for triangular arbitrage detection
 *
 * SDK-only approach: uses initialized SDKs for all supported pool types
 *
 * Usage:
 * node _runner.js Meta/cpmmCopy.json --amount=10. --sdk
 * node _runner.js pool_clmmRay_only_enriched.json --sdk --minLp=750_000 --amount=10 --maxSdkPoolsPerLeg=8
 * 
 * Flags:
 * --sdk              Use SDK for quotes (requires initialized SDKs)
 * --minLp=VALUE      Minimum liquidity threshold in USDC
 * --amount=VALUE     Trading amount in SOL
 * --maxSdkPoolsPerLeg=N  Max pools per leg (default 8)
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const Decimal = require('decimal.js');

// Test PublicKey to ensure it's working
console.log('✅ PublicKey import successful:', typeof PublicKey);

// Import core modules
const tri = require('./_engine'); // or your triangular route finder
const { loadPoolsFromFile } = require('./_loader');
const { humanToAtomic, toNumberOrNull } = require('./_utils');

// Solana constants
const MINT_SOL = 'So11111111111111111111111111111111111111112';
const MINT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ============================================================================
// FLAG PARSING
// ============================================================================

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function getFlagValue(flag) {
  const idx = process.argv.findIndex(a => a.startsWith(flag + '='));
  if (idx < 0) return null;
  return process.argv[idx].split('=')[1];
}
class RateLimiter {
  constructor(maxRequests = 50, intervalMs = 1000) {
    this.queue = [];
    this.maxRequests = maxRequests;
    this.intervalMs = intervalMs;
    this.requestCount = 0;
    this.lastReset = Date.now();
    this.garbageCollectionThreshold = maxRequests;
    this.totalRequests = 0;
  }

  async execute(fn) {
    while (this.requestCount >= this.maxRequests) {
      const elapsed = Date.now() - this.lastReset;
      if (elapsed >= this.intervalMs) {
        this.requestCount = 0;
        this.lastReset = Date.now();

        if (this.totalRequests >= this.garbageCollectionThreshold) {
          this.performGarbageCollection();
        }
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.requestCount++;
    this.totalRequests++;

    try {
      return await fn();
    } catch (error) {
      console.warn('Request failed, implementing retry logic:', error.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return await fn();
    }
  }

  performGarbageCollection() {
    console.log('🧹 Performing garbage collection...');
    this.queue = [];
    this.totalRequests = 0;
    if (global.gc) {
      global.gc();
      console.log('✅ Garbage collection completed');
    }
  }
}

class CacheManager {
  constructor(ttlMs = 5000) {
    this.cache = new Map();
    this.ttl = ttlMs;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }
  set(key, val) {
    this.cache.set(key, { data: val, timestamp: Date.now() });
  }
}

class QuoteEngine {
  constructor(rpcUrl = 'https://api.mainnet-beta.solana.com') {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.sim = new SwapSimulator(this.connection);
    this.pools = [];

    this.callCounter = 0;
    this.gcThreshold = 50;

    // Enhanced rate limiter for Jito submissions
    this.rateLimiter = {
      requests: 0,
      windowStart: Date.now(),
      maxRequests: 10, // 10 requests per minute
      windowMs: 60000, // 1 minute window

      async acquire() {
        const now = Date.now();

        // Reset window if needed
        if (now - this.windowStart > this.windowMs) {
          this.requests = 0;
          this.windowStart = now;
        }

        // Check if we're at the limit
        if (this.requests >= this.maxRequests) {
          const waitTime = this.windowMs - (now - this.windowStart);
          console.log(`   ⏱️  Rate limit reached, waiting ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));

          // Reset after waiting
          this.requests = 0;
          this.windowStart = Date.now();
        }

        this.requests++;
        return true;
      }
    };

    this.cacheManager = new CacheManager(5000);

    // Load wallet from secret key file with error handling
    try {
      const fs = require('fs');
      const { Keypair } = require('@solana/web3.js');

      const secretKeyPath = './keys/executor_keypair_clean.json';
      console.log('📂 Loading wallet from:', secretKeyPath);

      const secretKey = JSON.parse(fs.readFileSync(secretKeyPath, 'utf8'));
      this.wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));
      this.keyPair = this.wallet; // Fixed: assign wallet, not secretKey

      console.log('✅ QuoteEngine initialized with wallet:', this.wallet.publicKey.toString());
    } catch (error) {
      console.warn('⚠️  Failed to load wallet:', error.message);
      console.log('   Creating temporary wallet for testing...');

      const { Keypair } = require('@solana/web3.js');
      this.wallet = Keypair.generate();
      this.keyPair = this.wallet;

      console.log('✅ Created temporary wallet:', this.wallet.publicKey.toString());
    }

    console.log('✅ Engine initialized with RPC:', rpcUrl);
    this.initialize(rpcUrl);
  }


  checkAndCleanMemory() {
    this.callCounter++;
    if (this.callCounter >= this.gcThreshold) {
      this.recycleMemory();
    }
  }

  recycleMemory() {
    console.log(`🧹 Memory recycle triggered (${this.callCounter} calls)`);
    if (this.cacheManager && this.cacheManager.cache instanceof Map) {
      this.cacheManager.cache.clear();
    }
    this.callCounter = 0;

    if (global.gc) {
      global.gc();
      console.log('✅ Garbage collection completed');
    }
  }

  async initialize(rpcUrl) {
    try {
      this.connection = new Connection(rpcUrl, 'confirmed');
      this.sim = new SwapSimulator(this.connection);

      const blockHeight = await this.connection.getBlockHeight();
      console.log('✅ Connected to Solana. Block height:', blockHeight);

      console.log('✅ QuoteEngine initialized');
    } catch (e) {
      console.error('❌ Initialize error:', e.message);
      throw e;
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  let filePath;
  let useSDK;
  let connection;

  try {
    // Parse arguments
    const fileArg = process.argv[2];
    if (!fileArg) {
      console.error('Usage: node _runner.js <poolsFile.json> [--sdk] [--hydrate] [--minLp=1000] [--amount=10] [--maxSdkPoolsPerLeg=8]');
      process.exit(1);
    }

    filePath = path.resolve(fileArg);
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      process.exit(1);
    }

    console.log('📦 Loading pools from:', filePath);

    // ========================================================================
    // SDK DETECTION
    // ========================================================================

    let sdkAvailable = false;
    let sdkModule = null;

    try {
      sdkModule = require('./_sdkAdapter');
      console.log('🔌 sdkAdapter found:', sdkModule);
      const hasFunctions = !!(
        //sdkModule?.quoteSwap ||
        sdkModule?.quoteExactIn ||
        sdkModule?.quoteMeteora ||
        sdkModule?.quoteWhirlpool ||
        sdkModule?.quoteClmm
      );
      sdkAvailable = hasFunctions;

      if (sdkAvailable) {
        const funcs = Object.keys(sdkModule).filter(k => k.includes('quote'));
        console.log('🔌 sdkAdapter detected - functions:', funcs);
      }
    } catch (e) {
      console.log('⚠️  sdkAdapter not found:', e.message);
      sdkAvailable = false;
    }


    // Determine if SDK should be used
    const { Connection } = require('@solana/web3.js');
    const opts = {
      rpcUrl: process.env.RPC_URL || 'https://solana-mainnet.g.alchemy.com/v2/D45KPIYJAK973XyrdTmjy',
    };
    console.log('rpcUrl:', opts.rpcUrl);
    const sdk = require('./_sdk');

    connection = new Connection(opts.rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30000,
    });
    // Connect to RPC
    console.log(`\n🔌 Connecting to RPC: ${opts.rpcUrl.slice(0, 30)}...`);
    const rpcUrl = connection.rpcEndpoint;

    await sdk.initialize(new Connection(rpcUrl, 'confirmed'));
    console.log('[runner] sdk ready =', sdk.isReady(), 'available =', sdk.getAvailable?.());
    console.log('[runner] sdk available =', sdkAvailable);

    useSDK = process.argv.includes('--sdk');
    if (useSDK && !sdkAvailable) {
      console.warn('⚠️  SDK requested but not available. Disabling...');
      useSDK = false;

      const pools = loadPoolsFromFile(filePath, { log: false });
      console.log(`✅ Pools loaded: ${pools.length}`);

      if (pools.length === 0) {
        console.error('❌ No pools loaded from file');
        process.exit(1);
      } else {
        console.log('⚠️  SDK not available');
      }

      // ========================================================================
      // FILTER USABLE POOLS
      // ========================================================================

      const usable = tri.filterUsablePools(pools, useSDK);
      console.log(`✅ Usable pools: ${usable.length}`);
      console.log(`   Total pools: ${pools.length}`);

      const dexCounts = {};
      const typeCounts = {};
      for (const p of usable) {
        const d = (p?.dex || 'unknown').toString().toLowerCase();
        const t = (p?.type || p?.poolType || 'unknown').toString().toLowerCase();
        dexCounts[d] = (dexCounts[d] || 0) + 1;
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      }

      const dexSummary = Object.entries(dexCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([d, c]) => `${d}:${c}`)
        .join('  ');
      const typeSummary = Object.entries(typeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `${t}:${c}`)
        .join('  ');

      console.log(`📊 DEX breakdown (usable): ${dexSummary}`);
      console.log(`📊 Type breakdown: ${typeSummary}`);

      if (typeCounts['dlmm'] && !useSDK) {
        console.log(`⚠️  Note: ${typeCounts['dlmm']} DLMM pools using math approximation (may be inaccurate).`);
      }
    } else if (useSDK) {
      console.log('🚀 Using SDK for quotes and verification');
    } else {
      console.log('⚠️  Not using SDK for quotes and verification');
    }
  } catch (err) {
    console.error(err);
  }
  // ========================================================================
  // PARSE OPTIONS
  // ========================================================================
  try {
    const minLp = toNumberOrNull(getFlagValue('--minLp')) ??
      toNumberOrNull(process.env.MIN_LP_USDC) ?? 0;

    const maxSdkPoolsPerLeg = toNumberOrNull(getFlagValue('--maxSdkPoolsPerLeg')) ??
      toNumberOrNull(process.env.MAX_SDK_POOLS_PER_LEG) ?? 8;

    const maxCombosPerB = toNumberOrNull(getFlagValue('--maxCombosPerB')) ??
      toNumberOrNull(process.env.MAX_COMBOS_PER_B) ?? 250;

    const amountSolHuman = getFlagValue('--amount') || process.env.AMOUNT_SOL || '10';
    const amountInAtomic = humanToAtomic(amountSolHuman, 9).toString();

    console.log('\n🔍 Running triangular arbitrage detection...');
    console.log(`   Amount: ${amountSolHuman} SOL (${amountInAtomic} atomic)`);
    console.log(`   Min LP: ${minLp} USDC`);
    console.log(`   Max SDK pools/leg: ${maxSdkPoolsPerLeg}`);
    console.log(`   Max combos/B: ${maxCombosPerB}`);

    // Load pools from file
    const pools = loadPoolsFromFile(filePath, { log: false });
    console.log(`✅ Pools loaded: ${pools.length}`);

    // SDK-only approach: filter pools using SDK capabilities
    const usable = tri.filterUsablePools(pools, useSDK);
    console.log(`✅ Usable pools: ${usable.length}`);

    // ✅ IMPORTANT: engine expects dxAtomic, not amountInAtomic
    const routes = await tri.findTriangularRoutes({
      pools: usable,
      tokenA: MINT_SOL,
      tokenC: MINT_USDC,
      dxAtomic: amountInAtomic,
      thresholdPct: 0.1,
      maxRoutes: 50,
      maxSdkPoolsPerLeg,
      //maxCombosPerIntermediate,
      logRoutes: true,
      logLegs: false
    });
    console.log(`✅ Routes found: ${routes.length}`);
    //console.log(`   Total combinations tested: ${getStats()?.totalCombinationsTested || 0}`);
    //console.log(`   Total combinations skipped: ${getStats()?.totalCombinationsSkipped || 0}`);

    // ========================================================================
    // RESULTS
    // ========================================================================

    console.log(`\n🎯 Found ${routes.length} triangular routes`);

    // Count verified vs unverified
    const verified = routes.filter(r => r.isSdkVerified);
    const unverified = routes.filter(r => !r.isSdkVerified);
    console.log(`   ✅ SDK-verified: ${verified.length}  ⚠️  Math-approx: ${unverified.length}`);

    if (routes.length > 0) {
      console.log('\n📊 Top 5 routes:');
      routes.slice(0, 5).forEach((r, i) => {
        const dexes = r.dexes || [];
        const types = r.types || [];
        const pools = r.pools || [];

        const legDex = dexes.map((dex, idx) => {
          const type = types[idx] || 'unknown';
          const addr = pools[idx] ? pools[idx].slice(0, 8) : '????????';
          return `${dex}/${type}/${addr}`;
        }).join(' -> ');

        const status = r.isSdkVerified ? '✅' : '⚠️ MATH';
        const profit = Number(r.profitPct || 0).toFixed(4);
        console.log(
          `${i + 1}. profit=${profit}% ${status} dexRoute=${legDex}`
        );
      });
    }

    if (unverified.length > 0 && verified.length === 0) {
      console.log('\n⚠️  WARNING: All routes used math approximation for concentrated pools.');
      console.log('   Profits shown may be UNRELIABLE. Ensure SDK is properly configured.');
    }

    // Write results to file
    const outputPath = path.join(path.dirname(filePath), 'triangular_routes.json');
    fs.writeFileSync(outputPath, JSON.stringify(routes.slice(0, 50), null, 2));
    console.log(`\n📁 Results written to: ${outputPath}`);

  } catch (e) {
    console.error('❌ Fatal error:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}
function cacheGet(key) {
  return this.cacheManager.get(key);
}

function cacheSet(key, val) {
  this.cacheManager.set(key, val);
}
// ============================================================================
// RUN
// ============================================================================

if (require.main === module) {
  main();
  // usable: length,
  console.log('✅ Done.');
}

module.exports = { main };

// node _runner.js pools_enriched.json --sdk --minLp=750_000  mount=10 --maxSdkPoolsPerLeg=8

//. node _runner.js  _pools_enriched_test.json  --sdk --minLp=750_000  mount=10 --maxSdkPoolsPerLeg=8
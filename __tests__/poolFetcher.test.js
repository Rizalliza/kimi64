'use strict';

const {
  toCanonicalShape,
  toEnrichedShape,
  filterPools,
  processPools,
  hasSOLPair,
  hasUSDCPair,
  meetsLiquidityThreshold,
  getLiquidity,
  getDecimals,
  getReserves,
  TOKENS
} = require('../_poolFetcher');
const { D } = require('../_utils');

describe('poolFetcher', () => {
  const SOL = TOKENS.SOL;
  const USDC = TOKENS.USDC;

  const createPool = (overrides = {}) => ({
    poolAddress: 'testPool123',
    address: 'testPool123',
    dex: 'meteora',
    type: 'dlmm',
    baseMint: SOL,
    quoteMint: USDC,
    mint_x: SOL,
    mint_y: USDC,
    baseDecimals: 9,
    quoteDecimals: 6,
    decimalsX: 9,
    decimalsY: 6,
    feeBps: 25,
    fee: 0.0025,
    xReserve: '1000000000000',
    yReserve: '500000000',
    liquidity: 1000000,
    vaults: {
      xVault: 'xVault123',
      yVault: 'yVault123'
    },
    ...overrides
  });

  describe('Token Pair Validation', () => {
    test('should identify SOL/USDC pair correctly', () => {
      const pool = createPool();
      expect(hasSOLPair(pool)).toBe(true);
      expect(hasUSDCPair(pool)).toBe(true);
    });

    test('should identify USDC/SOL pair (reversed)', () => {
      const pool = createPool({
        baseMint: USDC,
        quoteMint: SOL
      });
      expect(hasSOLPair(pool)).toBe(true);
      expect(hasUSDCPair(pool)).toBe(true);
    });

    test('should identify SOL-only pair', () => {
      const pool = createPool({
        baseMint: SOL,
        quoteMint: 'TokenX'
      });
      expect(hasSOLPair(pool)).toBe(true);
      expect(hasUSDCPair(pool)).toBe(false);
    });

    test('should identify USDC-only pair', () => {
      const pool = createPool({
        baseMint: USDC,
        quoteMint: 'TokenX'
      });
      expect(hasSOLPair(pool)).toBe(false);
      expect(hasUSDCPair(pool)).toBe(true);
    });

    test('should reject pool with neither SOL nor USDC', () => {
      const pool = createPool({
        baseMint: 'TokenA123',
        quoteMint: 'TokenB456'
      });
      expect(hasSOLPair(pool)).toBe(false);
      expect(hasUSDCPair(pool)).toBe(false);
    });
  });

  describe('Liquidity Calculations', () => {
    test('should use pool.liquidity when available', () => {
      const pool = createPool({ liquidity: 5000000 });
      const lp = getLiquidity(pool);
      expect(lp.toNumber()).toBe(5000000);
    });

    test('should calculate liquidity from reserves (geometric mean)', () => {
      const pool = createPool({
        xReserve: '1000000000000',
        yReserve: '1000000000',
        baseDecimals: 9,
        quoteDecimals: 6,
        liquidity: undefined
      });
      const lp = getLiquidity(pool);
      expect(lp.gt(0)).toBe(true);
    });

    test('should return 0 for missing reserves and liquidity', () => {
      const pool = createPool({
        xReserve: undefined,
        yReserve: undefined,
        liquidity: undefined
      });
      const lp = getLiquidity(pool);
      expect(lp.eq(0)).toBe(true);
    });

    test('should meet minimum liquidity threshold', () => {
      const pool = createPool({ liquidity: 1000000 });
      expect(meetsLiquidityThreshold(pool, 750000)).toBe(true);
    });

    test('should fail minimum liquidity threshold', () => {
      const pool = createPool({ liquidity: 500000 });
      expect(meetsLiquidityThreshold(pool, 750000)).toBe(false);
    });

    test('should pass with no threshold specified', () => {
      const pool = createPool({ liquidity: 100 });
      expect(meetsLiquidityThreshold(pool, 0)).toBe(true);
    });
  });

  describe('Decimal Extraction', () => {
    test('should extract baseDecimals as number', () => {
      const pool = createPool({ baseDecimals: 9, quoteDecimals: 6 });
      const decimals = getDecimals(pool);
      expect(decimals.base).toBe(9);
      expect(decimals.quote).toBe(6);
    });

    test('should extract decimals from object notation', () => {
      const pool = createPool({
        baseDecimals: { decimals: 9, symbol: 'SOL' },
        quoteDecimals: { decimals: 6, symbol: 'USDC' }
      });
      const decimals = getDecimals(pool);
      expect(decimals.base).toBe(9);
      expect(decimals.quote).toBe(6);
    });

    test('should fallback to decimalsX/Y notation', () => {
      const pool = createPool({
        baseDecimals: undefined,
        quoteDecimals: undefined,
        decimalsX: 9,
        decimalsY: 6
      });
      const decimals = getDecimals(pool);
      expect(decimals.base).toBe(9);
      expect(decimals.quote).toBe(6);
    });
  });

  describe('Reserve Extraction', () => {
    test('should extract xReserve and yReserve', () => {
      const pool = createPool({
        xReserve: '1000000000000',
        yReserve: '500000000'
      });
      const reserves = getReserves(pool);
      expect(reserves.x.toString()).toBe('1000000000000');
      expect(reserves.y.toString()).toBe('500000000');
    });

    test('should return 0 for missing reserves', () => {
      const pool = createPool({
        xReserve: undefined,
        yReserve: undefined
      });
      const reserves = getReserves(pool);
      expect(reserves.x.eq(0)).toBe(true);
      expect(reserves.y.eq(0)).toBe(true);
    });
  });

  describe('toCanonicalShape', () => {
    test('should extract all required canonical fields', () => {
      const pool = createPool({
        baseMint: SOL,
        quoteMint: USDC,
        baseDecimals: 9,
        quoteDecimals: 6,
        feeBps: 25
      });

      const canonical = toCanonicalShape(pool);

      expect(canonical.poolAddress).toBe('testPool123');
      expect(canonical.type).toBeDefined();
      expect(canonical.dex).toBeDefined();
      expect(canonical.baseMint).toBe(SOL);
      expect(canonical.quoteMint).toBe(USDC);
      expect(canonical.baseDecimals).toBe(9);
      expect(canonical.quoteDecimals).toBe(6);
      expect(canonical.feeBps).toBe(25);
      expect(canonical.slippageBps).toBe(10);
      expect(canonical.vaults).toBeDefined();
    });

    test('should use fallback values when fields missing', () => {
      const pool = createPool({
        feeBps: undefined,
        fee: 0.003,
        slippageBps: undefined
      });

      const canonical = toCanonicalShape(pool);

      expect(canonical.feeBps).toBe(30);
      expect(canonical.slippageBps).toBe(10);
    });

    test('should handle alternative field names (mint_x/mint_y)', () => {
      const pool = {
        address: 'testPool123',
        dex: 'meteora',
        type: 'dlmm',
        mint_x: SOL,
        mint_y: USDC,
        baseDecimals: 9,
        quoteDecimals: 6
      };

      const canonical = toCanonicalShape(pool);

      expect(canonical.baseMint).toBe(SOL);
      expect(canonical.quoteMint).toBe(USDC);
    });
  });

  describe('toEnrichedShape', () => {
    test('should include all canonical fields plus reserves and liquidity', () => {
      const pool = createPool({
        liquidity: 1000000,
        xReserve: '1000000000000',
        yReserve: '500000000'
      });

      const enriched = toEnrichedShape(pool);

      expect(enriched.poolAddress).toBe('testPool123');
      expect(enriched.baseMint).toBe(SOL);
      expect(enriched.quoteMint).toBe(USDC);
      expect(enriched.xReserve).toBe('1000000000000');
      expect(enriched.yReserve).toBe('500000000');
      expect(enriched.liquidity).toBeDefined();
    });

    test('should include dlmm fields when present', () => {
      const pool = createPool({
        type: 'dlmm',
        dlmm: {
          binStep: 10,
          activeId: 100
        }
      });

      const enriched = toEnrichedShape(pool);

      expect(enriched.dlmm).toBeDefined();
      expect(enriched.dlmm.binStep).toBe(10);
      expect(enriched.dlmm.activeId).toBe(100);
    });

    test('should include clmm fields when present', () => {
      const pool = createPool({
        type: 'clmm',
        clmm: {
          sqrtPriceX64: '123456',
          liquidity: '789012',
          currentTick: 0,
          tickArrays: ['tick1', 'tick2']
        }
      });

      const enriched = toEnrichedShape(pool);

      expect(enriched.clmm).toBeDefined();
      expect(enriched.clmm.sqrtPriceX64).toBe('123456');
      expect(enriched.clmm.liquidity).toBe('789012');
    });

    test('should have updatedAtMs field', () => {
      const now = Date.now();
      const pool = createPool({
        updatedAtMs: now
      });

      const enriched = toEnrichedShape(pool);

      expect(enriched.updatedAtMs).toBe(now);
    });
  });

  describe('filterPools', () => {
    test('should filter by SOL or USDC (OR logic)', () => {
      const pools = [
        createPool({ baseMint: SOL, quoteMint: USDC, poolAddress: 'pool1' }),
        createPool({ baseMint: SOL, quoteMint: 'TokenX', poolAddress: 'pool2', dex: 'raydium' }),
        createPool({ baseMint: USDC, quoteMint: 'TokenY', poolAddress: 'pool3', dex: 'orca' }),
        createPool({ baseMint: 'TokenA', quoteMint: 'TokenB', poolAddress: 'pool4' })
      ];

      const { pools: filtered, stats } = filterPools(pools, {
        solOrUsdcOnly: true,
        deduplicateByDexType: false
      });

      expect(filtered.length).toBe(3);
      expect(stats.noTokenPair).toBe(1);
    });

    test('should filter by minimum liquidity', () => {
      const pools = [
        createPool({ liquidity: 1000000 }),
        createPool({ liquidity: 500000 })
      ];

      const { pools: filtered, stats } = filterPools(pools, {
        minLpUsdc: 750000,
        solOrUsdcOnly: false
      });

      expect(filtered.length).toBe(1);
      expect(stats.lowLiquidity).toBe(1);
    });

    test('should deduplicate by DEX + type', () => {
      const pools = [
        createPool({ dex: 'meteora', type: 'dlmm' }),
        createPool({ dex: 'meteora', type: 'dlmm', poolAddress: 'pool2' }),
        createPool({ dex: 'raydium', type: 'clmm' })
      ];

      const { pools: filtered, stats } = filterPools(pools, {
        solOrUsdcOnly: false,
        deduplicateByDexType: true
      });

      expect(filtered.length).toBe(2);
      expect(stats.duplicate).toBe(1);
    });

    test('should apply all filters together with OR logic', () => {
      const pools = [
        createPool({
          poolAddress: 'pool1',
          baseMint: SOL,
          quoteMint: USDC,
          liquidity: 1000000,
          dex: 'meteora',
          type: 'dlmm'
        }),
        createPool({
          poolAddress: 'pool2',
          baseMint: SOL,
          quoteMint: 'TokenX',
          liquidity: 2000000,
          dex: 'meteora',
          type: 'clmm'
        }),
        createPool({
          poolAddress: 'pool3',
          baseMint: 'TokenA',
          quoteMint: 'TokenB',
          liquidity: 2000000,
          dex: 'raydium',
          type: 'clmm'
        })
      ];

      const { pools: filtered, stats } = filterPools(pools, {
        minLpUsdc: 750000,
        solOrUsdcOnly: true,
        deduplicateByDexType: true
      });

      expect(filtered.length).toBe(2);
      expect(stats.noTokenPair).toBe(1);
      expect(stats.duplicate).toBe(0);
    });

    test('should handle empty pool list', () => {
      const { pools: filtered, stats } = filterPools([], {
        solOrUsdcOnly: true,
        deduplicateByDexType: false
      });

      expect(filtered.length).toBe(0);
      expect(stats.input).toBe(0);
      expect(stats.output).toBe(0);
    });

    test('should accept SOL-only pairs when solOrUsdcOnly is true', () => {
      const pools = [
        createPool({ baseMint: SOL, quoteMint: 'TokenX', poolAddress: 'pool1' }),
        createPool({ baseMint: 'TokenA', quoteMint: SOL, poolAddress: 'pool2', dex: 'raydium' })
      ];

      const { pools: filtered, stats } = filterPools(pools, {
        solOrUsdcOnly: true,
        deduplicateByDexType: false
      });

      expect(filtered.length).toBe(2);
      expect(stats.noTokenPair).toBe(0);
    });

    test('should accept USDC-only pairs when solOrUsdcOnly is true', () => {
      const pools = [
        createPool({ baseMint: USDC, quoteMint: 'TokenX', poolAddress: 'pool1' }),
        createPool({ baseMint: 'TokenA', quoteMint: USDC, poolAddress: 'pool2', dex: 'raydium' })
      ];

      const { pools: filtered, stats } = filterPools(pools, {
        solOrUsdcOnly: true,
        deduplicateByDexType: false
      });

      expect(filtered.length).toBe(2);
      expect(stats.noTokenPair).toBe(0);
    });
  });

  describe('processPools', () => {
    test('should return canonical shape by default', () => {
      const pools = [createPool()];

      const processed = processPools(pools, {
        format: 'canonical',
        solOrUsdcOnly: false
      });

      expect(processed.length).toBe(1);
      expect(processed[0].baseMint).toBe(SOL);
      expect(processed[0].xReserve).toBeUndefined();
    });

    test('should return enriched shape when requested', () => {
      const pools = [createPool({ liquidity: 1000000 })];

      const processed = processPools(pools, {
        format: 'enriched',
        solOrUsdcOnly: false
      });

      expect(processed.length).toBe(1);
      expect(processed[0].baseMint).toBe(SOL);
      expect(processed[0].xReserve).toBeDefined();
      expect(processed[0].liquidity).toBeDefined();
    });

    test('should apply filtering during processing', () => {
      const pools = [
        createPool({ liquidity: 1000000 }),
        createPool({ liquidity: 500000 })
      ];

      const processed = processPools(pools, {
        format: 'enriched',
        minLpUsdc: 750000,
        solOrUsdcOnly: false
      });

      expect(processed.length).toBe(1);
    });

    test('should normalize all pool types', () => {
      const pools = [
        createPool({ type: 'dlmm', dex: 'meteora' }),
        createPool({ type: 'clmm', dex: 'raydium' }),
        createPool({ type: 'whirlpool', dex: 'orca' })
      ];

      const processed = processPools(pools, {
        format: 'enriched',
        solOrUsdcOnly: false,
        deduplicateByDexType: false
      });

      expect(processed.length).toBe(3);
      expect(processed.every(p => p.type)).toBe(true);
      expect(processed.every(p => p.dex)).toBe(true);
    });
  });

  describe('Real-world Scenarios', () => {
    test('should process pools with variable decimal formats', () => {
      const pools = [
        createPool({
          poolAddress: 'pool1',
          baseDecimals: 9,
          quoteDecimals: 6,
          dex: 'meteora',
          type: 'dlmm'
        }),
        createPool({
          poolAddress: 'pool2',
          baseDecimals: { decimals: 8, symbol: 'BTC' },
          quoteDecimals: { decimals: 6, symbol: 'USDC' },
          dex: 'raydium',
          type: 'clmm'
        }),
        createPool({
          poolAddress: 'pool3',
          decimalsX: 9,
          decimalsY: 6,
          baseDecimals: undefined,
          quoteDecimals: undefined,
          dex: 'orca',
          type: 'whirlpool'
        })
      ];

      const processed = processPools(pools, {
        format: 'canonical',
        solOrUsdcOnly: false
      });

      expect(processed.length).toBe(3);
      expect(processed[0].baseDecimals).toBe(9);
      expect(processed[1].baseDecimals).toBe(8);
      expect(processed[2].baseDecimals).toBe(9);
    });

    test('should handle pools from different DEXs', () => {
      const pools = [
        createPool({ dex: 'meteora', type: 'dlmm' }),
        createPool({ dex: 'raydium', type: 'clmm' }),
        createPool({ dex: 'orca', type: 'whirlpool' })
      ];

      const processed = processPools(pools, {
        format: 'enriched',
        solOrUsdcOnly: false,
        deduplicateByDexType: true
      });

      expect(processed.length).toBe(3);
      const dexes = new Set(processed.map(p => p.dex));
      expect(dexes.size).toBe(3);
    });

    test('should handle realistic liquidity range', () => {
      const pools = [
        createPool({ poolAddress: 'pool1', liquidity: 100, dex: 'meteora', type: 'dlmm' }),
        createPool({ poolAddress: 'pool2', liquidity: 750000, dex: 'raydium', type: 'clmm' }),
        createPool({ poolAddress: 'pool3', liquidity: 10000000, dex: 'orca', type: 'whirlpool' })
      ];

      const processed = processPools(pools, {
        format: 'enriched',
        minLpUsdc: 750000,
        solOrUsdcOnly: false
      });

      expect(processed.length).toBe(2);
      expect(processed.every(p => D(p.liquidity).gte(750000))).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    test('should handle null/undefined pool addresses', () => {
      const pools = [
        createPool({ poolAddress: null, address: 'addr1', dex: 'meteora', type: 'dlmm' }),
        { poolAddress: undefined, address: undefined },
        createPool({ poolAddress: 'pool3', address: 'pool3', dex: 'raydium', type: 'clmm' })
      ];

      const { pools: filtered } = filterPools(pools, {
        solOrUsdcOnly: false,
        deduplicateByDexType: true
      });

      expect(filtered.length).toBe(2);
    });

    test('should handle missing vaults', () => {
      const pool = createPool({ vaults: undefined });
      const canonical = toCanonicalShape(pool);

      expect(canonical.vaults).toEqual({
        xVault: null,
        yVault: null
      });
    });

    test('should handle zero reserves gracefully', () => {
      const pool = createPool({
        xReserve: '0',
        yReserve: '0',
        liquidity: undefined
      });

      const enriched = toEnrichedShape(pool);
      expect(enriched.liquidity).toBe('0');
    });

    test('should handle very large numbers', () => {
      const pool = createPool({
        xReserve: '999999999999999999999999999',
        yReserve: '888888888888888888888888888',
        liquidity: 999999999999
      });

      const enriched = toEnrichedShape(pool);
      expect(enriched.xReserve).toBeDefined();
      expect(enriched.liquidity).toBeDefined();
    });
  });
});

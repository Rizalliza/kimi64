'use strict';

const { simulateTriangularRoute, simulateLeg, resetStats, getStats } = require('../_simulate');
const { D } = require('../_utils');

jest.mock('../_sdk');
jest.mock('../_math');

const mockSdk = require('../_sdk');
const mockMath = require('../_math');

describe('simulateTriangularRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStats();
  });

  const TOKENS = {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BcWNg',
    ORCA: 'orcaEKTdK7LKz57chysJ47G2WG5d5ZUcnqBkP7PfAJ'
  };

  const dxAtomic = '1000000000';

  // Mock pool structures matching engine output
  const createMockPool = (poolAddress, baseMint, quoteMint, type = 'cpmm', dex = 'raydium') => ({
    poolAddress,
    baseMint,
    quoteMint,
    type,
    dex,
    poolType: type,
    fee: '0.003',
    xReserve: '1000000000000000',
    yReserve: '500000000000000',
    decimalsX: 9,
    decimalsY: 6
  });

  describe('Happy Path - Successful 3-leg simulation', () => {
    test('should simulate complete triangular route with SDK quotes', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });

      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);
      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      expect(result.legs).toHaveLength(3);
      expect(D(result.outAtomic).gte(D(dxAtomic))).toBe(true);
      expect(result.profitPct).toBeDefined();
      expect(result.isSdkVerified).toBe(false);
      expect(result.vias).toEqual(['math', 'math', 'math']);
    });

    test('should simulate route with SDK-verified legs', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT, 'dlmm', 'meteora');
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC, 'cpmm', 'raydium');
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL, 'cpmm', 'raydium');

      mockSdk.isReady = jest.fn().mockReturnValue(true);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: true, whirlpool: false, clmm: false });
      
      mockSdk.quote = jest.fn()
        .mockResolvedValueOnce({
          dyAtomic: '1900000000',
          priceImpactPct: '0.4',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'meteora-sdk'
        });

      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);
      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      expect(result.isSdkVerified).toBe(true);
      expect(result.legs[0].isSdkVerified).toBe(true);
    });

    test('should calculate profit correctly', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });

      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);
      const outputA = '1050000000';
      const outputB = '1980000';
      
      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: outputB,
          dyHuman: outputB,
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: outputA,
          dyHuman: outputA,
          dxHuman: outputB,
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      const profitA = D(outputA).minus(D(dxAtomic));
      const expectedProfitPct = profitA.div(dxAtomic).mul(100).toString();
      expect(result.profitPct).toBe(expectedProfitPct);
    });
  });

  describe('Input Validation', () => {
    test('should reject with zero input', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic: '0',
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('zero-input');
    });

    test('should reject with negative input', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic: '-1000000000',
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('zero-input');
    });

    test('should reject with undefined pools', async () => {
      const result = await simulateTriangularRoute({
        pools: undefined,
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('need-3-pools');
    });

    test('should reject with wrong number of pools', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('need-3-pools');
    });
  });

  describe('Leg Failures', () => {
    test('should fail when leg 1 fails', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.USDT, TOKENS.ORCA);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(false);

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.failedLeg).toBe(1);
      expect(result.reason).toContain('leg1-failed');
    });

    test('should fail when leg 2 fails', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDC, TOKENS.ORCA);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });

      mockMath.canSimulateMath = jest.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.failedLeg).toBe(2);
      expect(result.reason).toContain('leg2-failed');
    });

    test('should fail when leg 3 fails', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDT, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });

      mockMath.canSimulateMath = jest.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.failedLeg).toBe(3);
      expect(result.reason).toContain('leg3-failed');
    });
  });

  describe('Price Impact Validation', () => {
    test('should reject leg 1 if impact exceeds threshold', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '6.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('leg1-impact');
      expect(result.failedLeg).toBe(1);
    });

    test('should reject leg 2 if impact exceeds threshold', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '2.0',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '5.5',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('leg2-impact');
      expect(result.failedLeg).toBe(2);
    });

    test('should reject leg 3 if impact exceeds threshold', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '1.0',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '7.8',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('leg3-impact');
      expect(result.failedLeg).toBe(3);
    });
  });

  describe('Profit Validation', () => {
    test('should reject unrealistic profit (>50%)', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '600000000000',
          dyHuman: '600000000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('unrealistic-profit');
    });

    test('should reject negative profit (loss)', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '500000000',
          dyHuman: '500000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      const profitPct = D(result.profitPct);
      expect(profitPct.isNegative()).toBe(true);
    });
  });

  describe('Output Structure', () => {
    test('should return complete route metadata', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT, 'cpmm', 'raydium');
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC, 'cpmm', 'raydium');
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL, 'cpmm', 'raydium');

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      expect(result.tokenA).toBe(TOKENS.SOL);
      expect(result.tokenB).toBe(TOKENS.USDT);
      expect(result.tokenC).toBe(TOKENS.USDC);
      expect(result.dxAtomic).toBe(dxAtomic);
      expect(result.outAtomic).toBeDefined();
      expect(result.profitAtomic).toBeDefined();
      expect(result.profitPct).toBeDefined();
      expect(result.pools).toHaveLength(3);
      expect(result.types).toHaveLength(3);
      expect(result.vias).toHaveLength(3);
    });
  });

  describe('SDK Fallback Behavior', () => {
    test('should fallback to math when SDK quote fails', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT, 'dlmm', 'meteora');
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC, 'cpmm', 'raydium');
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL, 'cpmm', 'raydium');

      mockSdk.isReady = jest.fn().mockReturnValue(true);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: true, whirlpool: false, clmm: false });
      
      mockSdk.quote = jest.fn()
        .mockRejectedValueOnce(new Error('SDK quote failed'));

      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);
      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math-fallback'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      expect(result.isSdkVerified).toBe(false);
    });

    test('should handle SDK returning invalid quote (missing dyAtomic)', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT, 'dlmm', 'meteora');
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC, 'cpmm', 'raydium');
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL, 'cpmm', 'raydium');

      mockSdk.isReady = jest.fn().mockReturnValue(true);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: true, whirlpool: false, clmm: false });
      
      mockSdk.quote = jest.fn()
        .mockResolvedValueOnce({
          dyAtomic: null,
          priceImpactPct: '0.4',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'meteora-sdk'
        });

      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);
      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      expect(result.isSdkVerified).toBe(false);
    });
  });

  describe('Stats Tracking', () => {
    test('should track stats correctly', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      resetStats();
      await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      const stats = getStats();
      expect(stats.mathCalls).toBe(3);
      expect(stats.mathSuccess).toBe(3);
      expect(stats.sdkCalls).toBe(0);
    });
  });

  describe('Diagnostic - Common Failure Scenarios', () => {
    test('should fail when SDK succeeds but math fallback unavailable (no reserves)', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT, 'dlmm', 'meteora');
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC, 'dlmm', 'meteora');
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL, 'dlmm', 'meteora');

      delete poolAB.xReserve;
      delete poolAB.yReserve;
      delete poolBC.xReserve;
      delete poolBC.yReserve;
      delete poolCA.xReserve;
      delete poolCA.yReserve;

      mockSdk.isReady = jest.fn().mockReturnValue(true);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: true, whirlpool: false, clmm: false });
      
      mockSdk.quote = jest.fn()
        .mockResolvedValueOnce({
          dyAtomic: '1900000000',
          priceImpactPct: '0.4',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'meteora-sdk'
        })
        .mockResolvedValueOnce({
          dyAtomic: '2850000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'meteora-sdk'
        })
        .mockResolvedValueOnce({
          dyAtomic: '1010000000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'meteora-sdk'
        });

      mockMath.canSimulateMath = jest.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false);

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      expect(result.isSdkVerified).toBe(true);
    });

    test('should fail when SDK succeeds but pool type unknown (edge case)', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT, 'unknown-type', 'unknown-dex');
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC, 'unknown-type', 'unknown-dex');
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL, 'unknown-type', 'unknown-dex');

      mockSdk.isReady = jest.fn().mockReturnValue(true);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: true, whirlpool: false, clmm: false });
      mockSdk.quote = jest.fn().mockResolvedValue(null);

      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);
      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      expect(result.isSdkVerified).toBe(false);
    });

    test('should fail due to token mismatch in leg 1', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.ORCA, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(false);

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('leg1-failed');
    });

    test('should fail when legs have zero output', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '0',
          dyHuman: '0',
          dxHuman: dxAtomic,
          priceImpactPct: '100',
          feePaid: '0',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('leg1');
    });

    test('should handle all three legs with high price impact (typical failure)', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '4.2',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '4.8',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '4.1',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      const totalImpact = D('4.2').plus(D('4.8')).plus(D('4.1'));
      expect(totalImpact.gt(0)).toBe(true);
    });

    test('should detect when all legs successfully but math returns failures', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: false,
          reason: 'insufficient-liquidity'
        })
        .mockReturnValueOnce({
          ok: false,
          reason: 'insufficient-liquidity'
        })
        .mockReturnValueOnce({
          ok: false,
          reason: 'insufficient-liquidity'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('leg1-failed');
    });
  });

  describe('Edge Cases - Pool Structure Issues', () => {
    test('should fail when pool addresses are missing', async () => {
      const poolAB = createMockPool('', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
    });

    test('should fail when pool mints are null', async () => {
      const poolAB = { poolAddress: 'poolAB123', baseMint: null, quoteMint: null };
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('Real-world Issue - Unprofitable Routes', () => {
    test('should return negative profit routes (fees exceed gains)', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      const inputAmount = D(dxAtomic);
      const leg1Output = inputAmount.mul(0.998);
      const leg2Output = leg1Output.mul(0.998);
      const leg3Output = leg2Output.mul(0.998);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: leg1Output.toString(),
          dyHuman: leg1Output.toString(),
          dxHuman: dxAtomic,
          priceImpactPct: '0.1',
          feePaid: inputAmount.mul(0.002).toString(),
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: leg2Output.toString(),
          dyHuman: leg2Output.toString(),
          dxHuman: leg1Output.toString(),
          priceImpactPct: '0.1',
          feePaid: leg1Output.mul(0.002).toString(),
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: leg3Output.toString(),
          dyHuman: leg3Output.toString(),
          dxHuman: leg2Output.toString(),
          priceImpactPct: '0.1',
          feePaid: leg2Output.mul(0.002).toString(),
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      expect(D(result.profitPct).isNegative()).toBe(true);
      expect(D(result.outAtomic).lt(D(dxAtomic))).toBe(true);
    });

    test('should handle routes with very small positive profit', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      const inputAmount = D(dxAtomic);
      const outputAmount = inputAmount.plus(1000);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: inputAmount.mul(0.998).toString(),
          dyHuman: inputAmount.mul(0.998).toString(),
          dxHuman: dxAtomic,
          priceImpactPct: '0.1',
          feePaid: inputAmount.mul(0.002).toString(),
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: inputAmount.mul(0.996).toString(),
          dyHuman: inputAmount.mul(0.996).toString(),
          dxHuman: inputAmount.mul(0.998).toString(),
          priceImpactPct: '0.1',
          feePaid: inputAmount.mul(0.002).toString(),
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: outputAmount.toString(),
          dyHuman: outputAmount.toString(),
          dxHuman: inputAmount.mul(0.996).toString(),
          priceImpactPct: '0.1',
          feePaid: inputAmount.mul(0.002).toString(),
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      expect(D(result.profitPct).gte(0)).toBe(true);
      expect(D(result.profitPct).lt(0.1)).toBe(true);
    });

    test('should have correct metadata structure for serialization', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT, 'dlmm', 'meteora');
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC, 'dlmm', 'meteora');
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL, 'clmm', 'raydium');

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);
      expect(result.pools).toHaveLength(3);
      expect(result.types).toHaveLength(3);
      expect(result.types).toEqual(['dlmm', 'dlmm', 'clmm']);
      expect(result.pools[0]).toBe('poolAB123');
      expect(result.pools[1]).toBe('poolBC456');
      expect(result.pools[2]).toBe('poolCA789');
      
      expect(typeof result.tokenA).toBe('string');
      expect(typeof result.tokenB).toBe('string');
      expect(typeof result.tokenC).toBe('string');
      expect(typeof result.dxAtomic).toBe('string');
      expect(typeof result.outAtomic).toBe('string');
      expect(typeof result.profitAtomic).toBe('string');
      expect(typeof result.profitPct).toBe('string');
    });

    test('should verify all string fields are serializable', async () => {
      const poolAB = createMockPool('poolAB123', TOKENS.SOL, TOKENS.USDT);
      const poolBC = createMockPool('poolBC456', TOKENS.USDT, TOKENS.USDC);
      const poolCA = createMockPool('poolCA789', TOKENS.USDC, TOKENS.SOL);

      mockSdk.isReady = jest.fn().mockReturnValue(false);
      mockSdk.getAvailable = jest.fn().mockReturnValue({ dlmm: false, whirlpool: false, clmm: false });
      mockMath.canSimulateMath = jest.fn().mockReturnValue(true);

      mockMath.simulateMath = jest.fn()
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1900000000',
          dyHuman: '1900000000',
          dxHuman: dxAtomic,
          priceImpactPct: '0.5',
          feePaid: '30000000',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '2850000',
          dyHuman: '2850000',
          dxHuman: '1900000000',
          priceImpactPct: '0.3',
          feePaid: '5700',
          feeRate: '0.003',
          via: 'math'
        })
        .mockReturnValueOnce({
          ok: true,
          dyAtomic: '1010000000',
          dyHuman: '1010000000',
          dxHuman: '2850000',
          priceImpactPct: '0.2',
          feePaid: '3000000',
          feeRate: '0.003',
          via: 'math'
        });

      const result = await simulateTriangularRoute({
        pools: [poolAB, poolBC, poolCA],
        tokenA: TOKENS.SOL,
        tokenB: TOKENS.USDT,
        tokenC: TOKENS.USDC,
        dxAtomic,
        maxImpactPct: 5
      });

      expect(result.ok).toBe(true);

      const jsonStr = JSON.stringify(result);
      expect(jsonStr).toBeTruthy();
      expect(jsonStr.length).toBeGreaterThan(0);

      const parsed = JSON.parse(jsonStr);
      expect(parsed.profitPct).toBe(result.profitPct);
      expect(parsed.dxAtomic).toBe(result.dxAtomic);
      expect(parsed.outAtomic).toBe(result.outAtomic);
    });
  });
});

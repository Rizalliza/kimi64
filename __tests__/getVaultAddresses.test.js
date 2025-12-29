const { getVaultAddresses } = require('../_enrich_reserves.js');

describe('getVaultAddresses', () => {
  describe('Happy Path - Standard Vault Objects', () => {
    test('should extract xVault and yVault from standard vaults object', () => {
      const pool = {
        vaults: {
          xVault: 'xVaultAddress123',
          yVault: 'yVaultAddress456'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('xVaultAddress123');
      expect(result.yVault).toBe('yVaultAddress456');
    });

    test('should extract aVault and bVault from vaults object', () => {
      const pool = {
        vaults: {
          aVault: 'aVaultAddress789',
          bVault: 'bVaultAddress012'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('aVaultAddress789');
      expect(result.yVault).toBe('bVaultAddress012');
    });
  });

  describe('Happy Path - Direct Vault Properties', () => {
    test('should extract vaultX and vaultY properties', () => {
      const pool = {
        vaultX: 'vaultXAddress123',
        vaultY: 'vaultYAddress456'
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('vaultXAddress123');
      expect(result.yVault).toBe('vaultYAddress456');
    });

    test('should extract vaultA and vaultB properties', () => {
      const pool = {
        vaultA: 'vaultAAddress789',
        vaultB: 'vaultBAddress012'
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('vaultAAddress789');
      expect(result.yVault).toBe('vaultBAddress012');
    });

    test('should extract tokenVaultA and tokenVaultB properties', () => {
      const pool = {
        tokenVaultA: 'tokenVaultAAddr345',
        tokenVaultB: 'tokenVaultBAddr678'
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('tokenVaultAAddr345');
      expect(result.yVault).toBe('tokenVaultBAddr678');
    });
  });

  describe('Happy Path - Reserve Vault Properties', () => {
    test('should extract reserveXVault and reserveYVault properties', () => {
      const pool = {
        reserveXVault: 'reserveXAddr901',
        reserveYVault: 'reserveYAddr234'
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('reserveXAddr901');
      expect(result.yVault).toBe('reserveYAddr234');
    });
  });

  describe('Happy Path - Raw Nested Objects', () => {
    test('should extract reserve_x and reserve_y from raw object', () => {
      const pool = {
        raw: {
          reserve_x: 'rawReserveXAddr567',
          reserve_y: 'rawReserveYAddr890'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('rawReserveXAddr567');
      expect(result.yVault).toBe('rawReserveYAddr890');
    });

    test('should extract vault_x and vault_y from raw object', () => {
      const pool = {
        raw: {
          vault_x: 'rawVaultXAddr123',
          vault_y: 'rawVaultYAddr456'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('rawVaultXAddr123');
      expect(result.yVault).toBe('rawVaultYAddr456');
    });

    test('should extract vault_a and vault_b from raw object', () => {
      const pool = {
        raw: {
          vault_a: 'rawVaultAAddr789',
          vault_b: 'rawVaultBAddr012'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('rawVaultAAddr789');
      expect(result.yVault).toBe('rawVaultBAddr012');
    });
  });

  describe('Happy Path - _raw Nested Objects', () => {
    test('should extract reserve_x and reserve_y from _raw object', () => {
      const pool = {
        _raw: {
          reserve_x: '_rawReserveXAddr345',
          reserve_y: '_rawReserveYAddr678'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('_rawReserveXAddr345');
      expect(result.yVault).toBe('_rawReserveYAddr678');
    });

    test('should extract vaultA and vaultB from _raw object', () => {
      const pool = {
        _raw: {
          vaultA: '_rawVaultAAddr901',
          vaultB: '_rawVaultBAddr234'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('_rawVaultAAddr901');
      expect(result.yVault).toBe('_rawVaultBAddr234');
    });
  });

  describe('Edge Cases - Missing Vaults', () => {
    test('should return null for both when pool has no vault data', () => {
      const pool = {};

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBeNull();
    });

    test('should return null for xVault when only yVault is present', () => {
      const pool = {
        vaults: {
          yVault: 'yVaultAddress456'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBe('yVaultAddress456');
    });

    test('should return null for yVault when only xVault is present', () => {
      const pool = {
        vaults: {
          xVault: 'xVaultAddress123'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('xVaultAddress123');
      expect(result.yVault).toBeNull();
    });

    test('should return null for both when vaults object is empty', () => {
      const pool = { vaults: {} };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBeNull();
    });

    test('should return null when raw object is empty', () => {
      const pool = { raw: {} };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBeNull();
    });

    test('should return null when _raw object is empty', () => {
      const pool = { _raw: {} };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBeNull();
    });
  });

  describe('Priority/Fallback Order', () => {
    test('should prioritize vaults.xVault over vaultX', () => {
      const pool = {
        vaults: {
          xVault: 'priorityXVault'
        },
        vaultX: 'fallbackVaultX'
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('priorityXVault');
    });

    test('should prioritize vaults.yVault over vaultY', () => {
      const pool = {
        vaults: {
          yVault: 'priorityYVault'
        },
        vaultY: 'fallbackVaultY'
      };

      const result = getVaultAddresses(pool);

      expect(result.yVault).toBe('priorityYVault');
    });

    test('should fallback from vaults.xVault to vaults.aVault', () => {
      const pool = {
        vaults: {
          aVault: 'aVaultAddress'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('aVaultAddress');
    });

    test('should fallback through multiple levels', () => {
      const pool = {
        vaultA: 'vaultAAddr',
        tokenVaultA: 'tokenVaultAddr'
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('vaultAAddr');
    });
  });

  describe('Input Validation - Invalid Inputs', () => {
    test('should handle null pool gracefully', () => {
      expect(() => {
        getVaultAddresses(null);
      }).toThrow();
    });

    test('should handle undefined pool gracefully', () => {
      expect(() => {
        getVaultAddresses(undefined);
      }).toThrow();
    });

    test('should handle pool with null vaults object', () => {
      const pool = { vaults: null };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBeNull();
    });

    test('should handle pool with undefined vaults object', () => {
      const pool = { vaults: undefined };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBeNull();
    });
  });

  describe('Boundary Conditions', () => {
    test('should skip empty string vault addresses and return null', () => {
      const pool = {
        vaults: {
          xVault: '',
          yVault: ''
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBeNull();
    });

    test('should handle vault addresses that are only whitespace', () => {
      const pool = {
        vaults: {
          xVault: '   ',
          yVault: '   '
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('   ');
      expect(result.yVault).toBe('   ');
    });

    test('should handle very long vault address strings', () => {
      const longAddr = 'a'.repeat(10000);
      const pool = {
        vaults: {
          xVault: longAddr,
          yVault: longAddr
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe(longAddr);
      expect(result.yVault).toBe(longAddr);
    });

    test('should handle vault addresses with special characters', () => {
      const pool = {
        vaults: {
          xVault: '!@#$%^&*()',
          yVault: '<>?:"|{}[]'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('!@#$%^&*()');
      expect(result.yVault).toBe('<>?:"|{}[]');
    });

    test('should handle numeric vault addresses as numbers', () => {
      const pool = {
        vaults: {
          xVault: 123,
          yVault: 456
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe(123);
      expect(result.yVault).toBe(456);
    });

    test('should skip boolean false as falsy vault address and return null', () => {
      const pool = {
        vaults: {
          xVault: false,
          yVault: false
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBeNull();
    });

    test('should skip zero as falsy vault address and return null', () => {
      const pool = {
        vaults: {
          xVault: 0,
          yVault: 0
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBeNull();
    });
  });

  describe('Complex Scenarios - Mixed Data Structures', () => {
    test('should handle pool with multiple vault definition sources', () => {
      const pool = {
        vaults: {
          xVault: 'vaultsXVault',
          yVault: 'vaultsYVault'
        },
        vaultX: 'directVaultX',
        raw: {
          vault_x: 'rawVaultX'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('vaultsXVault');
      expect(result.yVault).toBe('vaultsYVault');
    });

    test('should handle deeply nested pool structure', () => {
      const pool = {
        config: {
          nested: {
            vaults: {
              xVault: 'deepXVault'
            }
          }
        },
        raw: {
          vault_y: 'rawYVault'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBeNull();
      expect(result.yVault).toBe('rawYVault');
    });

    test('should extract vaults from DEX-like structure with standard fields', () => {
      const pool = {
        poolAddress: '11111111111111111111111111111111',
        dex: 'raydium',
        type: 'cpmm',
        baseMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        fee: 0.0025,
        vaults: {
          xVault: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          yVault: 'So11111111111111111111111111111111111111112'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      expect(result.yVault).toBe('So11111111111111111111111111111111111111112');
    });
  });

  describe('DEX-Specific Scenarios', () => {
    test('should handle Raydium CPMM structure', () => {
      const pool = {
        type: 'cpmm',
        dex: 'raydium',
        vaults: {
          xVault: 'raydiumXVault',
          yVault: 'raydiumYVault'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('raydiumXVault');
      expect(result.yVault).toBe('raydiumYVault');
    });

    test('should handle Meteora DLMM structure', () => {
      const pool = {
        type: 'dlmm',
        dex: 'meteora',
        tokenVaultA: 'meteoraVaultA',
        tokenVaultB: 'meteoraVaultB'
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('meteoraVaultA');
      expect(result.yVault).toBe('meteoraVaultB');
    });

    test('should handle Orca Whirlpool structure with raw vaults', () => {
      const pool = {
        type: 'whirlpool',
        dex: 'orca',
        raw: {
          vault_a: 'orcaVaultA',
          vault_b: 'orcaVaultB'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('orcaVaultA');
      expect(result.yVault).toBe('orcaVaultB');
    });

    test('should handle Raydium CLMM structure with _raw vaults', () => {
      const pool = {
        type: 'clmm',
        dex: 'raydium',
        _raw: {
          vaultA: 'clmmVaultA',
          vaultB: 'clmmVaultB'
        }
      };

      const result = getVaultAddresses(pool);

      expect(result.xVault).toBe('clmmVaultA');
      expect(result.yVault).toBe('clmmVaultB');
    });
  });

  describe('Return Value Structure', () => {
    test('should always return object with xVault and yVault properties', () => {
      const pool = {};
      const result = getVaultAddresses(pool);

      expect(result).toHaveProperty('xVault');
      expect(result).toHaveProperty('yVault');
      expect(Object.keys(result).length).toBe(2);
    });

    test('should return consistent structure regardless of input', () => {
      const pools = [
        {},
        { vaults: { xVault: 'test', yVault: 'test' } },
        { raw: { vault_x: 'test', vault_y: 'test' } }
      ];

      pools.forEach(pool => {
        const result = getVaultAddresses(pool);
        expect(result).toHaveProperty('xVault');
        expect(result).toHaveProperty('yVault');
        expect(Object.keys(result).length).toBe(2);
      });
    });
  });
});

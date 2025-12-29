/**
 * CONSOLIDATED DEX ENDPOINTS - Single Source of Truth
 * ================================================================================
 * Unified structure that eliminates redundancy and simplifies maintenance
 * All DEX configs consolidated with shared field mappings and response formats
 * ================================================================================
 */

//const { RAYDIUM_AMM_POOLS } = require("../utilities/solana-price-query-v2");
const { URL } = require('url');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ========================================================================
// SHARED FIELD DEFINITIONS - Used across all DEXs
// ========================================================================
const SHARED_FIELDS = {
    // Core pool identification
    POOL_CORE: ['id', 'address', 'programId', 'type', 'version'],

    // Token information
    TOKEN_INFO: ['baseSymbol', 'quoteSymbol', 'baseMint', 'quoteMint', 'baseDecimals', 'quoteDecimals'],

    // Liquidity metrics (primary focus for filtering)
    LIQUIDITY_METRICS: ['tvl', 'liquidity', 'lpAmount', 'baseReserve', 'quoteReserve',
        'baseLiquidity', 'quoteLiquidity', 'stakedTvl', 'stakedLiquidity'],

    // Volume and trading metrics (enhanced for LP volatility analysis)
    VOLUME_METRICS: [
        // Standard intervals
        'volume1m', 'volume5m', 'volume15m', 'volume30m', 'volume1h',
        'volume2h', 'volume4h', 'volume6h', 'volume12h', 'volume24h',
        'volume7d', 'volume30d', 'volumeAll',
        // Fee metrics
        'volumeFee', 'volumeFee24h', 'volumeFee7d',
        // Transaction counts (for activity analysis)
        'txCount1h', 'txCount24h', 'txCount7d',
        // Price impact metrics
        'priceImpact', 'spread', 'slippage'
    ],

    // APR/APY metrics
    YIELD_METRICS: ['apr', 'apy', 'feeApr', 'feeApy', 'rewardApr', 'rewardApy',
        'totalApr', 'totalApy', 'farmApr', 'farmApy'],

    // Advanced metrics (enhanced for LP analysis)
    ADVANCED_METRICS: [
        'utilizationRate', 'baseUtilizationRate', 'quoteUtilizationRate',
        'activePositionCount', 'openOrderCount', 'liquidityPositionCount',
        // LP-specific metrics
        'lpProviderCount', 'avgLpSize', 'lpTurnoverRate', 'lpConcentration',
        // Volatility indicators
        'volatility1h', 'volatility24h', 'volatility7d',
        'impermanentLossRisk', 'liquidityStability', 'liquidityFlow',
        // Activity patterns
        'peakTradingHours', 'avgTradeSize', 'maxTradeSize', 'tradeFrequency'
    ],

    // Price information
    PRICE_INFO: ['price', 'tickSpacing', 'tickCurrentIndex', 'sqrtPrice']
};

// ========================================================================
// UNIFIED RESPONSE FORMAT - Standard structure for all DEXs
// ========================================================================
const UNIFIED_RESPONSE_FORMAT = {
    metadata: {
        dex: 'string',          // 'raydium', 'orca', 'meteora'
        poolType: 'string',     // 'ammV4', 'clmm', 'whirlpool', 'dlmm'
        timestamp: 'number',    // When data was fetched
        count: 'number'         // Total pools returned
    },
    pools: [{
        // Core identification
        id: 'string',
        address: 'string',
        programId: 'string',
        type: 'string',

        // Token information
        baseToken: {
            mint: 'string',
            symbol: 'string',
            decimals: 'number'
        },
        quoteToken: {
            mint: 'string',
            symbol: 'string',
            decimals: 'number'
        },

        // Primary liquidity metrics (ALWAYS PRESENT)
        liquidity: {
            tvl: 'number',              // USD value - PRIMARY FILTER FIELD
            liquidityAmount: 'number',   // Token amount
            baseReserve: 'number',      // Base token reserve
            quoteReserve: 'number'      // Quote token reserve
        },

        // Trading metrics (if available)
        trading: {
            volume24h: 'number',
            volume7d: 'number',
            volumeFee: 'number'
        },

        // Yield metrics (if available)  
        yields: {
            apr: 'number',
            apy: 'number',
            totalApr: 'number'
        },

        // DEX-specific data (optional)
        dexSpecific: 'object'  // Additional fields specific to each DEX
    }]
};

// ========================================================================
// CONSOLIDATED DEX CONFIGURATIONS
// ========================================================================
const CONSOLIDATED_DEX_ENDPOINTS = {

    // ====================================================================
    // RAYDIUM - All pool types unified
    // ====================================================================
    raydium: {
        name: 'Raydium',
        baseUrl: 'https://api-v3.raydium.io',

        // All Raydium program IDs in one place
        programIds: {
            ammV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
            clmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
            cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
            amm: '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',
            launchLab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',

            // Utility programs
            burnAndEarn: 'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE',
            routing: 'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',
            staking: 'EhhTKczWMGQt46ynNeRX1WfeagwwJd7ufHvCDjRxjo5Q',
            farmStaking: '9KEPoZmtHUrBbhWN1v1KWLMkkvwY6WLtAVUCPRtRjP4z',
            ecosystemFarm: 'FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG'
        },

        // API V2 Endpoints (Primary)
        api_v2: {
            base: 'https://api.raydium.io/v2',
            price: 'https://api.raydium.io/v2/main/price',
            pairs: 'https://api.raydium.io/v2/main/pairs',
            ammPools: 'https://api.raydium.io/v2/ammV3/ammPools',
            farmPools: 'https://api.raydium.io/v2/main/farm-pools',
            info: 'https://api.raydium.io/v2/main/info'
        },

        // API V3 Endpoints (Newer)
        api_v3: {
            base: 'https://api-v3.raydium.io',
            poolsList: 'https://api-v3.raydium.io/pools/info/list',
            poolInfo: 'https://api-v3.raydium.io/pools/info/{poolAddress}',
            poolLine: 'https://api-v3.raydium.io/pools/line/{poolAddress}'
        },

        // CLMM Specific
        clmm: {
            type: 'Concentrated Liquidity Market Maker',
            description: 'Capital-efficient pools with concentrated liquidity',
            feeTiers: ['0.01%', '0.05%', '0.25%', '1%'],
            endpoints: {
                pools: 'https://api.raydium.io/v2/main/pairs',
                poolsV3: 'https://api-v3.raydium.io/pools/info/list'
            }
        },

        // CPMM Specific
        cpmm: {
            type: 'Constant Product Market Maker',
            description: 'New standard AMM with Token-2022 support',
            features: ['Token-2022 support', 'No OpenBook market ID required'],
            endpoints: {
                pools: 'https://api.raydium.io/v2/main/pairs'
            }
        },

        // AMM V4 Specific
        ammV4: {
            type: 'Legacy Constant Product AMM',
            description: 'Battle-tested AMM, most distributed on Solana',
            endpoints: {
                pools: 'https://api.raydium.io/v2/ammV3/ammPools',
                pairsEndpoint: 'https://api.raydium.io/v2/main/pairs',
                legacyPools: 'https://api.raydium.io/pools'
            }
        },

        // amm
        amm: {
            type: 'Stable Asset AMM',
            description: 'Optimized for pegged assets (e.g., stablecoins)',
            endpoints: {
                pools: 'https://api.raydium.io/v2/main/pairs'
            }
        },

        endpoint: {
            url: '/pools/info/list',
            method: 'GET',
            params: {
                poolType: 'all',
                poolSortField: 'liquidity',
                sortType: 'desc',
                pageSize: 1000,
                page: 1
            },
            availableFields: [
                ...SHARED_FIELDS.POOL_CORE,
                ...SHARED_FIELDS.TOKEN_INFO,
                ...SHARED_FIELDS.LIQUIDITY_METRICS,
                ...SHARED_FIELDS.VOLUME_METRICS,
                ...SHARED_FIELDS.YIELD_METRICS
            ],
            liquidityFields: ['tvl', 'liquidity'],
            fieldMapping: {
                'id': 'id',
                'programId': 'programId',
                'type': 'type',
                'mintA.address': 'baseToken.mint',
                'mintA.symbol': 'baseToken.symbol',
                'mintA.decimals': 'baseToken.decimals',
                'mintB.address': 'quoteToken.mint',
                'mintB.symbol': 'quoteToken.symbol',
                'mintB.decimals': 'quoteToken.decimals',
                'tvl': 'liquidity.tvl',
                'day.volume': 'trading.volume24h',
                'week.volume': 'trading.volume7d',
                'day.apr': 'yields.apr'
            },
            additionalEndpoints: {
                prices: '/mint/price',
                poolDetails: '/pools/info/ids'
            }
        },

        config: {
            enabled: true,
            timeout: 120000,
            rateLimit: 'Medium'
        },

        rateLimit: {
            requestsPerMinute: 60,
            burstLimit: 10
        }
    },

    // ====================================================================
    // ORCA - Whirlpool unified
    // ====================================================================
    orca: {
        name: 'Orca',
        baseUrl: 'https://https://api.orca.so/v2/solana/protocol/whirlpools',
        curl: 'https://api.orca.so/v2/solana/protocol/whirlpools',

        programIds: {
            whirlpool: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
            aquafarm: '82yxjeMsvaURa4MbZZ7WZZHfobirZYkH1zF8fmeGtyaQ'
        },

        api: {
            curl: 'https://api.orca.so/v2/solana/protocol/whirlpools',
            base: 'https://api.mainnet.orca.so/v1',
            whirlpools: 'https://api.mainnet.orca.so/v1/whirlpool/list',
            tokens: 'https://api.mainnet.orca.so/v1/token/list',
            curl: 'https://api.orca.so/v2/solana/protocol/whirlpools'
        },

        endpoint: {
            url: '/whirlpool/list',
            method: 'GET',
            availableFields: [
                ...SHARED_FIELDS.POOL_CORE,
                ...SHARED_FIELDS.TOKEN_INFO,
                ...SHARED_FIELDS.LIQUIDITY_METRICS,
                ...SHARED_FIELDS.PRICE_INFO
            ],
            liquidityFields: ['tvl', 'liquidity'],
            fieldMapping: {
                'address': 'id',
                'tokenA.mint': 'baseToken.mint',
                'tokenA.symbol': 'baseToken.symbol',
                'tokenA.decimals': 'baseToken.decimals',
                'tokenB.mint': 'quoteToken.mint',
                'tokenB.symbol': 'quoteToken.symbol',
                'tokenB.decimals': 'quoteToken.decimals',
                'tvl': 'liquidity.tvl',
                'liquidity': 'liquidity.liquidityAmount'
            }
        },

        config: {
            enabled: true,
            timeout: 60000,
            rateLimit: 'Medium'
        },

        rateLimit: {
            requestsPerMinute: 100,
            burstLimit: 20
        }
    },

    // ====================================================================
    // METEORA - DLMM unified  
    // ====================================================================
    meteora: {
        name: 'Meteora',
        baseUrl: 'https://dlmm-api.meteora.ag',

        programIds: {
            dlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
            dammv1: 'METAmTMXwdb8gYzyCPfXXFmZZw4rUsXX58PNsDg7zjL',
            dammv2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
            dynamicVaults: '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi'
        },

        dlmm: {
            type: 'Dynamic Liquidity Market Maker',
            description: 'Bin-based AMM with dynamic fees',
            features: ['Bin-based liquidity', 'Dynamic fees', 'Zero slippage in bins'],
            endpoints: {
                dlmm: 'https://dlmm-api.meteora.ag/pair/all',
                AMM: 'https://amm-v2.meteora.ag/pool/list',
                DAMM_V1: 'https://damm-api.meteora.ag/pools',
                DAMM: 'https://damm-api.meteora.ag/pool-configs',
                DAMM_V2: 'https://dammv2-api.meteora.ag/pools',
                allPairs: 'https://dlmm-api.meteora.ag/pair/all',
                all: 'https://dlmm-api.meteora.ag/pair/all',
                pairInfo: 'https://dlmm-api.meteora.ag/pair/{pairAddress}',
                position: 'https://dlmm-api.meteora.ag/position/{positionAddress}',
                positionV2: 'https://dlmm-api.meteora.ag/position_v2/{positionAddress}',
                positionMetrics: 'https://dlmm-api.meteora.ag/position/{positionAddress}/metrics',
                stake: 'https://dlmm-api.meteora.ag/stake/{stakeAddress}',
                stakeMetrics: 'https://dlmm-api.meteora.ag/stake/{stakeAddress}/metrics',
                stakePosition: 'https://dlmm-api.meteora.ag/stake/{stakeAddress}/position'
            }
        },

        dammv2: {
            type: 'Dynamic AMM V2',
            description: 'Multi-token pools with dynamic weights',
            features: ['Multi-token pools', 'Dynamic weights', 'Auto-rebalancing'],
            endpoints: {
                globalMetrics: 'https://dammv2-api.meteora.ag/pools/global-metrics',
                pool: 'https://dammv2-api.meteora.ag/pools/{poolAddress}',
                metrics: 'https://dammv2-api.meteora.ag/pools/{poolAddress}/metrics',
                position: 'https://dammv2-api.meteora.ag/pools/{poolAddress}/position',
                vesting: 'https://dammv2-api.meteora.ag/pools/vesting/{address}'
            }
        },

        dammv1: {
            type: 'Dynamic AMM V1',
            description: 'Legacy multi-token pools',
            endpoints: {
                main: 'https://damm-api.meteora.ag/pools',
                globalMetrics: 'https://damm-api.meteora.ag/pools/global-metrics',
                pool: 'https://damm-api.meteora.ag/pools/{poolAddress}',
                metrics: 'https://damm-api.meteora.ag/pools/{poolAddress}/metrics',
                position: 'https://damm-api.meteora.ag/pools/{poolAddress}/position',
                vesting: 'https://damm-api.meteora.ag/pools/vesting/{address}',
                search: 'https://damm-api.meteora.ag/pools/search?query={query}',
                feeConfig: 'https://damm-api.meteora.ag/fee-config/{configAddress}'
            }
        },

        dynamicVaults: {
            type: 'Dynamic Vaults',
            description: 'Automated market-making vaults',
            endpoints: {
                vaultInfoV2: 'https://merv2-api.meteora.ag/vault_info/{vaultAddress}',
                vaultInfo: 'https://dynamic-vault-api.meteora.ag/vault_info/{vaultAddress}',
                vaultStateV2: 'https://merv2-api.meteora.ag/vault_state/{tokenMint}',
                vaultState: 'https://dynamic-vault-api.meteora.ag/vault_state/{tokenMint}'
            }//https://merv2-api.meteora.ag/vault_info/
        },

        general: {
            globalMetrics: 'https://gmetrics.meteora.ag/api/v1/pairs'
        },

        endpoint: {
            url: '/pair/all',
            method: 'GET',
            availableFields: [
                ...SHARED_FIELDS.POOL_CORE,
                ...SHARED_FIELDS.TOKEN_INFO,
                ...SHARED_FIELDS.LIQUIDITY_METRICS,
                ...SHARED_FIELDS.VOLUME_METRICS,
                ...SHARED_FIELDS.YIELD_METRICS
            ],
            liquidityFields: ['liquidity_usd', 'reserve_x', 'reserve_y'],
            fieldMapping: {
                'address': 'id',
                'name': 'type',
                'mint_x': 'baseToken.mint',
                'mint_y': 'quoteToken.mint',
                'liquidity_usd': 'liquidity.tvl',
                'reserve_x': 'liquidity.baseReserve',
                'reserve_y': 'liquidity.quoteReserve',
                'volume_24h': 'trading.volume24h',
                'fees_24h': 'trading.volumeFee'
            }
        },

        config: {
            enabled: true,
            timeout: 120000,
            rateLimit: 'Low'
        },

        rateLimit: {
            requestsPerMinute: 120,
            burstLimit: 30
        }
    }
};

// ========================================================================
// UTILITY FUNCTIONS 
// ========================================================================

/**
 * Get all available liquidity fields across all DEXs
 */
function getAllLiquidityFields() {
    return [...new Set([
        ...SHARED_FIELDS.LIQUIDITY_METRICS,
        'liquidity_usd', 'reserve_x', 'reserve_y'
    ])];
}

/**
 * Get all available pool types across all DEXs
 */
function getAllPoolTypes() {
    return {
        raydium: ['AMM', 'AMM_V4', 'CLMM', 'CPMM'],
        orca: ['WHIRLPOOL', 'AQUAFARM'],
        meteora: ['DLMM', 'DAMM_V1', 'DAMM_V2', 'DY_VAULT']
    };
}

/**
 * Get unified endpoint configuration for a specific DEX
 */
function getDexConfig(dexName) {
    return CONSOLIDATED_DEX_ENDPOINTS[dexName.toLowerCase()];
}

/**
 * Get all program IDs for a specific DEX  
 */
function getDexProgramIds(dexName) {
    const config = getDexConfig(dexName);
    return config ? config.programIds : {};
}

/**
 * Build complete API URL for a DEX
 */
function buildApiUrl(dexName, params = {}) {
    const config = getDexConfig(dexName);
    if (!config) throw new Error(`Unknown DEX: ${dexName}`);

    const url = new URL(config.baseUrl + config.endpoint.url);

    // Always set poolType to 'all'
    url.searchParams.set('poolType', 'all');

    // Add default params from endpoint config
    if (config.endpoint.params) {
        Object.entries(config.endpoint.params).forEach(([key, value]) => {
            url.searchParams.set(key, value);
        });
    }

    // Add custom params (overrides defaults if same key)
    Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
    });

    return url.toString();
}

/**
 * ✅ FIXED: Download and store pools by type (removed duplicate declarations)
 */
async function downloadAndStorePools(dexName, endpointUrl, minLiquidity = 1_000_000) {
    try {
        logger.info('PoolDownload', `📥 Downloading pools from ${dexName}...`);

        // Fetch pool data
        const { data } = await axios.get(endpointUrl, { timeout: 120000 });

        if (!data || !Array.isArray(data)) {
            logger.warn('PoolDownload', `Invalid data format from ${dexName}`);
            return;
        }

        // Get DEX config to determine pool types
        const dexConfig = getDexConfig(dexName);
        const programIds = dexConfig?.programIds || {};

        // Group pools by type
        const poolsByType = {};

        for (const pool of data) {
            // Determine pool type from programId
            let currentPoolType = 'unknown';

            if (pool.programId) {
                for (const [typeName, programId] of Object.entries(programIds)) {
                    if (pool.programId === programId) {
                        currentPoolType = typeName;
                        break;
                    }
                }
            }

            // Filter by minimum liquidity
            const liquidityValue = pool.tvl || pool.liquidity || pool.liquidity_usd || 0;
            if (liquidityValue < minLiquidity) continue;

            // Add to appropriate pool type group
            if (!poolsByType[currentPoolType]) {
                poolsByType[currentPoolType] = [];
            }
            poolsByType[currentPoolType].push(pool);
        }

        // Save each pool type to separate file
        let totalSaved = 0;
        for (const [poolTypeName, pools] of Object.entries(poolsByType)) {
            if (pools.length === 0) continue;

            const outPath = path.join(__dirname, `../CURATED/${dexName}/poolType_${poolTypeName}.json`);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, JSON.stringify(pools, null, 2));

            logger.info('PoolDownload', `✅ Saved ${pools.length} ${poolTypeName} pools to ${outPath}`);
            totalSaved += pools.length;
        }

        logger.info('PoolDownload', `✅ Finished downloading ${totalSaved} pools from ${dexName}`);
        return totalSaved;

    } catch (error) {
        logger.error('PoolDownload', `Failed to download ${dexName} pools: ${error.message}`);
        throw error;
    }
}

/**
 * Helper function to fetch pools for a specific type (used by downloadAndStorePools)
 */
async function fetchPoolsForType(dexName, poolTypeName) {
    const config = getDexConfig('raydium', 'orca', 'meteora');
    if (!config) return [];

    const programId = config.programIds[poolTypeName.toLowerCase()];
    raydium: {



    }
    if (!programId) return [];

    console.log(`${dexName.length}, ${poolTypeName}`)

    try {
        const url = buildApiUrl(dexName, { poolType: poolTypeName });
        const { data } = await axios.get(url, { timeout: 60000 });

        if (Array.isArray(data)) {
            return data.filter(pool => pool.programId === programId);
        }

        return [];
    } catch (error) {
        logger.error('FetchPools', `Failed to fetch ${poolTypeName} pools: ${error.message}`);
        return [];
    }
}

// ========================================================================
// EXPORTS
// ========================================================================
module.exports = {
    CONSOLIDATED_DEX_ENDPOINTS,
    SHARED_FIELDS,
    UNIFIED_RESPONSE_FORMAT,
    getAllLiquidityFields,
    getAllPoolTypes,
    getDexConfig,
    getDexProgramIds,
    buildApiUrl,
    downloadAndStorePools,
    fetchPoolsForType
};

// node dexEndpoint.js download raydium 1000000
// node dex/dexEndpoints.js download raydium 1000000
if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        const dexName = args[1] || 'raydium';
        const minLiquidity = parseInt(args[2], 10) || 1_000_000;

        await downloadAndStorePools(dexName, buildApiUrl(dexName), minLiquidity);
    })();
}

// result.poolFeeRate = feeAmount / parseFloat
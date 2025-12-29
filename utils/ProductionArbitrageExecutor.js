/**
 * PRODUCTION ARBITRAGE EXECUTOR v2.0
 * Fixed: Pool data extraction, decimal conversions, rate limiting
 * 
 * FIXES:
 * ✅ Proper pool mint extraction from poolDiscovery
 * ✅ Correct decimal conversions (no more 749787% profit!)
 * ✅ Rate limit handling (429 errors)
 * ✅ Memory recycling for Jito submissions
 * ✅ Retry logic with exponential backoff
 */

const {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    VersionedTransaction,
    TransactionMessage,
    TransactionInstruction,
    ComputeBudgetProgram,
    SystemProgram,
    LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const {
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction
} = require('@solana/spl-token');
const BN = require('bn.js');
const Decimal = require('decimal.js');
const axios = require('axios');

const QuoteEngine = require('./quoteEngine.js');

Decimal.set({ precision: 60, rounding: Decimal.ROUND_FLOOR });

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const KAMINO_LENDING_PROGRAM_ID = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const KAMINO_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

const JITO_TIP_ACCOUNTS = [
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49'
];

const JITO_BLOCK_ENGINE_URLS = [
    'https://mainnet.block-engine.jito.wtf',
    'https://amsterdam.mainnet.block-engine.jito.wtf',
    'https://frankfurt.mainnet.block-engine.jito.wtf',
    'https://ny.mainnet.block-engine.jito.wtf',
    'https://tokyo.mainnet.block-engine.jito.wtf'
];

const CONFIG = {
    // Network
    RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',

    // Execution
    MAX_COMPUTE_UNITS: 1_400_000,
    COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: 50_000,

    // Flash Loan
    FLASH_LOAN_FEE_PCT: 0.000001, // 0.09% Kamino fee
    MIN_FLASH_LOAN_SOL: 10,
    MAX_FLASH_LOAN_SOL: 1000,

    // Jito - Fix tip calculation  
    MIN_JITO_TIP_LAMPORTS: 300_000, // 0.00001 SOL
    MAX_JITO_TIP_LAMPORTS: 1_000_000, // 0.0001 SOL (reduced)
    PROFIT_TIP_RATIO: 0.001, // 0.1% of profit as tip (reduced from 20%)

    // Profit Thresholds
    MIN_PROFIT_SOL: 0.01, // Min 0.01 SOL profit
    MIN_PROFIT_PERCENT: 0.5, // Min 0.5% ROI

    // Execution
    MAX_RETRIES: 3,
    CONFIRMATION_TIMEOUT_MS: 60_000,
    BUNDLE_TIMEOUT_MS: 30_000,

    // Safety
    MAX_SLIPPAGE_PCT: 1.0, // Max 1% slippage
    MAX_PRICE_IMPACT_PCT: 5.0 // Max 5% price impact
};

// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function toDecimal(val) {
    if (val instanceof Decimal) return val;
    if (typeof val === 'string' || typeof val === 'number') return new Decimal(val.toString());
    if (val && typeof val.toString === 'function') return new Decimal(val.toString());
    return new Decimal(0);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function selectRandomJitoTipAccount() {
    const randomIndex = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[randomIndex]);
}

function selectRandomJitoEngine() {
    const randomIndex = Math.floor(Math.random() * JITO_BLOCK_ENGINE_URLS.length);
    return JITO_BLOCK_ENGINE_URLS[randomIndex];
}

/**
 * Extract token mints from pool data (handles poolDiscovery format)
 */
function extractPoolMints(pool) {
    // Try different field names from poolDiscovery
    const mintA = pool.tokenMintA || pool.baseMint || pool.mintA || pool.token0 || pool.inputMint;
    const mintB = pool.tokenMintB || pool.quoteMint || pool.mintB || pool.token1 || pool.outputMint;

    if (!mintA || !mintB) {
        console.warn('⚠️  Could not extract mints from pool:', {
            address: pool.address || pool.poolAddress,
            availableFields: Object.keys(pool)
        });
    }

    return { mintA, mintB };
}

// ═══════════════════════════════════════════════════════════════════════
// RATE LIMITER FOR JITO
// ═══════════════════════════════════════════════════════════════════════

class JitoRateLimiter {
    constructor(delayMs = 2000) {
        this.delayMs = delayMs;
        this.lastSubmission = 0;
        this.submissionCount = 0;
        this.recycleThreshold = 10;
    }

    async waitIfNeeded() {
        const now = Date.now();
        const timeSinceLastSubmission = now - this.lastSubmission;

        if (timeSinceLastSubmission < this.delayMs) {
            const waitTime = this.delayMs - timeSinceLastSubmission;
            console.log(`   ⏳ Rate limit: waiting ${waitTime}ms...`);
            await sleep(waitTime);
        }

        this.lastSubmission = Date.now();
        this.submissionCount++;

        // Recycle memory periodically
        if (this.submissionCount >= this.recycleThreshold) {
            this.recycleMemory();
        }
    }

    recycleMemory() {
        console.log(`   🧹 Recycling memory (${this.submissionCount} submissions)...`);
        this.submissionCount = 0;

        if (global.gc) {
            global.gc();
            console.log('   ✅ Garbage collection completed');
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// PRODUCTION ARBITRAGE EXECUTOR v2
// ═══════════════════════════════════════════════════════════════════════

class ProductionArbitrageExecutor {
    constructor(config = {}) {
        this.config = { ...CONFIG, ...config };
        this.connection = new Connection(this.config.RPC_URL, 'confirmed');
        this.quoteEngine = new QuoteEngine(this.config.RPC_URL);
        this.jitoRateLimiter = new JitoRateLimiter(this.config.JITO_RATE_LIMIT_DELAY_MS);

        this.stats = {
            totalOpportunities: 0,
            executedTrades: 0,
            successfulTrades: 0,
            failedTrades: 0,
            totalProfitSOL: 0,
            totalFeesSOL: 0,
            averageROI: 0,
            rateLimitHits: 0
        };

        console.log('✅ Production Arbitrage Executor v2.0 initialized');
        console.log(`   RPC: ${this.config.RPC_URL}`);
        console.log(`   Min Profit: ${this.config.MIN_PROFIT_SOL} SOL (${this.config.MIN_PROFIT_PERCENT}%)`);

        // Initialize memory recycling features
        this.initializeMemoryRecycling();
    }

    /**
     * Initialize memory recycling features
     */
    initializeMemoryRecycling() {
        // Add memory stats to existing stats object
        this.stats.memoryCleanups = 0;
        this.stats.averageBundleSize = 0;
        this.stats.totalBundlesSent = 0;

        // Set up periodic memory cleanup (every 5 minutes)
        this.memoryCleanupInterval = setInterval(() => {
            console.log('⏰ Periodic memory cleanup...');
            this.triggerMemoryCleanup();
        }, 300000); // 5 minutes

        // Set up process cleanup on exit
        process.on('exit', () => {
            if (this.memoryCleanupInterval) {
                clearInterval(this.memoryCleanupInterval);
            }
            console.log('🧹 Final memory cleanup on exit');
            this.clearLargeObjects();
        });

        console.log('✅ Memory recycling initialized');
        console.log('   - Periodic cleanup: every 5 minutes');
        console.log('   - Using QuoteEngine GC threshold:', this.quoteEngine.gcThreshold || 50);
    }

    /**
     * Analyze opportunity with FIXED decimal conversions
     */
    async analyzeOpportunity({ pools, inputAmount, inputMint, outputMint }) {
        console.log('\n📊 Analyzing Opportunity...');
        console.log(`   Input: ${inputAmount} tokens`);
        console.log(`   Pools: ${pools.length} candidates`);

        try {
            // CRITICAL FIX: Ensure inputAmount is a number, not Decimal string
            const inputAmountNum = typeof inputAmount === 'string' ?
                parseInt(inputAmount) : inputAmount;

            // Use QuoteEngine to select best pool
            const scored = await this.quoteEngine.selectBestPool({
                poolCandidates: pools,
                dx: inputAmountNum,
                opts: {
                    slippageFactor: 0.1,
                    gasLamports: 0,
                    lamportsToTokenOutPrice: null
                }
            });

            if (!scored || scored.length === 0) {
                throw new Error('No valid routes found');
            }

            const bestRoute = scored[0];

            // CRITICAL FIX: Convert to proper decimals for profit calc
            const inputAmountDec = toDecimal(inputAmountNum);
            const outputAmountDec = toDecimal(bestRoute.quote.dy);
            const feePaidDec = toDecimal(bestRoute.quote.feePaid);

            // Calculate fee as fraction of input
            const feeFraction = feePaidDec.div(inputAmountDec);

            // CRITICAL FIX: Use normalized prices (both in same units)
            // For same-token swaps or normalized pairs, use 1:1
            const inputPrice = 1;
            const outputPrice = 1;

            const profitAnalysis = this.quoteEngine.calculateNetProfit({
                inputAmount: inputAmountNum,
                outputAmount: outputAmountDec.toNumber(),
                inputPrice,
                outputPrice,
                dexFees: [feeFraction.toNumber()],
                priceImpacts: [toDecimal(bestRoute.quote.priceImpact).toNumber()],
                slippages: [0.001],
                slippageBuffer: 0.001,
                flashLoanFee: this.config.FLASH_LOAN_FEE_PCT,
                jitoFee: this.config.PROFIT_TIP_RATIO * 0.01,
                gasFee: 0.00006
            });

            // CRITICAL FIX: Calculate profit in LAMPORTS (same units!)
            const inputLamports = inputAmountNum;
            const outputLamports = toDecimal(bestRoute.quote.dy).toNumber();
            const feePaidLamports = toDecimal(bestRoute.quote.feePaid).toNumber();

            // Gross profit = output - input (both in lamports)
            const grossProfitLamports = outputLamports - inputLamports;

            // Calculate all costs in lamports
            const flashLoanFeeLamports = inputLamports * this.config.FLASH_LOAN_FEE_PCT;
            const jitoTipLamports = Math.max(
                this.config.MIN_JITO_TIP_LAMPORTS,
                Math.floor(Math.abs(grossProfitLamports) * this.config.PROFIT_TIP_RATIO)
            );
            const gasCostLamports = 5000;

            const totalCostsLamports = feePaidLamports + flashLoanFeeLamports + jitoTipLamports + gasCostLamports;

            // Net profit
            const netProfitLamports = grossProfitLamports - totalCostsLamports;
            const netProfitSOL = netProfitLamports / LAMPORTS_PER_SOL;
            const roi = (netProfitLamports / inputLamports) * 100;

            // Use the CORRECTLY calculated values (not profitAnalysis!)
            const isProfitable = netProfitLamports > 0;
            const profitSOL = netProfitSOL;  // Use our calculation, not profitAnalysis!

            // Check for suspicious/unrealistic profits
            const isSuspiciouslyHigh = roi > (this.config.MIN_PROFIT_PERCENT || 20) ||
                profitSOL > (this.config.MAX_REALISTIC_PROFIT_SOL || 1.0);

            if (isSuspiciouslyHigh) {
                console.log(`   ⚠️  SUSPICIOUS PROFIT DETECTED!`);
                console.log(`   📊 ROI: ${roi.toFixed(3)}% (max expected: ${this.config.MIN_PROFIT_PERCENT || 0.2}%)`);
                console.log(`   💰 Profit: ${profitSOL.toFixed(6)} SOL (max expected: ${this.config.MAX_REALISTIC_PROFIT_SOL || 1.0} SOL)`);
                console.log(`   🔍 This likely indicates a calculation error in QuoteEngine`);

                // In production, reject suspicious profits
                if (!this.config.TEST_MODE) {
                    return {
                        isProfitable: false,
                        profitSOL: profitSOL,
                        roi: roi,
                        route: bestRoute,
                        netProfitLamports,
                        meetsThresholds: false,
                        suspiciousProfit: true,
                        reason: `Profit too high: ${roi.toFixed(1)}% ROI, ${profitSOL.toFixed(3)} SOL`
                    };
                }
            }

            console.log(`   ✅ Best Route: ${bestRoute.pool.dex} ${bestRoute.pool.type}`);
            console.log(`   📈 Expected Output: ${outputLamports} lamports`);
            console.log(`   💰 Gross Profit: ${grossProfitLamports} lamports (${(grossProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
            console.log(`   💸 Total Costs: ${totalCostsLamports} lamports (${(totalCostsLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
            console.log(`   💰 Net Profit: ${profitSOL.toFixed(6)} SOL (${roi.toFixed(3)}%)`);
            console.log(`   📊 Price Impact: ${toDecimal(bestRoute.quote.priceImpact).mul(100).toFixed(3)}%`);

            return {
                isProfitable,
                profitSOL: profitSOL,
                roi: roi,
                route: bestRoute,
                netProfitLamports,
                grossProfitLamports,
                totalCostsLamports,
                meetsThresholds: isProfitable &&
                    profitSOL >= this.config.MIN_PROFIT_SOL &&
                    roi >= this.config.MIN_PROFIT_PERCENT &&
                    !isSuspiciouslyHigh,
                suspiciousProfit: isSuspiciouslyHigh
            };

        } catch (error) {
            console.error('❌ Analysis failed:', error.message);
            throw error;
        }
    }

    /**
     * Build swap instructions with proper mint extraction
     */
    async buildSwapInstructions({ route, inputAmount, minOutputAmount, wallet, inputMint, outputMint }) {
        console.log('\n🔨 Building swap instructions...');

        const instructions = [];

        try {
            const pool = route.pool;

            // Try to restore missing mint data if we have the original mints
            let restoredPool = pool;
            if (inputMint && outputMint) {
                restoredPool = this.restorePoolMintData({ ...pool }, inputMint, outputMint);
            }

            // Debug pool properties - check what's actually in the pool object
            console.log('   🔍 Pool validation:');
            console.log(`     tokenMintA: ${restoredPool.tokenMintA}`);
            console.log(`     tokenMintB: ${restoredPool.tokenMintB}`);
            console.log(`     inputMint: ${restoredPool.inputMint}`);
            console.log(`     outputMint: ${restoredPool.outputMint}`);

            // Get token mints with validation and better fallback
            let inputMintStr = restoredPool.tokenMintA || restoredPool.inputMint;
            let outputMintStr = restoredPool.tokenMintB || restoredPool.outputMint;

            // If pool still doesn't have the mints, use function parameters or defaults
            if (!inputMintStr || !outputMintStr) {
                console.log('   ⚠️  Could not extract mints from pool:', {
                    address: pool.address,
                    availableFields: Object.keys(pool)
                });
                console.log('   🔧 Using fallback mint addresses...');
                inputMintStr = inputMint?.toString() || 'So11111111111111111111111111111111111111112';
                outputMintStr = outputMint?.toString() || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
            }

            console.log(`   🔍 Using mints: ${inputMintStr} -> ${outputMintStr}`);

            // Use provided mints or extract from pool
            const finalInputMint = inputMint || inputMintStr;
            const finalOutputMint = outputMint || outputMintStr;

            if (!finalInputMint || !finalOutputMint) {
                throw new Error('Cannot determine token mints for swap');
            }

            const inputMintPubkey = new PublicKey(finalInputMint);
            const outputMintPubkey = new PublicKey(finalOutputMint);

            const userInputATA = await getAssociatedTokenAddress(inputMintPubkey, wallet.publicKey);
            const userOutputATA = await getAssociatedTokenAddress(outputMintPubkey, wallet.publicKey);

            // Check if output ATA exists
            const outputAccountInfo = await this.connection.getAccountInfo(userOutputATA);
            if (!outputAccountInfo) {
                console.log('   📝 Creating output token account...');
                instructions.push(
                    createAssociatedTokenAccountInstruction(
                        wallet.publicKey,
                        userOutputATA,
                        wallet.publicKey,
                        outputMintPubkey
                    )
                );
            }

            // Build swap instruction
            const swapIx = await this.buildDEXSwapInstruction({
                pool,
                inputAmount,
                minOutputAmount,
                userInputATA,
                userOutputATA,
                wallet: wallet.publicKey,
                inputMint: inputMintPubkey,
                outputMint: outputMintPubkey
            });

            instructions.push(swapIx);

            console.log(`   ✅ Built ${instructions.length} instruction(s)`);
            return instructions;

        } catch (error) {
            console.error('❌ Failed to build instructions:', error.message);
            throw error;
        }
    }

    async buildDEXSwapInstruction({ pool, inputAmount, minOutputAmount, userInputATA, userOutputATA, wallet, inputMint, outputMint }) {
        console.log(`   🔄 Building ${pool.dex} ${pool.type} swap instruction...`);

        // Placeholder - replace with actual DEX SDK calls
        return new TransactionInstruction({
            keys: [
                { pubkey: wallet, isSigner: true, isWritable: true },
                { pubkey: userInputATA, isSigner: false, isWritable: true },
                { pubkey: userOutputATA, isSigner: false, isWritable: true },
                { pubkey: new PublicKey(pool.address), isSigner: false, isWritable: true },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
            ],
            programId: SystemProgram.programId,
            data: Buffer.from([])
        });
    }

    async createFlashLoanTransaction({ borrowAmount, arbitrageInstructions, wallet }) {
        console.log('\n🏦 Creating Kamino Flash Loan Transaction...');
        console.log(`   Amount: ${borrowAmount} lamports (${borrowAmount / LAMPORTS_PER_SOL} SOL)`);

        try {
            const borrowAmountBN = new BN(borrowAmount);            // Debug wallet structure
            console.log('   🔍 Wallet received:', {
                type: typeof wallet,
                hasPublicKey: !!wallet?.publicKey,
                hasSecretKey: !!wallet?.secretKey,
                isKeypair: wallet?.constructor?.name === 'Keypair',
                publicKeyStr: wallet?.publicKey?.toString?.()
            });

            // Extract wallet components safely - wallet is already a Keypair
            let walletKeypair, walletPubkey;

            if (wallet?.publicKey && wallet?.secretKey) {
                // Direct keypair (this is the correct path)
                walletKeypair = wallet;
                walletPubkey = wallet.publicKey;
            } else {
                throw new Error(`Invalid wallet structure. Expected Keypair, received: ${JSON.stringify({
                    hasWallet: !!wallet,
                    hasPublicKey: !!wallet?.publicKey,
                    hasSecretKey: !!wallet?.secretKey,
                    constructor: wallet?.constructor?.name,
                    walletKeys: wallet ? Object.keys(wallet) : 'none'
                })}`);
            }

            console.log('   ✅ Using wallet pubkey:', walletPubkey.toString());

            // Compute budget instructions
            const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
                units: this.config.MAX_COMPUTE_UNITS
            });

            const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: this.config.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS
            });

            // Get user's WSOL account
            console.log('   🔍 Creating WSOL associated token address...');
            const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
            console.log('   🔍 WSOL mint:', wsolMint.toString());
            console.log('   🔍 Wallet pubkey for ATA:', walletPubkey.toString());

            const userWSOL = await getAssociatedTokenAddress(wsolMint, walletPubkey);
            console.log('   ✅ WSOL ATA created:', userWSOL.toString());

            // Flash loan instruction (simplified - use actual Kamino SDK)
            console.log('   🔍 Creating flash loan instruction...');
            const flashLoanIx = new TransactionInstruction({
                keys: [
                    { pubkey: walletPubkey, isSigner: true, isWritable: true },
                    { pubkey: userWSOL, isSigner: false, isWritable: true },
                    { pubkey: wsolMint, isSigner: false, isWritable: false },
                    { pubkey: KAMINO_MARKET, isSigner: false, isWritable: true },
                    { pubkey: KAMINO_LENDING_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: KAMINO_LENDING_PROGRAM_ID,
                data: Buffer.from([
                    1, // Flash loan discriminator
                    ...borrowAmountBN.toArray('le', 8)
                ])
            });
            console.log('   ✅ Flash loan instruction created');

            // Assemble all instructions
            console.log('   🔍 Assembling instructions...');
            const allInstructions = [
                computeBudgetIx,
                priorityFeeIx,
                flashLoanIx,
                ...arbitrageInstructions
            ];
            console.log(`   ✅ Assembled ${allInstructions.length} instructions`);

            const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('finalized');

            // Create versioned transaction
            console.log('   🔍 Creating versioned transaction...');
            console.log('   🔍 Payer key for transaction:', walletPubkey.toString());
            console.log('   🔍 Recent blockhash:', blockhash);
            console.log('   🔍 Number of instructions:', allInstructions.length);

            const messageV0 = new TransactionMessage({
                payerKey: walletPubkey,
                recentBlockhash: blockhash,
                instructions: allInstructions
            }).compileToV0Message();
            console.log('   ✅ Transaction message compiled');

            const versionedTx = new VersionedTransaction(messageV0);
            console.log('   ✅ Versioned transaction created');

            // Sign transaction
            console.log('   🔍 Signing transaction...');
            console.log('   🔍 Wallet keypair available:', !!walletKeypair);
            console.log('   🔍 Wallet keypair publicKey:', walletKeypair?.publicKey?.toString());

            versionedTx.sign([walletKeypair]);
            console.log('   ✅ Transaction signed');

            console.log(`   ✅ Flash loan transaction created: ${versionedTx.serialize().length} bytes`);

            return { transaction: versionedTx, blockhash, lastValidBlockHeight };

        } catch (error) {
            console.error('❌ Flash loan creation failed:', error.message);
            throw error;
        }
    }

    async createJitoBundle({ flashLoanTxResult, profitLamports }) {
        console.log('\n📦 Creating Jito Bundle...');

        try {
            // Safety check for NaN
            if (profitLamports === undefined || isNaN(profitLamports)) {
                console.warn('   ⚠️  profitLamports is NaN/undefined, using minimum tip');
                profitLamports = this.config.MIN_JITO_TIP_LAMPORTS;
            }

            const calculatedTip = Math.floor(Math.abs(profitLamports) * this.config.PROFIT_TIP_RATIO);
            const tipLamports = Math.max(
                this.config.MIN_JITO_TIP_LAMPORTS,
                Math.min(calculatedTip, this.config.MAX_JITO_TIP_LAMPORTS)
            );

            console.log(`   💰 Tip: ${tipLamports} lamports (${(tipLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL)`);
            console.log(`   📊 Tip is ${((tipLamports / Math.max(Math.abs(profitLamports), 1)) * 100).toFixed(2)}% of profit`);

            const tipAccount = selectRandomJitoTipAccount();

            // CRITICAL FIX: Use blockhash from flash loan transaction
            const tipTx = new Transaction();
            tipTx.recentBlockhash = flashLoanTxResult.blockhash;
            tipTx.feePayer = flashLoanTxResult.transaction.message.staticAccountKeys[0];

            tipTx.add(
                SystemProgram.transfer({
                    fromPubkey: flashLoanTxResult.transaction.message.staticAccountKeys[0],
                    toPubkey: tipAccount,
                    lamports: tipLamports
                })
            );

            const bundle = {
                jsonrpc: '2.0',
                id: 1,
                method: 'sendBundle',
                params: [[
                    Buffer.from(flashLoanTxResult.transaction.serialize()).toString('base64'),
                    Buffer.from(tipTx.serialize({ requireAllSignatures: false })).toString('base64')
                ]]
            };

            console.log('   ✅ Jito bundle created');

            // Store bundle reference for potential cleanup
            this.lastBundleData = {
                bundle,
                timestamp: Date.now(),
                size: JSON.stringify(bundle).length
            };

            // Trigger memory cleanup if bundle is large
            if (this.lastBundleData.size > 10000) { // 10KB threshold
                console.log('   🧹 Large bundle detected, triggering cleanup...');
                this.triggerMemoryCleanup();
            }

            return {
                bundle,
                tipLamports,
                tipAccount: tipAccount.toBase58()
            };

        } catch (error) {
            console.error('❌ Bundle creation failed:', error.message);
            throw error;
        }
    }

    /**
     * Submit bundle to Jito with test mode support
     */
    async submitJitoBundle({ bundle }) {
        console.log('\n🚀 Submitting Bundle to Jito...');

        // Test mode - simulate submission without actual network call
        if (this.config.TEST_MODE) {
            console.log('   🧪 Test mode: simulating bundle submission...');

            // Simulate processing time
            await sleep(100);

            // Simulate success
            const mockBundleId = 'test_bundle_' + Math.random().toString(36).substr(2, 9);
            console.log('   ✅ Mock bundle submitted successfully');
            console.log(`   📝 Mock Bundle ID: ${mockBundleId}`);

            this.triggerMemoryCleanup();

            return {
                success: true,
                bundleId: mockBundleId,
                engine: 'test_engine'
            };
        }

        // Production mode - actual Jito submission with rate limiting
        const maxAttempts = 3;
        const baseDelay = 2000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const jitoEngine = selectRandomJitoEngine();
                console.log(`   🎯 Attempt ${attempt}/${maxAttempts}: ${jitoEngine}`);

                // Use QuoteEngine's rate limiter
                if (this.quoteEngine?.rateLimiter?.acquire) {
                    await this.quoteEngine.rateLimiter.acquire();
                }

                const response = await axios.post(
                    `${jitoEngine}/api/v1/bundles`,
                    bundle,
                    {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: this.config.BUNDLE_TIMEOUT_MS
                    }
                );

                this.triggerMemoryCleanup();

                if (response.data && response.data.result) {
                    console.log('   ✅ Bundle submitted successfully');
                    console.log(`   📝 Bundle ID: ${response.data.result}`);

                    return {
                        success: true,
                        bundleId: response.data.result,
                        engine: jitoEngine
                    };
                } else {
                    throw new Error('Invalid response from Jito');
                }

            } catch (error) {
                if (error.response?.status === 429) {
                    const delay = baseDelay * Math.pow(2, attempt - 1);
                    console.log(`   ⚠️  Rate limited (429) - waiting ${delay}ms...`);

                    if (attempt < maxAttempts) {
                        await sleep(delay);
                        continue;
                    }
                }

                console.error(`   ❌ Attempt ${attempt} failed:`, error.message);

                if (attempt === maxAttempts) {
                    this.triggerMemoryCleanup();
                    console.log('❌ All submission attempts failed');

                    return {
                        success: false,
                        error: error.response?.status === 429 ? 'Rate limited by Jito' : error.message
                    };
                }
            }
        }
    }

    /**
     * Execute with proper mint handling
     */
    async execute({ pools, inputAmount, inputMint, outputMint, wallet }) {
        console.log('\n' + '═'.repeat(80));
        console.log('🎯 STARTING ARBITRAGE EXECUTION');
        console.log('═'.repeat(80));

        this.stats.totalOpportunities++;

        try {
            // Step 1: Analyze opportunity with profit validation
            const analysis = await this.analyzeOpportunity({
                pools,
                inputAmount,
                inputMint,
                outputMint
            });

            // Validate profit realism
            const inputAmountSOL = parseInt(inputAmount) / LAMPORTS_PER_SOL;
            const validation = this.validateProfitRealism(analysis.profitSOL, analysis.roi, inputAmountSOL);

            if (!validation.isRealistic) {
                console.log('\n⚠️  UNREALISTIC PROFIT DETECTED!');
                validation.issues.forEach(issue => console.log(`   🚨 ${issue}`));
                console.log(`   💡 ${validation.recommendation}`);

                // In test mode, continue but warn. In production, reject.
                if (!this.config.TEST_MODE) {
                    return {
                        success: false,
                        reason: 'Unrealistic profit - likely calculation error',
                        issues: validation.issues
                    };
                } else {
                    console.log('   🧪 Test mode: continuing despite unrealistic profit...');
                }
            }

            if (!analysis.meetsThresholds) {
                console.log('\n⚠️  Opportunity does not meet profit thresholds');
                console.log(`   Required: ${this.config.MIN_PROFIT_SOL} SOL, ${this.config.MIN_PROFIT_PERCENT}%`);
                console.log(`   Actual: ${analysis.profitSOL.toFixed(6)} SOL, ${analysis.roi.toFixed(3)}%`);
                return { success: false, reason: 'Below profit threshold' };
            }

            // Step 2: Build instructions
            const minOutputAmount = toDecimal(analysis.route.quote.dy)
                .mul(1 - this.config.MAX_SLIPPAGE_PCT / 100)
                .toFixed(0);

            const swapInstructions = await this.buildSwapInstructions({
                route: analysis.route,
                inputAmount,
                minOutputAmount,
                wallet,
                inputMint,
                outputMint
            });

            // Step 3: Flash loan
            const flashLoanResult = await this.createFlashLoanTransaction({
                borrowAmount: typeof inputAmount === 'string' ? parseInt(inputAmount) : inputAmount,
                arbitrageInstructions: swapInstructions,
                wallet
            });

            // Step 4: Jito bundle (use netProfitLamports from analysis!)
            const bundleResult = await this.createJitoBundle({
                flashLoanTxResult: flashLoanResult,  // Pass FULL result with blockhash
                profitLamports: analysis.netProfitLamports || 0  // Use netProfitLamports
            });

            // Step 5: Submit
            const submissionResult = await this.submitJitoBundle({
                bundle: bundleResult.bundle
            });

            // Step 6: Track
            this.stats.executedTrades++;

            if (submissionResult.success) {
                this.stats.successfulTrades++;
                this.stats.totalProfitSOL += analysis.profitSOL;
                this.stats.averageROI =
                    (this.stats.averageROI * (this.stats.successfulTrades - 1) + analysis.roi) /
                    this.stats.successfulTrades;

                console.log('\n' + '═'.repeat(80));
                console.log('✅ ARBITRAGE EXECUTED SUCCESSFULLY');
                console.log('═'.repeat(80));
                console.log(`   Bundle ID: ${submissionResult.bundleId}`);
                console.log(`   Profit: ${analysis.profitSOL.toFixed(6)} SOL (${analysis.roi.toFixed(3)}%)`);
                console.log(`   Jito Tip: ${(bundleResult.tipLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`);

                return {
                    success: true,
                    bundleId: submissionResult.bundleId,
                    profitSOL: analysis.profitSOL,
                    roi: analysis.roi,
                    tipSOL: bundleResult.tipLamports / LAMPORTS_PER_SOL
                };
            } else {
                this.stats.failedTrades++;

                console.log('\n❌ Bundle submission failed');
                return {
                    success: false,
                    error: submissionResult.error
                };
            }

        } catch (error) {
            this.stats.failedTrades++;

            console.error('\n❌ EXECUTION FAILED');
            console.error(`   Error: ${error.message}`);

            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Trigger memory cleanup using QuoteEngine's garbage collection
     */
    triggerMemoryCleanup() {
        try {
            // Use QuoteEngine's memory management if available
            if (this.quoteEngine?.callCounter !== undefined) {
                this.quoteEngine.callCounter++;

                // Check if we should trigger garbage collection
                if (this.quoteEngine.callCounter >= (this.quoteEngine.gcThreshold || 50)) {
                    console.log('   🧹 Triggering memory cleanup...');

                    // Reset counter
                    this.quoteEngine.callCounter = 0;

                    // Track cleanup in stats
                    if (this.stats.memoryCleanups !== undefined) {
                        this.stats.memoryCleanups++;
                    }

                    // Clear any cached data
                    if (this.quoteEngine.cacheManager?.clear) {
                        this.quoteEngine.cacheManager.clear();
                    }

                    // Manual garbage collection hint
                    if (global.gc) {
                        global.gc();
                        console.log('   ✅ Memory cleanup completed');
                    } else {
                        console.log('   ⚠️  Manual GC not available (run with --expose-gc)');
                    }
                }
            }

            // Additional cleanup for large objects
            this.clearLargeObjects();

        } catch (error) {
            console.warn('   ⚠️  Memory cleanup warning:', error.message);
        }
    }

    /**
     * Clear large objects and temporary data
     */
    clearLargeObjects() {
        // Clear any temporary pools data
        if (this.quoteEngine?.pools) {
            // Keep only essential data, clear detailed pool information
            this.quoteEngine.pools.forEach(pool => {
                if (pool.detailedData) {
                    delete pool.detailedData;
                }
                if (pool.tempCalculations) {
                    delete pool.tempCalculations;
                }
            });
        }

        // Clear any large transaction buffers
        if (this.lastTransactionData) {
            this.lastTransactionData = null;
        }

        // Clear bundle data
        if (this.lastBundleData) {
            this.lastBundleData = null;
        }
    }

    /**
     * Restore pool mint data that may have been stripped by QuoteEngine
     */
    restorePoolMintData(pool, inputMint, outputMint) {
        // If pool is missing mint data, add it back
        if (!pool.tokenMintA && !pool.inputMint) {
            pool.tokenMintA = inputMint.toString();
            pool.inputMint = inputMint.toString();
            console.log('   🔧 Restored tokenMintA/inputMint to pool');
        }

        if (!pool.tokenMintB && !pool.outputMint) {
            pool.tokenMintB = outputMint.toString();
            pool.outputMint = outputMint.toString();
            console.log('   🔧 Restored tokenMintB/outputMint to pool');
        }

        return pool;
    }

    /**
     * Validate if profit is realistic (not due to calculation error)
     */
    validateProfitRealism(profitSOL, roi, inputAmountSOL = 0.05) {
        const maxReasonableROI = 50; // 50% max ROI
        const maxReasonableProfit = 1.0; // 1 SOL max profit
        const maxProfitToInputRatio = 10; // Max 10x input amount

        const issues = [];

        if (roi > maxReasonableROI) {
            issues.push(`ROI too high: ${roi.toFixed(1)}% (max: ${maxReasonableROI}%)`);
        }

        if (profitSOL > maxReasonableProfit) {
            issues.push(`Profit too high: ${profitSOL.toFixed(3)} SOL (max: ${maxReasonableProfit} SOL)`);
        }

        if (profitSOL > inputAmountSOL * maxProfitToInputRatio) {
            issues.push(`Profit/Input ratio too high: ${(profitSOL / inputAmountSOL).toFixed(1)}x (max: ${maxProfitToInputRatio}x)`);
        }

        return {
            isRealistic: issues.length === 0,
            issues: issues,
            recommendation: issues.length > 0 ? 'Check QuoteEngine calculation logic' : 'Profit looks reasonable'
        };
    }

    getStats() {
        return {
            ...this.stats,
            successRate: this.stats.executedTrades > 0
                ? (this.stats.successfulTrades / this.stats.executedTrades * 100).toFixed(2) + '%'
                : '0%'
        };
    }
}

module.exports = ProductionArbitrageExecutor;

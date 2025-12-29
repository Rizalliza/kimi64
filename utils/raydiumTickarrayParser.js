// ---------------------------------------------------------------
// RAYDIUM CLMM TICK-ARRAY PARSER  (specialized, fast, accurate)
// ---------------------------------------------------------------
async function fetchRaydiumClmmTicks(connection, poolAddress) {
    if (!RaydiumSdkV2 || !RaydiumSdkV2.Clmm) return null;

    try {
        const poolPk = new PublicKey(poolAddress);

        // 1) Fetch the CLMM pool state
        const poolState = await RaydiumSdkV2.Clmm.fetchPoolState(connection, poolPk);
        if (!poolState) return null;

        const { tickSpacing, tickArrayBitmap, tickArrayCurrentIndex } = poolState;

        const tickArrayAddresses = RaydiumSdkV2.Clmm.getTickArrayAddresses(
            poolPk,
            tickArrayCurrentIndex,
            tickSpacing
        );

        // 2) Fetch all tick arrays in parallel
        const tickArrays = await RaydiumSdkV2.Clmm.fetchMultipleTickArrays(
            connection,
            tickArrayAddresses
        );

        // 3) Flatten tick data
        let ticks = [];
        for (let arr of tickArrays) {
            if (!arr || !arr.ticks) continue;
            for (let t of arr.ticks) {
                ticks.push({
                    index: t.index,
                    price: t.price, // Decimal
                    liquidityGross: t.liquidityGross,
                    liquidityNet: t.liquidityNet,
                    feeGrowthOutsideA: t.feeGrowthOutsideA,
                    feeGrowthOutsideB: t.feeGrowthOutsideB,
                });
            }
        }

        return {
            poolState,
            ticks,
            tickSpacing,
            tickArrays: tickArrayAddresses.map(a => a.toBase58()),
        };
    } catch (err) {
        console.error('Raydium CLMM fetch error:', err.message);
        return null;
    }
}

// ----------------------------------------------
// Raydium CPMM + Raydium CLMM full support
// ----------------------------------------------
if (pool.dex === 'raydium') {
    if (!pool.rawState) {
        try {
            if (RaydiumSdkV2 && RaydiumSdkV2.fetcher) {
                pool.rawState = await RaydiumSdkV2.fetcher.getPoolState(
                    connection,
                    new PublicKey(pool.poolAddress)
                );
            }
        } catch (_) { }
    }

    // Detect CLMM
    const isClmm =
        pool.type === 'clmm' ||
        (pool.rawState && pool.rawState.tickSpacing !== undefined);

    if (isClmm) {
        const clmmInfo = await fetchRaydiumClmmTicks(connection, pool.poolAddress);
        if (clmmInfo) {
            pool.type = 'clmm';
            pool.clmm = clmmInfo;
            pool.meta.source = 'sdk';
        }
    }
}

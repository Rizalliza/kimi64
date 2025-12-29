// ---------------------------------------------------------------
// METEORA DLMM BIN PARSER  (fast, accurate, recommended)
// ---------------------------------------------------------------
async function fetchMeteoraDlmmBins(connection, poolAddress) {
    if (!MeteoraSdk) return null;

    try {
        const poolPk = new PublicKey(poolAddress);

        // 1) Fetch DLMM pool state
        let rawPool = null;
        if (MeteoraSdk.fetchPoolState) {
            rawPool = await MeteoraSdk.fetchPoolState(connection, poolPk);
        } else if (MeteoraSdk.DlmmClient) {
            const client = new MeteoraSdk.DlmmClient(connection);
            rawPool = await client.fetchPool(poolPk);
        }

        if (!rawPool) return null;

        const binStep = rawPool.binStep || rawPool.bin_size;
        const totalBins = rawPool.totalBins || rawPool.numBins || 128;

        const bins = [];

        // 2) Fetch all bins in parallel
        const binPromises = [];
        for (let i = 0; i < totalBins; i++) {
            binPromises.push(
                fetchSingleBin(connection, poolPk, i).catch(_ => null)
            );
        }

        const binResults = await Promise.all(binPromises);

        for (let i = 0; i < binResults.length; i++) {
            const b = binResults[i];
            if (!b) continue;

            bins.push({
                index: i,
                price: b.price,
                weightX: b.weightX,
                weightY: b.weightY,
                liquidityX: b.liquidityX,
                liquidityY: b.liquidityY
            });
        }

        // sort for convenience
        bins.sort((a, b) => a.index - b.index);

        return {
            rawPool,
            bins,
            binStep,
            totalBins
        };
    } catch (err) {
        console.error("Meteora DLMM error:", err.message);
        return null;
    }
}

// Helper for single bin fetch
async function fetchSingleBin(connection, poolPk, binIndex) {
    if (!MeteoraSdk || !MeteoraSdk.Dlmm) return null;

    try {
        const binPda = MeteoraSdk.Dlmm.getBinAddress(poolPk, binIndex);
        const acct = await connection.getAccountInfo(binPda);

        if (!acct) return null;

        const decoded = MeteoraSdk.Dlmm.decodeBin(acct.data);

        return {
            price: decoded.price,
            weightX: decoded.weightX,
            weightY: decoded.weightY,
            liquidityX: decoded.liquidityX,
            liquidityY: decoded.liquidityY
        };
    } catch (_) {
        return null;
    }
}

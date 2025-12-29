// ---------------------------------------------------------------
// ORCA WHIRLPOOLS TICK-ARRAY PARSER (specialized, fast, accurate)
// ---------------------------------------------------------------
async function fetchOrcaWhirlpoolTicks(connection, poolAddress) {
    if (!OrcaWhirlpoolSdk) return null;
    const { WhirlpoolContext, buildWhirlpoolClient, PDAUtil } = OrcaWhirlpoolSdk;

    try {
        // 1) Build read-only context
        const ctx = WhirlpoolContext.withConnection(connection);
        const client = buildWhirlpoolClient(ctx);
        const whirlpool = await client.getPool(new PublicKey(poolAddress));

        if (!whirlpool) return null;

        const whirlpoolData = whirlpool.getData();
        const { tickSpacing } = whirlpoolData;

        // 2) Derive all tick array PDAs for the price range
        const tickArrayPubkeys = [];
        for (let i = -10; i <= 10; i++) {
            const addr = PDAUtil.getTickArray(
                ctx.program.programId,
                whirlpool.getAddress(),
                i * tickSpacing
            ).publicKey;
            tickArrayPubkeys.push(addr);
        }

        // 3) Fetch all tick arrays
        const tickArrays = await whirlpool.getTickArrays(tickArrayPubkeys, true);

        // 4) Extract raw tick data
        const ticks = [];
        for (const ta of tickArrays) {
            if (!ta) continue;
            for (const t of ta.getData().ticks) {
                ticks.push({
                    index: t.index,
                    liquidityNet: t.liquidityNet,
                    liquidityGross: t.liquidityGross,
                    initializable: t.initialized,
                    price: whirlpool.getPriceFromTick(t.index).toString(),
                });
            }
        }

        return {
            whirlpoolData,
            ticks,
            tickSpacing,
            tickArrays: tickArrayPubkeys.map(p => p.toBase58()),
        };
    } catch (err) {
        console.error('Orca Whirlpool fetch error:', err.message);
        return null;
    }
}

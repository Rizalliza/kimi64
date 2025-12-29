// ----------------------------------------------
// ORCA WHIRLPOOLS full tick-array support
// ----------------------------------------------
if (pool.dex === 'orca') {
    const orcaInfo = await fetchOrcaWhirlpoolTicks(connection, pool.poolAddress);
    if (orcaInfo) {
        pool.type = 'clmm';
        pool.rawWhirlpool = orcaInfo.whirlpoolData;
        pool.orca = orcaInfo;
        pool.meta.source = 'sdk';
    }
}

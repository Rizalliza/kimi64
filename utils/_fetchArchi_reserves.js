/*

unset FORCE_FRESH
unset FORCE_RESERVE_REFRESH
unset FRESH_MAX_AGE_MS
unset RESERVE_FRESH_MS

node _fetchArchi_reserves.js poolMeta/meta_fullRaw_1000.json poolaEnriched/pools_canonical_1000.json
# Expect: "Wrote pools_canonical.json pools: <N>"(ideally 261 or more)


export DEX_ALLOWLIST = "meteora,orca,raydium"
export ENABLE_ANCHOR_BAND = 1
export ANCHOR_BAND_PCT = 20
export MAX_IMPACT_PCT_PER_LEG = 1
export SLIPPAGE_BPS = 50

node runTriangular_NewEngine_FIXED.js pools_canonical.json 0.5



*/

// unifiedReservesFetcher.js — CLEAN
'use strict';

function finalizeReserves(pools) {
    // Accept both env names for compatibility
    const FORCE =
        process.env.FORCE_FRESH === '1' ||
        process.env.FORCE_RESERVE_REFRESH === '1';

    // 0 = no age gating
    const FRESH_MS = Number(process.env.FRESH_MAX_AGE_MS || process.env.RESERVE_FRESH_MS || '0');

    let ready = 0, total = 0, hadRes = 0, nulled = 0, agedOut = 0, noTs = 0;

    for (const p of pools) {
        total++;

        if (FORCE) {
            // Only clear here when FORCE is set
            if (p.xReserve != null || p.yReserve != null) nulled++;
            p.xReserve = null;
            p.yReserve = null;
            p.isMathReady = false;
            continue;
        }

        const hasXY = (p.xReserve != null && p.yReserve != null);
        if (hasXY) hadRes++;

        // default: fresh if no ts is provided (we don't punish missing timestamps)
        let freshEnough = true;
        if (FRESH_MS > 0) {
            let ts = null;
            if (p.meta && (p.meta.ts != null || p.meta.timestamp != null)) {
                ts = Number(p.meta.ts ?? p.meta.timestamp);
            } else if (p.lastUpdated != null) {
                ts = Number(p.lastUpdated);
            }
            if (Number.isFinite(ts)) {
                freshEnough = (Date.now() - ts) <= FRESH_MS;
                if (!freshEnough && hasXY) agedOut++;
            } else {
                noTs++;
                // treat missing ts as fresh
                freshEnough = true;
            }
        }

        if (hasXY && freshEnough) { p.isMathReady = true; ready++; }
        else { p.isMathReady = false; }
    }

    console.log('finalizeReserves: ',
        JSON.stringify({ total, hadRes, FORCE, FRESH_MS, nulled, agedOut, noTs, ready })
    );

    return { ready, total };
}

module.exports = { finalizeReserves };

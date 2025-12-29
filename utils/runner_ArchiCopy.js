
// node runner_Archi.js poolsEnriched/pools_canonical_1000.json 10 --strip-reserves --hydrate=poolsEnriched/fresh.json
'use strict';

const fs = require('fs');
const { finalizeReserves } = require('./_fetchArchi_reserves.js');
const { findTriangularRoutes, topFlashloanCandidates } = require('./_engineCopy.js');
require('dotenv').config

const MINT_SOL = 'So11111111111111111111111111111111111111112';
const MINT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

ENV: {
    process.env.FORCE_FRESH,
        process.env.FORCE_RESERVE_REFRESH,
        process.env.FRESH_MAX_AGE_MS,
        process.env.RESERVE_FRESH_MS,
        process.env.DEX_ALLOWLIST
};

// ---------- arg/flag parsing ----------
function parseFlags(argv) {
    const flags = {};
    for (const a of argv) {
        if (!a.startsWith('--')) continue;
        const i = a.indexOf('=');
        if (i > 2) flags[a.slice(2, i)] = a.slice(i + 1);
        else flags[a.slice(2)] = true;
    }
    return flags;
}
const argv = process.argv.slice(2);
const flags = parseFlags(argv);
const positionals = argv.filter(a => !a.startsWith('--'));
const inPath = positionals[0];
const amountA = positionals[1] || '1.0';

if (!inPath) {
    console.error('Usage: node runnerArchi.js <poolMeta/meta_fullRaw_1000.json> [amountSOL] [--strip-reserves] [--hydrate=fresh.json]');
    process.exit(1);
}

// ---------- helpers ----------
function isDexAllowed(p) {
    const allow = (process.env.DEX_ALLOWLIST || 'meteora,orca,raydium')
        .split(',').map(s => s.trim().toLowerCase());
    return allow.includes(String(p.dex || '').toLowerCase());
}

function bestSolUsdcMid(pools) {
    let best = null;
    for (const p of pools) {
        const isPair = (p.baseMint === MINT_SOL && p.quoteMint === MINT_USDC) ||
            (p.baseMint === MINT_USDC && p.quoteMint === MINT_SOL);
        if (!isPair) continue;
        if (p.xReserve == null || p.yReserve == null) continue;
        const x = BigInt(p.xReserve), y = BigInt(p.yReserve);
        const usdcSide = (p.baseMint === MINT_USDC) ? x : y;
        const solSide = (p.baseMint === MINT_SOL) ? x : y;
        if (!best || usdcSide > best.usdcSide) {
            const mid = Number(usdcSide) / Math.max(1, Number(solSide));
            best = { mid, usdcSide };
        }
    }
    return best ? best.mid : null;
}

function impliedUsdcPerSolFromRoute(r) {
    try {
        const aInSOL = Number(r.amountAIn) / 1e9;
        const usdcOut = Number(r.legs?.[1]?.expectedOut || 0) / 1e6;
        if (!aInSOL || !usdcOut) return null;
        return usdcOut / aInSOL;
    } catch { return null; }
}

function filterByAnchorBand(routes, pools) {
    if (process.env.ENABLE_ANCHOR_BAND !== '1') return routes;
    const anchorMid = bestSolUsdcMid(pools);
    if (!anchorMid || !Number.isFinite(anchorMid)) return routes;
    const bandPct = Number(process.env.ANCHOR_BAND_PCT || '20');
    const minMid = anchorMid * (1 - bandPct / 100), maxMid = anchorMid * (1 + bandPct / 100);
    let kept = 0, dropped = 0; const out = [];
    for (const r of routes) {
        const implied = impliedUsdcPerSolFromRoute(r);
        if (!implied || !Number.isFinite(implied)) { dropped++; continue; }
        if (implied < minMid || implied > maxMid) { dropped++; continue; }
        kept++; out.push(r);
    }
    console.log('AnchorBand:', { anchorMid: Number(anchorMid).toFixed(4), bandPct, kept, dropped });
    return out;
}

function passLegGuards(route, pools) {
    const maxImp = Number(process.env.MAX_IMPACT_PCT_PER_LEG || '0');
    const minOutRes = BigInt(process.env.MIN_OUTPUT_RESERVE_ATOMIC || '0');
    if (!maxImp && minOutRes === 0n) return true;
    for (const lg of route.legs || []) {
        if (maxImp && Number(lg.impactPct || 0) > maxImp) return false;
        if (minOutRes > 0n) {
            const pool = pools.find(p => (p.poolAddress || p.address) === lg.pool);
            if (!pool || pool.xReserve == null || pool.yReserve == null) return false;
            const x = BigInt(pool.xReserve), y = BigInt(pool.yReserve);
            const outIsBase = (lg.to === pool.baseMint);
            const outRes = outIsBase ? x : y;
            if (outRes < minOutRes) return false;
        }
    }
    return true;
}

function toHumanAmtAtomic(atomicStr, decimals = 9) {
    if (!atomicStr) return '0';
    const s = atomicStr.toString();
    const pad = s.padStart(decimals + 1, '0');
    const i = pad.slice(0, -decimals) || '0';
    const f = pad.slice(-decimals).replace(/0+$/, '');
    return f ? `${i}.${f}` : i;
}
function short(m) {
    if (m === MINT_SOL) return 'SOL';
    if (m === MINT_USDC) return 'USDC';
    return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

// strip embedded reserves in-memory
function stripReserves(pools) {
    let n = 0;
    for (const p of pools) {
        if (p.xReserve != null || p.yReserve != null) n++;
        p.xReserve = null; p.yReserve = null;
        if (!p.meta) p.meta = {};
        p.meta.source = 'stripped';
        p.meta.ts = 0;
    }
    console.log(`--strip-reserves → stripped reserves on ${n} pools (in-memory).`);
}

// hydrate reserves from overlay JSON (support multiple shapes and ids)
function hydrateFromFile(pools, path) {
    const raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw.pools) ? raw.pools : []);
    const idx = new Map();

    function keyOf(o) {
        return String(
            o.poolAddress || o.address || o.id || o.pool || o.stateId || ''
        );
    }
    for (const o of arr) {
        const k = keyOf(o);
        if (k) idx.set(k, o);
    }

    let matched = 0, haveXY = 0;
    for (const p of pools) {
        const id = String(p.poolAddress || p.address || p.id || p.pool || p.stateId || '');
        const o = idx.get(id);
        if (!o) continue;

        let xr = o.xReserve ?? (o.reserves && o.reserves.x) ?? o.reserveX ?? o.liquidityX ?? null;
        let yr = o.yReserve ?? (o.reserves && o.reserves.y) ?? o.reserveY ?? o.liquidityY ?? null;

        if (xr != null && yr != null) {
            p.xReserve = xr;
            p.yReserve = yr;
            haveXY++;
        }
        if (!p.meta) p.meta = {};
        p.meta.ts = Number((o.meta && (o.meta.ts ?? o.meta.timestamp)) ?? o.lastUpdated ?? Date.now());
        matched++;
    }
    console.log(`--hydrate=${path} → matched ${matched}/${pools.length} pools, withRes=${haveXY}`);
}

// ---------- main ----------
async function main() {
    console.log('ENV:', {
        FORCE_FRESH: process.env.FORCE_FRESH,
        FORCE_RESERVE_REFRESH: process.env.FORCE_RESERVE_REFRESH,
        FRESH_MAX_AGE_MS: process.env.FRESH_MAX_AGE_MS,
        RESERVE_FRESH_MS: process.env.RESERVE_FRESH_MS,
        //DEX_ALLOWLIST: process.env.DEX_ALLOWLIST
    });

    const pools = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
    const preHave = pools.filter(p => p.xReserve != null && p.yReserve != null).length;
    console.log('Loaded pools:', pools.length, '| with reserves:', preHave);

    if (flags['strip-reserves'] || flags['strip'] === 'reserves' || flags['stripreserves'])
        stripReserves(pools);

    if (flags['hydrate'])
        hydrateFromFile(pools, flags['hydrate']);

    const postHave = pools.filter(p => p.xReserve != null && p.yReserve != null).length;
    console.log('After strip/hydrate, with reserves:', postHave);

    const { ready, total } = finalizeReserves(pools);
    console.log('Math-ready pools:', ready, '/', total);

    // filter (your debug IIFE kept)
    const { kept, stats } = (function debugKeepMore(p) {
        const k = []; let noRes = 0, below = 0;
        for (const x of p) {
            if (x.xReserve == null || x.yReserve == null) { noRes++; continue; }
            const hasUSDC = (x.baseMint === MINT_USDC) || (x.quoteMint === MINT_USDC);
            const hasSOL = (x.baseMint === MINT_SOL) || (x.quoteMint === MINT_SOL);
            if (hasUSDC || hasSOL) k.push(x); else below++;
        }
        return { kept: k, stats: { total: p.length, kept: k.length, noRes, below } };
    })(pools);

    console.log(
        'Kept SOL/* pools:',
        kept.filter(p => p.baseMint === MINT_SOL || p.quoteMint === MINT_SOL).length,
        '| Kept USDC/* (all):',
        kept.filter(p => p.baseMint === MINT_USDC || p.quoteMint === MINT_USDC).length,
        '| below:', stats.below,
        '| noRes:', stats.noRes,
        '| total:', stats.total,
        '| kept:', stats.kept
    );

    if (ready === 0 && postHave > 0) {
        console.log('DIAG: finalizeReserves gated everything. Check FORCE_FRESH / FORCE_RESERVE_REFRESH / FRESH_MAX_AGE_MS / RESERVE_FRESH_MS.');
    }
    if (postHave === 0 && preHave > 0) {
        console.log('DIAG: strip/hydrate removed reserves. Double-check flags and hydrate file identifiers.');
    }

    // scan
    const routesRaw = await findTriangularRoutes(kept, {
        mintA: MINT_SOL, mintC: MINT_USDC, decimalsA: 9, amountAHuman: amountA
    });

    // guards
    const routes1 = filterByAnchorBand(routesRaw, kept);
    const routes2 = routes1.filter(r => passLegGuards(r, kept));

    fs.writeFileSync('Archi_triangular_routes.json', JSON.stringify(routes2.slice(0, 50), null, 2));
    console.log('Wrote Archi_triangular_routes.json routes:', routes2.length);

    const slippageBps = Number(process.env.SLIPPAGE_BPS || '50');
    const top5 = topFlashloanCandidates(routes2, 5, slippageBps, 9);
    fs.writeFileSync('flashloan_top5.json', JSON.stringify(top5, null, 2));
    console.log('Wrote flashloan_top5.json top-5 candidates with slippageBps=' + slippageBps);

    console.log('==== Candidate summary (sorted by rank) ====');
    console.log('rank  route                         profit%   ROI×    in (A)           out (A exp)       minOut (A)');
    for (const r of top5) {
        const routeStr = `${short(r.route[0])} → ${short(r.route[1])} → ${short(r.route[2])} → ${short(r.route[0])}`;
        const inHuman = `${r.aInHuman} SOL`;
        const outHuman = `${r.aOutHuman} SOL`;
        const minHuman = `${toHumanAmtAtomic(r.minFinalOutAAtomic, 9)} SOL`;
        console.log(String(r.rank).padEnd(5), routeStr.padEnd(29), String(Math.round(r.profitPct)).padEnd(9),
            `${r.roiMultiple.toFixed(2)}×`.padEnd(7), inHuman.padEnd(16), outHuman.padEnd(18), minHuman);
    }
}

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}
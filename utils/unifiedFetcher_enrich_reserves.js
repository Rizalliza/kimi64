#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');

function isPubkey(s) {
    try { new PublicKey(s); return true; } catch { return false; }
}

// SPL token account layout: amount is u64 at offset 64 (after mint+owner)
function readTokenAccountAmount(data) {
    if (!data || data.length < 72) return null;
    try { return data.readBigUInt64LE(64).toString(); } catch { return null; }
}

async function main() {
    const [, , inFile, outFile] = process.argv;
    if (!inFile || !outFile) {
        console.error('Usage: node unifiedFetcher_enrich_reserves.js pools_meta.json pools_metaEnriched.json');
        process.exit(1);
    }

    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
        console.error('Missing RPC_URL');
        process.exit(1);
    }

    const pools = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    const conn = new Connection(rpcUrl, 'confirmed');

    // Collect vault pubkeys
    const vaultAddrs = [];
    const vaultIndex = new Map(); // addr -> idx
    for (const p of pools) {
        const xV = p?.vaults?.xVault;
        const yV = p?.vaults?.yVault;

        // Guard against the common mistake: mint used as vault
        if (xV && p.baseMint && xV === p.baseMint) continue;
        if (yV && p.quoteMint && yV === p.quoteMint) continue;

        for (const v of [xV, yV]) {
            if (v && isPubkey(v) && !vaultIndex.has(v)) {
                vaultIndex.set(v, vaultAddrs.length);
                vaultAddrs.push(new PublicKey(v));
            }
        }
    }

    let withReserves = 0;
    let missingVaults = 0;

    // Batch fetch token accounts
    const infos = await conn.getMultipleAccountsInfo(vaultAddrs);

    const enriched = pools.map(p => {
        const xV = p?.vaults?.xVault;
        const yV = p?.vaults?.yVault;

        if (!xV || !yV || !isPubkey(xV) || !isPubkey(yV)) {
            missingVaults++;
            return { ...p, hasReserves: false, isMathReady: false };
        }

        // Reject mint-as-vault
        if (p.baseMint && xV === p.baseMint) { missingVaults++; return { ...p, hasReserves: false, isMathReady: false }; }
        if (p.quoteMint && yV === p.quoteMint) { missingVaults++; return { ...p, hasReserves: false, isMathReady: false }; }

        const xi = vaultIndex.get(xV);
        const yi = vaultIndex.get(yV);

        const xAmt = readTokenAccountAmount(infos[xi]?.data);
        const yAmt = readTokenAccountAmount(infos[yi]?.data);

        if (!xAmt || !yAmt) {
            missingVaults++;
            return { ...p, hasReserves: false, isMathReady: false };
        }

        withReserves++;
        return {
            ...p,
            xReserve: xAmt,
            yReserve: yAmt,
            reserveSource: 'rpc',
            hasReserves: true,
            isMathReady: true
        };
    });

    fs.writeFileSync(outFile, JSON.stringify(enriched, null, 2));
    console.log(`Wrote ${outFile}`);
    console.log(`withReserves=${withReserves}/${pools.length} missingVaults=${missingVaults}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});

/*
export RPC_URL="http://api.mainnet-beta.solana.com"
node unifiedFetcher_enrich_reserves.js pools_meta.json --output=pools_metaEnriched.json
*/

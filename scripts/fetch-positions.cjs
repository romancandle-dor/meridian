#!/usr/bin/env node
// ─── fetch-positions.cjs ─────────────────────────────────────────────
// On-chain fetch via getAllLbPairPositionsByUser. Dumps full position JSON.
// Cold discovery only (~600-1000ms). For warm path, use Meteora APIs.
//
// Env:
//   WALLET              wallet pubkey
//   HELIUS_RPC_URL      default https://pump.helius-rpc.com
//   FULL                '1' to dump full JSON (large)
//
// Usage:
//   node fetch-positions.cjs                    # summary view
//   FULL=1 node fetch-positions.cjs             # full JSON dump
//   WALLET=... node fetch-positions.cjs         # custom wallet

'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');

const RPC = process.env.HELIUS_RPC_URL || 'https://pump.helius-rpc.com';
const WALLET = process.env.WALLET || 'Hv1hRTjyabhS8VXxGsyJPnK2jKtChAqhBKzjqwZGHAFW';
const FULL = process.env.FULL === '1';

function pubkeyStr(pk) {
  if (!pk) return 'n/a';
  return typeof pk === 'string' ? pk : (pk.toBase58?.() || pk.toString?.());
}

async function main() {
  const start = Date.now();
  const conn = new Connection(RPC, 'confirmed');
  const userPubKey = new PublicKey(WALLET);
  const positionsMap = await DLMM.getAllLbPairPositionsByUser(conn, userPubKey);
  const elapsed = Date.now() - start;

  let totalPositions = 0;
  console.log(`wallet: ${WALLET}`);
  console.log(`pools: ${positionsMap.size} (fetched in ${elapsed}ms)`);
  console.log('');

  for (const [poolAddress, lbPairData] of positionsMap.entries()) {
    const positions = lbPairData.lbPairPositionsData || [];
    for (const pos of positions) {
      totalPositions++;
      const d = pos.positionData || {};
      console.log(`pool: ${poolAddress}`);
      console.log(`  lbPair:           ${pubkeyStr(lbPairData.lbPair)}`);
      console.log(`  position pubkey:  ${pubkeyStr(pos.publicKey)}`);
      console.log(`  version:          ${pos.version ?? 'n/a'}`);
      console.log(`  bins:             ${d.lowerBinId} -> ${d.upperBinId}`);
      console.log(`  totalXAmount:     ${d.totalXAmount?.toString?.() || 'n/a'}`);
      console.log(`  totalYAmount:     ${d.totalYAmount?.toString?.() || 'n/a'}`);
      console.log(`  feeX:             ${d.feeX?.toString?.() || 'n/a'}`);
      console.log(`  feeY:             ${d.feeY?.toString?.() || 'n/a'}`);
      console.log(`  binData count:    ${(d.positionBinData || []).length}`);
      if (FULL) {
        console.log(`  -- FULL --`);
        console.log(JSON.stringify({
          lbPair: pubkeyStr(lbPairData.lbPair),
          positionPubkey: pubkeyStr(pos.publicKey),
          version: pos.version,
          positionData: {
            totalXAmount: d.totalXAmount?.toString?.(),
            totalYAmount: d.totalYAmount?.toString?.(),
            feeX: d.feeX?.toString?.(),
            feeY: d.feeY?.toString?.(),
            lowerBinId: d.lowerBinId,
            upperBinId: d.upperBinId,
            lastUpdatedAt: d.lastUpdatedAt,
            positionBinData: (d.positionBinData || []).length,
          },
        }, null, 2));
      }
      console.log('');
    }
  }

  console.log(`total: ${totalPositions} positions across ${positionsMap.size} pools`);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

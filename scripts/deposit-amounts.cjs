#!/usr/bin/env node
// ─── deposit-amounts.cjs ─────────────────────────────────────────────
// Show current liquidity vs fees from on-chain position data.
// Complements the Meteora API view with raw on-chain amounts.
//
// Env:
//   WALLET              wallet pubkey
//   HELIUS_RPC_URL      default https://pump.helius-rpc.com
//
// Usage:
//   node deposit-amounts.cjs
//   WALLET=... node deposit-amounts.cjs

'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');

const RPC = process.env.HELIUS_RPC_URL || 'https://pump.helius-rpc.com';
const WALLET = process.env.WALLET || 'Hv1hRTjyabhS8VXxGsyJPnK2jKtChAqhBKzjqwZGHAFW';

function fmtAmount(amount, decimals = 9) {
  if (!amount) return '0';
  return (Number(amount) / Math.pow(10, decimals)).toFixed(decimals);
}

function pubkeyStr(pk) {
  if (!pk) return 'n/a';
  return typeof pk === 'string' ? pk : (pk.toBase58?.() || pk.toString?.());
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const userPubKey = new PublicKey(WALLET);
  const positionsMap = await DLMM.getAllLbPairPositionsByUser(conn, userPubKey);

  console.log(`wallet: ${WALLET}`);
  console.log('');

  let totalX = 0, totalY = 0, totalFeeX = 0, totalFeeY = 0;
  let totalPositions = 0;

  for (const [poolAddress, lbPairData] of positionsMap.entries()) {
    const positions = lbPairData.lbPairPositionsData || [];
    for (const pos of positions) {
      totalPositions++;
      const d = pos.positionData || {};
      const x = Number(d.totalXAmount || 0);
      const y = Number(d.totalYAmount || 0);
      const fx = Number(d.feeX || 0);
      const fy = Number(d.feeY || 0);
      totalX += x;
      totalY += y;
      totalFeeX += fx;
      totalFeeY += fy;

      console.log(`pool ${poolAddress.slice(0, 8)}... | pos ${pubkeyStr(pos.publicKey).slice(0,8)}...`);
      console.log(`  liquidity: X=${fmtAmount(x)} (raw ${x})`);
      console.log(`             Y=${fmtAmount(y)} (raw ${y})`);
      console.log(`  fees:      X=${fmtAmount(fx)} (raw ${fx})`);
      console.log(`             Y=${fmtAmount(fy)} (raw ${fy})`);
      console.log('');
    }
  }

  console.log(`totals (${totalPositions} positions):`);
  console.log(`  liquidity: X=${fmtAmount(totalX)}, Y=${fmtAmount(totalY)}`);
  console.log(`  fees:      X=${fmtAmount(totalFeeX)}, Y=${fmtAmount(totalFeeY)}`);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

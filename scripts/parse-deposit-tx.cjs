#!/usr/bin/env node
// ─── parse-deposit-tx.cjs ────────────────────────────────────────────
// Parse specific deposit transactions for token/SOL flows.
// Shows pre/post balances to compute deposited amounts.
//
// Env:
//   POOL                pool address (required, to fetch its positions)
//   WALLET              wallet pubkey (required)
//   LIMIT               how many recent txs to scan (default 5)
//   HELIUS_RPC_URL      default https://pump.helius-rpc.com
//
// Usage:
//   node parse-deposit-tx.cjs --pool=<addr> --wallet=<addr>
//   LIMIT=10 node parse-deposit-tx.cjs --pool=<addr> --wallet=<addr>

'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');

const RPC = process.env.HELIUS_RPC_URL || 'https://pump.helius-rpc.com';

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

async function main() {
  const args = parseArgs();
  if (!args.pool || !args.wallet) {
    console.error('Usage: node parse-deposit-tx.cjs --pool=<addr> --wallet=<addr>');
    process.exit(1);
  }
  const conn = new Connection(RPC, 'confirmed');
  const userPubKey = new PublicKey(args.wallet);
  const poolAddress = args.pool;
  const LIMIT = Number(process.env.LIMIT || 5);

  const positionsMap = await DLMM.getAllLbPairPositionsByUser(conn, userPubKey);
  const lbPairData = positionsMap.get(poolAddress);
  const positions = lbPairData?.lbPairPositionsData || [];
  if (positions.length === 0) {
    console.log(`no positions for pool ${poolAddress}`);
    return;
  }

  for (const pos of positions) {
    const pubkey = pos.publicKey?.toBase58?.() || pos.publicKey?.toString?.();
    console.log(`=== position ${pubkey} ===`);
    const sigs = await conn.getSignaturesForAddress(new PublicKey(pubkey), { limit: LIMIT });
    for (const s of sigs) {
      const time = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : '?';
      console.log(`  tx: ${s.signature} | ${time} | err=${s.err ? 'YES' : 'no'}`);

      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) {
        console.log(`    (could not fetch parsed tx)`);
        continue;
      }

      // Find balance changes for the wallet
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const walletIdx = accountKeys.findIndex((k) =>
        (k.pubkey?.toString?.() || k.toString?.()) === args.wallet,
      );

      if (walletIdx >= 0) {
        const pre = tx.meta?.preBalances?.[walletIdx];
        const post = tx.meta?.postBalances?.[walletIdx];
        if (pre != null && post != null) {
          const solChange = (post - pre) / 1e9;
          console.log(`    SOL change: ${solChange.toFixed(9)} SOL (pre=${(pre / 1e9).toFixed(9)}, post=${(post / 1e9).toFixed(9)})`);
        }
      }

      // Show top-level instructions
      const ixs = tx.transaction?.message?.instructions || [];
      console.log(`    instructions: ${ixs.length}`);
      for (let i = 0; i < Math.min(ixs.length, 5); i++) {
        const ix = ixs[i];
        const program = ix.program?.toString?.() || ix.programId?.toString?.() || '?';
        console.log(`      [${i}] ${program}: ${ix.parsed?.type || 'unknown'}`);
      }
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

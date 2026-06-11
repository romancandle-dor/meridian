#!/usr/bin/env node
// ─── position-tx-history.cjs ────────────────────────────────────────
// Inspect position account fields + recent transaction signatures.
// Use this to detect new deposit/withdraw txs for cache invalidation.
//
// Env:
//   POSITION_PUBKEY     position account pubkey (required)
//   WALLET              wallet pubkey (for getAllLbPairPositionsByUser fallback)
//   HELIUS_RPC_URL      default https://pump.helius-rpc.com
//   LIMIT               tx sig limit (default 10)
//
// Usage:
//   node position-tx-history.cjs --position-pubkey=<addr>
//   node position-tx-history.cjs --wallet=<addr> --limit=20
//   LIMIT=5 node position-tx-history.cjs --wallet=...

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

function pubkeyStr(pk) {
  if (!pk) return 'n/a';
  return typeof pk === 'string' ? pk : (pk.toBase58?.() || pk.toString?.());
}

async function inspectPosition(conn, positionPubkey) {
  console.log(`=== position ${positionPubkey} ===`);
  const info = await conn.getAccountInfo(positionPubkey);
  if (!info) {
    console.log('  account not found');
    return;
  }
  console.log(`  owner:    ${info.owner.toString()}`);
  console.log(`  lamports: ${info.lamports}`);
  console.log(`  dataLen:  ${info.data.length} bytes`);

  const sigs = await conn.getSignaturesForAddress(positionPubkey, { limit: Number(process.env.LIMIT || 10) });
  console.log(`  recent txs (${sigs.length}):`);
  for (const s of sigs) {
    const time = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : '?';
    console.log(`    ${s.signature} | slot ${s.slot} | ${time} | err=${s.err ? 'YES' : 'no'}`);
  }
}

async function main() {
  const args = parseArgs();
  const conn = new Connection(RPC, 'confirmed');

  if (args['position-pubkey']) {
    await inspectPosition(conn, new PublicKey(args['position-pubkey']));
    return;
  }

  if (!args.wallet && !process.env.WALLET) {
    console.error('Usage: --position-pubkey=<addr> OR --wallet=<addr> (lists all positions)');
    process.exit(1);
  }

  const WALLET = args.wallet || process.env.WALLET;
  const userPubKey = new PublicKey(WALLET);
  console.log(`fetching positions for ${WALLET}...`);
  const positionsMap = await DLMM.getAllLbPairPositionsByUser(conn, userPubKey);
  console.log(`found ${positionsMap.size} pool(s)`);
  console.log('');

  for (const [poolAddress, lbPairData] of positionsMap.entries()) {
    const positions = lbPairData.lbPairPositionsData || [];
    console.log(`>>> pool ${poolAddress} <<<`);
    for (const pos of positions) {
      const pubkey = pubkeyStr(pos.publicKey);
      console.log('');
      await inspectPosition(conn, new PublicKey(pubkey));
    }
  }
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

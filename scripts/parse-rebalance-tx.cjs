#!/usr/bin/env node
// ─── parse-rebalance-tx.cjs ──────────────────────────────────────────
// Parse a single transaction by signature. Show all instructions,
// SOL balance changes, and any token balance changes.
//
// Usage:
//   node parse-rebalance-tx.cjs <signature>
//   node parse-rebalance-tx.cjs <signature> --verbose

'use strict';

const { Connection } = require('@solana/web3.js');

const RPC = process.env.HELIUS_RPC_URL || 'https://pump.helius-rpc.com';

function parseArgs() {
  const args = { verbose: false };
  for (const a of process.argv.slice(2)) {
    if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (!args.signature) args.signature = a;
  }
  return args;
}

async function main() {
  const args = parseArgs();
  if (!args.signature) {
    console.error('Usage: node parse-rebalance-tx.cjs <signature> [--verbose]');
    process.exit(1);
  }

  const conn = new Connection(RPC, 'confirmed');
  const tx = await conn.getParsedTransaction(args.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) {
    console.log(`tx ${args.signature} not found`);
    return;
  }

  const time = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : '?';
  console.log(`signature: ${args.signature}`);
  console.log(`slot:      ${tx.slot}`);
  console.log(`time:      ${time}`);
  console.log(`fee:       ${(tx.meta?.fee || 0) / 1e9} SOL`);
  console.log(`status:    ${tx.meta?.err ? 'FAILED' : 'ok'}`);
  console.log('');

  const accountKeys = tx.transaction?.message?.accountKeys || [];
  console.log(`accounts:  ${accountKeys.length}`);
  if (args.verbose) {
    for (let i = 0; i < accountKeys.length; i++) {
      const k = accountKeys[i];
      const pubkey = k.pubkey?.toString?.() || k.toString?.();
      const signer = k.signer ? 'signer' : (k.writable ? 'writable' : 'readonly');
      const pre = tx.meta?.preBalances?.[i];
      const post = tx.meta?.postBalances?.[i];
      const solChange = (pre != null && post != null) ? (post - pre) / 1e9 : null;
      console.log(`  [${i}] ${pubkey} (${signer})${solChange != null ? ` SOL: ${solChange.toFixed(9)}` : ''}`);
    }
    console.log('');
  }

  const ixs = tx.transaction?.message?.instructions || [];
  console.log(`instructions: ${ixs.length}`);
  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    const program = ix.program?.toString?.() || ix.programId?.toString?.() || '?';
    const type = ix.parsed?.type || 'unknown';
    console.log(`  [${i}] ${program}: ${type}`);
    if (args.verbose && ix.parsed) {
      console.log(`      ${JSON.stringify(ix.parsed).slice(0, 200)}`);
    }
  }

  // Token balance changes
  const preToken = tx.meta?.preTokenBalances || [];
  const postToken = tx.meta?.postTokenBalances || [];
  const tokenChanges = new Map();
  for (const pre of preToken) {
    const key = `${pre.accountIndex}-${pre.mint}`;
    tokenChanges.set(key, { mint: pre.mint, owner: pre.owner, accountIndex: pre.accountIndex, pre: pre.uiTokenAmount?.uiAmount || 0, post: 0 });
  }
  for (const post of postToken) {
    const key = `${post.accountIndex}-${post.mint}`;
    const entry = tokenChanges.get(key) || { mint: post.mint, owner: post.owner, accountIndex: post.accountIndex, pre: 0, post: 0 };
    entry.post = post.uiTokenAmount?.uiAmount || 0;
    tokenChanges.set(key, entry);
  }
  const nonZero = [...tokenChanges.values()].filter((t) => Math.abs(t.post - t.pre) > 1e-9);
  if (nonZero.length > 0) {
    console.log('');
    console.log('token balance changes:');
    for (const t of nonZero) {
      const change = t.post - t.pre;
      console.log(`  ${t.mint} acct[${t.accountIndex}]: ${t.pre} -> ${t.post} (${change > 0 ? '+' : ''}${change})`);
    }
  }
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

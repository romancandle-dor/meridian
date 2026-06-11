#!/usr/bin/env node
// ─── pnl.cjs ─────────────────────────────────────────────────────────
// Calculate and print PnL for all 3 default pools (SOL-denominated).
//
// Env:
//   WALLET    wallet pubkey (default: test wallet)
//   POOLS     comma-separated pool addresses (default: 3 test pools)
//   DENOM     'sol' (default) or 'usd'
//
// Usage:
//   node pnl.cjs                # all 3 test pools, SOL
//   DENOM=usd node pnl.cjs      # all 3 test pools, USD

'use strict';

const { batchPositionPnl, getPoolMetadata } = require('./lib/meteora.cjs');
const {
  calcPnlUsd, calcPnlSol, calcPnlPct,
  poolPnlUsd, poolPnlSol, poolDepositsUsd, poolDepositsSol,
} = require('./lib/pnl.cjs');

const DEFAULT_POOLS = [
  'AeUfFU6LU159YSBQvhLbXmh5bW2BqCgAFi5zUSQMnUc7',  // CHANCE-SOL
  '9ebZunGbxE8742uDsz6TnouE3nva8WcnMC8n2CLAyxak',  // Jotchua-SOL
  '3XrDjwbifkR5ezES5M5BZCxNHjWdZP2c4krG7VyYJrWR',  // KINS-SOL
];
const DEFAULT_WALLET = process.env.TEST_WALLET || 'Hv1hRTjyabhS8VXxGsyJPnK2jKtChAqhBKzjqwZGHAFW';

const POOLS = (process.env.POOLS || DEFAULT_POOLS.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
const WALLET = process.env.WALLET || DEFAULT_WALLET;
const DENOM = (process.env.DENOM || 'sol').toLowerCase();

function fmtUsd(v) { return `$${v.toFixed(2)}`; }
function fmtSol(v) { return `${v.toFixed(6)} SOL`; }

async function main() {
  const useUsd = DENOM === 'usd';
  const fmt = useUsd ? fmtUsd : fmtSol;
  const calcPnl = useUsd ? calcPnlUsd : calcPnlSol;
  const poolPnl = useUsd ? poolPnlUsd : poolPnlSol;
  const poolDeposits = useUsd ? poolDepositsUsd : poolDepositsSol;

  const lines = [];
  let total = 0;
  let totalDeposits = 0;

  for (const pool of POOLS) {
    let meta;
    try {
      meta = await getPoolMetadata(pool);
    } catch (e) {
      console.error(`pool ${pool.slice(0, 8)} metadata failed: ${e.message}`);
      continue;
    }
    const name = meta?.name || pool.slice(0, 8);
    let pnlData;
    try {
      pnlData = await batchPositionPnl([pool], WALLET);
    } catch (e) {
      console.error(`pool ${name} pnl failed: ${e.message}`);
      continue;
    }
    // Meteora /pnl returns { positions: [...] } wrapper
    const wrapper = pnlData[0];
    const positions = Array.isArray(wrapper?.positions) ? wrapper.positions : (Array.isArray(wrapper) ? wrapper : [wrapper]);
    const pnl = poolPnl(positions);
    const dep = poolDeposits(positions);
    const pct = calcPnlPct(pnl, dep);
    total += pnl;
    totalDeposits += dep;
    lines.push(`${name}, ${pct.toFixed(2)}%, ${fmt(pnl)}`);
  }

  const totalPct = calcPnlPct(total, totalDeposits);
  console.log(`[${DENOM.toUpperCase()}] ${lines.join(' | ')}`);
  console.log(`[${DENOM.toUpperCase()}] TOTAL ${totalPct.toFixed(2)}%, ${fmt(total)}`);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

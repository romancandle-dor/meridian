#!/usr/bin/env node
// ─── poll-compare.cjs ────────────────────────────────────────────────
// Main validation script. Polls every 3s, calculates enriched PnL from
// the formula, compares against Meteora /portfolio/open.
//
// Env:
//   WALLET              wallet pubkey (required for non-test)
//   POOLS               comma-separated pool addresses
//   MAX_TICKS           0 = infinite (default), N = stop after N ticks
//   POLL_INTERVAL_MS    default 3000
//
// Usage:
//   node poll-compare.cjs                                  # test pools, infinite
//   MAX_TICKS=5 node poll-compare.cjs                      # test pools, 5 ticks
//   WALLET=... POOLS=... node poll-compare.cjs             # custom
//   node poll-compare.cjs | grep delta                     # USD delta only

'use strict';

const { batchPositionPnl, getPortfolioOpen, getPoolMetadata } = require('./lib/meteora.cjs');
const {
  calcPnlUsd, calcPnlSol, calcPnlPct,
  poolPnlUsd, poolPnlSol, poolDepositsUsd, poolDepositsSol,
} = require('./lib/pnl.cjs');

// Default: 3 test pools from docs (CHANCE-SOL, Jotchua-SOL, KINS-SOL)
const DEFAULT_POOLS = [
  'AeUfFU6LU159YSBQvhLbXmh5bW2BqCgAFi5zUSQMnUc7',
  '9ebZunGbxE8742uDsz6TnouE3nva8WcnMC8n2CLAyxak',
  '3XrDjwbifkR5ezES5M5BZCxNHjWdZP2c4krG7VyYJrWR',
];

// Test wallet that has positions in those 3 pools (from docs)
const DEFAULT_WALLET = process.env.TEST_WALLET || 'Hv1hRTjyabhS8VXxGsyJPnK2jKtChAqhBKzjqwZGHAFW';

const POOLS = (process.env.POOLS || DEFAULT_POOLS.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
const WALLET = process.env.WALLET || DEFAULT_WALLET;
const MAX_TICKS = Number(process.env.MAX_TICKS || 0);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);

// Cache pool metadata (never expires, but warm once)
let poolMetaCache = new Map();
async function getPoolName(poolAddress) {
  if (poolMetaCache.has(poolAddress)) return poolMetaCache.get(poolAddress);
  try {
    const meta = await getPoolMetadata(poolAddress);
    const name = meta?.name || poolAddress.slice(0, 8);
    poolMetaCache.set(poolAddress, name);
    return name;
  } catch {
    return poolAddress.slice(0, 8);
  }
}

function fmtUsd(v) { return `$${Number(v ?? 0).toFixed(2)}`; }
function fmtSol(v) { return `${Number(v ?? 0).toFixed(6)} SOL`; }
function fmtPct(v) { return `${Number(v ?? 0).toFixed(2)}%`; }
function fmtDelta(v, unit) { return `${Number(v ?? 0) >= 0 ? '+' : ''}${unit === 'usd' ? '$' : ''}${Number(v ?? 0).toFixed(unit === 'usd' ? 2 : 6)}${unit === 'usd' ? '' : ' SOL'}`; }

function printRow(label, ours, portfolio, unit) {
  const fmt = unit === 'usd' ? fmtUsd : fmtSol;
  return `${label} ${ours} | PORTFOLIO ${portfolio} | delta ${(ours - portfolio).toFixed(6)}`;
}

function buildPnlRow(pools, pnlByPool, portfolioByPool, fmt, fmtLabel) {
  return pools
    .map((addr) => {
      const ours = pnlByPool.get(addr);
      const port = portfolioByPool.get(addr);
      return `${ours.name}, ${fmtPct(ours.pct)}, ${fmt(ours.value)} | ${port ? `PORTFOLIO ${port.name}, ${fmtPct(port.pct)}, ${fmt(port.value)}` : 'PORTFOLIO n/a'}`;
    })
    .join(' | ');
}

async function tick() {
  // Parallel: pnl per pool + portfolio (validation)
  const [pnlDatas, portfolio] = await Promise.all([
    Promise.all(POOLS.map((p) => batchPositionPnl([p], WALLET).then((arr) => arr[0]).catch(() => null))),
    getPortfolioOpen(WALLET).catch(() => null),
  ]);

  // Build per-pool "ours" PnL
  const oursByPool = new Map();
  for (let i = 0; i < POOLS.length; i++) {
    const addr = POOLS[i];
    const wrapper = pnlDatas[i];
    if (!wrapper) continue;
    // Meteora /pnl returns { positions: [...] } wrapper
    const positions = Array.isArray(wrapper?.positions) ? wrapper.positions : (Array.isArray(wrapper) ? wrapper : [wrapper]);
    const deposits = poolDepositsUsd(positions);
    const pnl = poolPnlUsd(positions);
    const name = await getPoolName(addr);
    oursByPool.set(addr, {
      name,
      value: pnl,
      pct: calcPnlPct(pnl, deposits),
    });
  }

  // Build per-pool "portfolio" PnL from Meteora
  const portByPool = new Map();
  if (portfolio?.pools) {
    for (const p of portfolio.pools) {
      portByPool.set(p.poolAddress, {
        name: p.name || p.poolAddress.slice(0, 8),
        value: p.pnl || 0,
        pct: p.pnlPctChange || 0,
      });
    }
  }

  // Totals
  const oursTotal = {
    usd: [...oursByPool.values()].reduce((s, x) => s + x.value, 0),
    sol: 0, // computed below
  };
  const portTotal = {
    usd: Number(portfolio?.total?.pnl ?? 0),
    sol: Number(portfolio?.total?.pnlSol ?? 0),
  };

  // Per-position pnlUsd (sum of position pnlUsd — should match our formula exactly)
  const perPosUsdTotal = POOLS.reduce((s, _addr, i) => {
    const wrapper = pnlDatas[i];
    if (!wrapper) return s;
    const positions = Array.isArray(wrapper?.positions) ? wrapper.positions : (Array.isArray(wrapper) ? wrapper : [wrapper]);
    return s + positions.reduce((sum, pos) => sum + Number(pos.pnlUsd ?? 0), 0);
  }, 0);

  // SOL equivalents (using our SOL calc — slightly different from portfolio)
  const oursSolTotal = POOLS.reduce((s, addr, i) => {
    const wrapper = pnlDatas[i];
    if (!wrapper) return s;
    // Meteora /pnl returns { positions: [...] } wrapper
    const positions = Array.isArray(wrapper?.positions) ? wrapper.positions : (Array.isArray(wrapper) ? wrapper : [wrapper]);
    return s + poolPnlSol(positions);
  }, 0);

  const usdDelta = (oursTotal.usd - portTotal.usd).toFixed(2);
  const solDelta = (oursSolTotal - portTotal.sol).toFixed(6);
  const formulaVsPosDelta = (oursTotal.usd - perPosUsdTotal).toFixed(4);

  const ourPools = [...oursByPool.entries()].map(([addr, d]) => `${d.name}, ${fmtPct(d.pct)}, ${fmtUsd(d.value)}`).join(' | ');
  const portPools = [...portByPool.values()].map((d) => `${d.name}, ${fmtPct(d.pct)}, ${fmtUsd(d.value)}`).join(' | ');

  // Compute simple portfolio total pct from total deposits
  const totalDepositsUsd = [...portByPool.values()].reduce((s, _p) => s + 0, 0); // we don't have portfolio deposits; just show delta

  console.log(`[${new Date().toISOString()}] USD OURS      ${ourPools}`);
  console.log(`[${new Date().toISOString()}] USD PORTFOLIO ${portPools}`);
  console.log(`[${new Date().toISOString()}] USD TOTAL     OURS ${fmtUsd(oursTotal.usd)} | PORTFOLIO ${fmtUsd(portTotal.usd)} | delta ${usdDelta}`);
  console.log(`[${new Date().toISOString()}] USD FORMULA   OURS ${fmtUsd(oursTotal.usd)} | pnlUsd ${fmtUsd(perPosUsdTotal)} | delta ${formulaVsPosDelta} (should be ~0)`);
  console.log(`[${new Date().toISOString()}] SOL TOTAL     OURS ${fmtSol(oursSolTotal)} | PORTFOLIO ${fmtSol(portTotal.sol)} | delta ${solDelta}`);
}

async function main() {
  if (POOLS.length === 0) {
    console.error('No pools. Set POOLS env or use defaults.');
    process.exit(1);
  }
  console.error(`poll-compare: ${POOLS.length} pools, wallet=${WALLET.slice(0, 8)}..., max_ticks=${MAX_TICKS || 'inf'}, interval=${POLL_INTERVAL_MS}ms`);

  let tickCount = 0;
  while (true) {
    try {
      await tick();
    } catch (e) {
      console.error(`[${new Date().toISOString()}] tick error: ${e.message}`);
    }
    tickCount++;
    if (MAX_TICKS > 0 && tickCount >= MAX_TICKS) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

#!/usr/bin/env node
// ─── benchmark-pipeline.cjs ──────────────────────────────────────────
// Measure latency per pipeline step:
//   1. cold init (portfolio/open + pnl per pool + Jupiter batch)
//   2. warm poll (pnl per pool + portfolio, no metadata)
//   3. serve (Jupiter only, snapshot already in memory)
//
// Usage:
//   node benchmark-pipeline.cjs            # default 5 cold, 20 warm, 10 serve
//   COLD=10 WARM=50 SERVE=20 node benchmark-pipeline.cjs

'use strict';

const { getPortfolioOpen, getPoolMetadata, batchPositionPnl, getPositionPnl } = require('./lib/meteora.cjs');
const { getTokenPrices } = require('./lib/jupiter.cjs');

const DEFAULT_POOLS = [
  'AeUfFU6LU159YSBQvhLbXmh5bW2BqCgAFi5zUSQMnUc7',
  '9ebZunGbxE8742uDsz6TnouE3nva8WcnMC8n2CLAyxak',
  '3XrDjwbifkR5ezES5M5BZCxNHjWdZP2c4krG7VyYJrWR',
];
const DEFAULT_WALLET = process.env.TEST_WALLET || 'Hv1hRTjyabhS8VXxGsyJPnK2jKtChAqhBKzjqwZGHAFW';

const POOLS = (process.env.POOLS || DEFAULT_POOLS.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
const WALLET = process.env.WALLET || DEFAULT_WALLET;

const COLD = Number(process.env.COLD || 5);
const WARM = Number(process.env.WARM || 20);
const SERVE = Number(process.env.SERVE || 10);

function ms(start) { return Date.now() - start; }
function avg(arr) { return arr.length === 0 ? 0 : arr.reduce((s, x) => s + x, 0) / arr.length; }
function stats(arr) {
  if (arr.length === 0) return { avg: 0, min: 0, max: 0, p50: 0, p95: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const p = (q) => sorted[Math.floor((sorted.length - 1) * q)];
  return { avg: avg(arr), min: sorted[0], max: sorted[sorted.length - 1], p50: p(0.5), p95: p(0.95) };
}
function fmt(s) { return `avg=${s.avg.toFixed(0)}ms min=${s.min}ms p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms`; }

async function coldInit() {
  const samples = [];
  for (let i = 0; i < COLD; i++) {
    const start = Date.now();
    await Promise.all([
      getPortfolioOpen(WALLET),
      Promise.all(POOLS.map((p) => getPoolMetadata(p))),
      Promise.all(POOLS.map((p) => getPositionPnl(p, WALLET))),
      getTokenPrices(POOLS.map(() => 'So11111111111111111111111111111111111111112')), // SOL mint
    ]);
    samples.push(ms(start));
  }
  return samples;
}

async function warmPoll() {
  const samples = [];
  for (let i = 0; i < WARM; i++) {
    const start = Date.now();
    await Promise.all([
      batchPositionPnl(POOLS, WALLET),
      getPortfolioOpen(WALLET),
    ]);
    samples.push(ms(start));
  }
  return samples;
}

async function serve() {
  const samples = [];
  // Snapshot already in memory — just Jupiter batch
  for (let i = 0; i < SERVE; i++) {
    const start = Date.now();
    await getTokenPrices(POOLS.map(() => 'So11111111111111111111111111111111111111112'));
    samples.push(ms(start));
  }
  return samples;
}

async function main() {
  console.log(`benchmark: ${POOLS.length} pools, wallet=${WALLET.slice(0, 8)}..., cold=${COLD} warm=${WARM} serve=${SERVE}`);
  console.log('');

  console.log('phase 1: cold init (portfolio + pool metadata + pnl + Jupiter)');
  const cold = stats(await coldInit());
  console.log(`  ${fmt(cold)}`);
  console.log('');

  console.log('phase 2: warm poll (pnl per pool + portfolio)');
  const warm = stats(await warmPoll());
  console.log(`  ${fmt(warm)}`);
  console.log('');

  console.log('phase 3: serve (Jupiter only, snapshot ready)');
  const serveSamples = stats(await serve());
  console.log(`  ${fmt(serveSamples)}`);
  console.log('');

  console.log('summary:');
  console.log(`  cold:  ${cold.avg.toFixed(0)}ms avg (target: 750-1000ms)`);
  console.log(`  warm:  ${warm.avg.toFixed(0)}ms avg (target: 50-200ms)`);
  console.log(`  serve: ${serveSamples.avg.toFixed(0)}ms avg (target: ~80ms)`);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

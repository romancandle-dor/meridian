#!/usr/bin/env node
// ─── token-price.cjs ─────────────────────────────────────────────────
// Fetch realtime Jupiter USD price by mint. Supports comma-separated batch.
//
// Usage:
//   node token-price.cjs <mint>
//   node token-price.cjs mint1,mint2,mint3
//   node -e "const t = require('./token-price.cjs'); t.getTokenXPrices(['m1','m2']).then(console.log)"

'use strict';

const { getTokenPrices } = require('./lib/jupiter.cjs');

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node token-price.cjs <mint> OR <mint1,mint2,mint3>');
    process.exit(1);
  }
  const mints = arg.split(',').map((s) => s.trim()).filter(Boolean);
  const assets = await getTokenPrices(mints);
  for (const a of assets) {
    console.log(`${a.symbol || '?'} (${a.id}): $${a.usdPrice ?? 'n/a'} [slot ${a.priceBlockId ?? '?'}, updated ${a.updatedAt ?? '?'}]`);
  }
  if (assets.length === 0) {
    console.log('(no assets returned)');
  }
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});

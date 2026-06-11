#!/usr/bin/env node
// ─── bin-to-price.cjs ────────────────────────────────────────────────
// Convert bin ranges to human-readable price ranges (SOL per tokenX).
// Uses getPriceOfBinByBinId from @meteora-ag/dlmm SDK.
//
// Env:
//   POOL                pool address (required)
//   BIN_STEP            bin step in bps (required)
//   DECIMALS_X          tokenX decimals (required for human price)
//   DECIMALS_Y          tokenY decimals (default 9 for SOL)
//   LOWER_BIN           lower bin id
//   UPPER_BIN           upper bin id
//
// Usage:
//   node bin-to-price.cjs --pool=<addr> --bin-step=100 --decimals-x=6 --lower-bin=-10 --upper-bin=10

'use strict';

const DLMM = require('@meteora-ag/dlmm');

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function main() {
  const args = parseArgs();
  const pool = args.pool;
  const binStep = Number(args['bin-step']);
  const decimalsX = Number(args['decimals-x']);
  const decimalsY = Number(args['decimals-y'] || 9); // SOL default
  const lowerBin = Number(args['lower-bin']);
  const upperBin = Number(args['upper-bin']);

  if (!pool || !binStep || !decimalsX) {
    console.error('Usage: node bin-to-price.cjs --pool=<addr> --bin-step=<bps> --decimals-x=<n> [--decimals-y=9] --lower-bin=<id> --upper-bin=<id>');
    process.exit(1);
  }

  const lowerPriceLamport = DLMM.getPriceOfBinByBinId(lowerBin, binStep);
  const upperPriceLamport = DLMM.getPriceOfBinByBinId(upperBin, binStep);

  // Lamport price = Y per X (raw)
  // Human price (Y per X) = lamportPrice * 10^(decimalsX - decimalsY)
  const lowerHuman = lowerPriceLamport * Math.pow(10, decimalsX - decimalsY);
  const upperHuman = upperPriceLamport * Math.pow(10, decimalsX - decimalsY);

  console.log(`pool: ${pool}`);
  console.log(`bin step: ${binStep} bps`);
  console.log(`decimals: X=${decimalsX}, Y=${decimalsY}`);
  console.log('');
  console.log(`bin range: ${lowerBin} -> ${upperBin} (width: ${upperBin - lowerBin + 1} bins)`);
  console.log(`lower price (Y per X): ${lowerHuman.toExponential(6)} (raw: ${lowerPriceLamport.toExponential(6)})`);
  console.log(`upper price (Y per X): ${upperHuman.toExponential(6)} (raw: ${upperPriceLamport.toExponential(6)})`);

  if (decimalsY === 9) {
    // Convert to SOL per tokenX (assuming Y is SOL)
    console.log('');
    console.log(`human SOL per tokenX: ${lowerHuman.toFixed(9)} -> ${upperHuman.toFixed(9)}`);
  }
}

main();

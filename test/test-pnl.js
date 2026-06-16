/**
 * Unit tests for the PnL formula (Meteora DLMM).
 * No API calls, no wallet needed.
 * Run: node test/test-pnl.js
 */

import {
  deriveOpenPnlValue,
  deriveOpenPnlPct,
  getClosedPnlValue,
  getClosedPnlPct,
} from "../tools/dlmm.js";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

function approx(a, b, tol = 0.001) {
  return Math.abs(a - b) < tol;
}

// ─── Mock position data ──────────────────────────────────────────
const mockOpenPosition = {
  unrealizedPnl: {
    balances: 100,
    balancesSol: 1.5,
    unclaimedFeeTokenX: { usd: 2, amountSol: 0.03 },
    unclaimedFeeTokenY: { usd: 0.5, amountSol: 0.008 },
    unclaimedRewardTokenX: { usd: 0, amountSol: 0 },
    unclaimedRewardTokenY: { usd: 0, amountSol: 0 },
  },
  allTimeDeposits: { total: { usd: 108, sol: 1.6 } },
  allTimeWithdrawals: { total: { usd: 0, sol: 0 } },
  allTimeFees: { total: { usd: 3, sol: 0.045 } },
};

const mockClosedPosition = {
  pnlUsd: 5.5,
  pnlSol: 0.08,
  pnlPctChange: 5.09,
  pnlSolPctChange: 5.26,
  allTimeDeposits: { total: { usd: 108, sol: 1.6 } },
};

async function main() {
  console.log("\n=== PnL Formula Tests ===\n");

  // 1. deriveOpenPnlValue (USD)
  const usdPnl = deriveOpenPnlValue(mockOpenPosition, false);
  assert(
    approx(usdPnl, -2.5),
    `Open USD PnL: ${usdPnl.toFixed(2)} (expected -2.50)`,
  );

  // 2. deriveOpenPnlValue (SOL)
  const solPnl = deriveOpenPnlValue(mockOpenPosition, true);
  assert(
    approx(solPnl, -0.017),
    `Open SOL PnL: ${solPnl.toFixed(4)} (expected -0.0170)`,
  );

  // 3. deriveOpenPnlPct (USD)
  const usdPct = deriveOpenPnlPct(mockOpenPosition, false);
  assert(
    approx(usdPct, -2.315),
    `Open USD PnL%: ${usdPct.toFixed(3)} (expected -2.315)`,
  );

  // 4. deriveOpenPnlPct (SOL)
  const solPct = deriveOpenPnlPct(mockOpenPosition, true);
  assert(
    approx(solPct, -1.063),
    `Open SOL PnL%: ${solPct.toFixed(3)} (expected -1.063)`,
  );

  // 5. getClosedPnlValue (USD)
  const closedUsd = getClosedPnlValue(mockClosedPosition, false);
  assert(
    approx(closedUsd, 5.5),
    `Closed USD PnL: ${closedUsd.toFixed(2)} (expected 5.50)`,
  );

  // 6. getClosedPnlValue (SOL)
  const closedSol = getClosedPnlValue(mockClosedPosition, true);
  assert(
    approx(closedSol, 0.08),
    `Closed SOL PnL: ${closedSol.toFixed(4)} (expected 0.0800)`,
  );

  // 7. getClosedPnlPct (USD)
  const closedPct = getClosedPnlPct(mockClosedPosition, false);
  assert(
    approx(closedPct, 5.09),
    `Closed USD PnL%: ${closedPct.toFixed(2)} (expected 5.09)`,
  );

  // 8. Edge case: null/empty data
  const empty = deriveOpenPnlValue(null, false);
  assert(empty === 0, `Null position returns 0: ${empty}`);

  const nullPct = deriveOpenPnlPct(null, false);
  assert(nullPct === null, `Null position PnL% returns null: ${nullPct}`);

  // ─── Summary ──────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});

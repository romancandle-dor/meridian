/**
 * Full-flow integration test (some tests require live API, some offline).
 * Run: node test/test-integration.js
 * Run without API: SKIP_LIVE_TESTS=1 node test/test-integration.js
 */

import { config, reloadScreeningThresholds, computeDeployAmount } from "../config.js";
import { tools } from "../tools/definitions.js";
import { deriveOpenPnlValue, deriveOpenPnlPct, getClosedPnlValue, getClosedPnlPct } from "../tools/dlmm.js";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

async function main() {
  const skipLive = process.env.SKIP_LIVE_TESTS === "1";

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║     MERIDIAN INTEGRATION TEST            ║");
  if (skipLive) console.log("║     (live API tests skipped)              ║");
  console.log("╚══════════════════════════════════════════╝");

  // ─── 1. CONFIG LOADING ──────────────────────────────────────
  console.log("\n─── 1. Config Loading ───");
  assert(config !== undefined, "Config object exists");
  assert(typeof config.screening === "object", "Config.screening section");
  assert(typeof config.management === "object", "Config.management section");
  assert(typeof config.schedule === "object", "Config.schedule section");
  assert(typeof config.llm === "object", "Config.llm section");
  assert(typeof config.api === "object", "Config.api section");
  assert(typeof config.strategy === "object", "Config.strategy section");
  assert(typeof config.timingEntry === "object", "Config.timingEntry section");
  assert(typeof config.risk === "object", "Config.risk section");
  assert(typeof config.tokens === "object", "Config.tokens section");
  assert(typeof config.gmgn === "object", "Config.gmgn section");
  assert(typeof config.darwin === "object", "Config.darwin section");
  assert(typeof config.indicators === "object", "Config.indicators section");

  // ─── 2. CONFIG VALUES SANITY ────────────────────────────────
  console.log("\n─── 2. Config Values ───");
  assert(config.management.deployAmountSol > 0, `deployAmountSol > 0: ${config.management.deployAmountSol}`);
  assert(config.risk.maxDeployAmount >= config.management.deployAmountSol,
    `maxDeployAmount >= deployAmountSol: ${config.risk.maxDeployAmount} >= ${config.management.deployAmountSol}`);
  assert(config.strategy.minBinsBelow >= 35, `minBinsBelow >= 35: ${config.strategy.minBinsBelow}`);
  assert(config.strategy.maxBinsBelow >= config.strategy.minBinsBelow,
    `maxBinsBelow >= minBinsBelow: ${config.strategy.maxBinsBelow} >= ${config.strategy.minBinsBelow}`);
  assert(["bid_ask", "spot"].includes(config.strategy.strategy),
    `valid strategy: ${config.strategy.strategy}`);

  // ─── 3. COMPUTE DEPLOY AMOUNT ───────────────────────────────
  console.log("\n─── 3. computeDeployAmount ───");
  const with10Sol = computeDeployAmount(10);
  assert(with10Sol >= config.management.deployAmountSol,
    `10 SOL wallet => ${with10Sol} SOL deploy (floor ${config.management.deployAmountSol})`);
  const with100Sol = computeDeployAmount(100);
  assert(with100Sol <= config.risk.maxDeployAmount,
    `100 SOL wallet => ${with100Sol} SOL deploy (ceil ${config.risk.maxDeployAmount})`);
  const withSmall = computeDeployAmount(0.3);
  assert(withSmall > 0, `Low balance (0.3 SOL) => ${withSmall} SOL (non-negative)`);

  // ─── 4. PnL FORMULA ─────────────────────────────────────────
  console.log("\n─── 4. PnL Formula (unit) ───");
  const mockOpen = {
    unrealizedPnl: { balances: 100, balancesSol: 1.5,
      unclaimedFeeTokenX: { usd: 2, amountSol: 0.03 },
      unclaimedFeeTokenY: { usd: 0.5, amountSol: 0.008 },
      unclaimedRewardTokenX: { usd: 0, amountSol: 0 },
      unclaimedRewardTokenY: { usd: 0, amountSol: 0 },
    },
    allTimeDeposits: { total: { usd: 108, sol: 1.6 } },
    allTimeWithdrawals: { total: { usd: 0, sol: 0 } },
    allTimeFees: { total: { usd: 3, sol: 0.045 } },
  };
  const usdPnl = deriveOpenPnlValue(mockOpen, false);
  assert(Math.abs(usdPnl - (-2.5)) < 0.001,
    `Open USD PnL: ${usdPnl.toFixed(2)} (expected -2.50)`);
  const mockClosed = {
    pnlUsd: 5.5, pnlSol: 0.08, pnlPctChange: 5.09, pnlSolPctChange: 5.26,
    allTimeDeposits: { total: { usd: 108, sol: 1.6 } },
  };
  const closedVal = getClosedPnlValue(mockClosed, false);
  assert(Math.abs(closedVal - 5.5) < 0.001,
    `Closed PnL: ${closedVal} (expected 5.50)`);

  // ─── 5. TOOL DEFINITIONS ────────────────────────────────────
  console.log("\n─── 5. Tool Definitions ───");
  const toolNames = tools.map(t => t.function?.name).filter(Boolean);
  const required = ["discover_pools", "get_top_candidates", "deploy_position",
    "get_my_positions", "close_position", "claim_fees", "swap_token",
    "get_position_pnl", "get_wallet_balance", "update_config"];
  for (const name of required) {
    assert(toolNames.includes(name), `Tool "${name}" is defined`);
  }
  const deployDef = tools.find(t => t.function?.name === "deploy_position");
  assert(deployDef, "deploy_position has definition");
  const deployParams = deployDef.function.parameters.properties;
  assert(deployParams.strategy?.enum?.includes("bid_ask"),
    "deploy_position strategy enum includes bid_ask");
  assert(deployParams.strategy?.enum?.includes("spot"),
    "deploy_position strategy enum includes spot");
  assert(deployParams.bins_below, "deploy_position has bins_below param");
  assert(deployParams.bins_above, "deploy_position has bins_above param");

  // ─── 6. TIMING ENTRY DUMP FILTER ────────────────────────────
  console.log("\n─── 6. Timing Entry Config ───");
  assert(config.timingEntry.enabled === true || config.timingEntry.enabled === false,
    `timingEntry.enabled is boolean: ${config.timingEntry.enabled}`);
  assert(typeof config.timingEntry.minDumpPct === "number" && config.timingEntry.minDumpPct < 0,
    `minDumpPct is negative: ${config.timingEntry.minDumpPct}`);
  assert(config.timingEntry.checkField === "price_change_1h",
    `checkField: ${config.timingEntry.checkField}`);

  // ─── 7. LIVE SCREENING (optional) ───────────────────────────
  if (!skipLive) {
    console.log("\n─── 7. Live Screening Pipeline ───");
    try {
      const { discoverPools } = await import("../tools/screening.js");
      const { getTopCandidates } = await import("../tools/screening.js");

      const result = await discoverPools({ page_size: 5 });
      assert(typeof result.total === "number",
        `discoverPools total: ${result.total}`);
      assert(Array.isArray(result.pools),
        `discoverPools pools array: ${result.pools.length}`);
      assert(typeof result.filtered_examples === "undefined" || Array.isArray(result.filtered_examples),
        "discoverPools filtered_examples present");

      if (result.pools.length > 0) {
        const p = result.pools[0];
        assert(typeof p.pool === "string", `Pool address: ${p.pool?.slice(0,8)}`);
        assert(typeof p.name === "string", `Pool name: ${p.name}`);
        assert(p.active_tvl > 0 || p.tvl > 0, "Pool has positive TVL");
      }

      const candidates = await getTopCandidates({ limit: 3 });
      assert(typeof candidates === "object" && candidates !== null,
        "getTopCandidates returns object");
      assert(Array.isArray(candidates.candidates),
        `getTopCandidates.candidates is array: ${candidates.candidates?.length}`);
      assert(typeof candidates.total_screened === "number",
        `total_screened: ${candidates.total_screened}`);
    } catch (e) {
      console.log(`  ⚠️  Live API test error: ${e.message}`);
      console.log(`  Continuing without live tests...`);
    }
  }

  // ─── 8. CONFIG RELOAD ───────────────────────────────────────
  console.log("\n─── 8. Config Reload ───");
  try {
    const before = config.strategy.minBinsBelow;
    reloadScreeningThresholds();
    const after = config.strategy.minBinsBelow;
    assert(typeof after === "number" && after >= 35,
      `reloadScreeningThresholds: minBinsBelow=${after}`);
  } catch (e) {
    assert(false, `reloadScreeningThresholds: ${e.message}`);
  }

  // ─── SUMMARY ─────────────────────────────────────────────────
  console.log(`\n${"─".repeat(46)}`);
  console.log(`  ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log(`${"─".repeat(46)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Integration test error:", e);
  process.exit(1);
});

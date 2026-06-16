/**
 * Test pool discovery and screening pipeline (live API).
 * Requires network access but no wallet.
 * Run: node test/test-screening.js
 */

import { discoverPools } from "../tools/screening.js";
import { config } from "../config.js";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

async function main() {
  console.log(`\n=== Screening Pipeline Tests ===`);
  console.log(`Config: category="${config.screening.category}", timeframe=${config.screening.timeframe}\n`);

  // Store original thresholds and lower them temporarily so the test gets actual pools
  const origBinStep = config.screening.minBinStep;
  const origMinVol = config.screening.minVolume;
  const origMinTvl = config.screening.minTvl;
  const origMinOrganic = config.screening.minOrganic;
  config.screening.minBinStep = 1;
  config.screening.minVolume = 0;
  config.screening.minTvl = 0;
  config.screening.minOrganic = 0;

  // Test 1: discover pools (relaxed thresholds)
  console.log("1. discoverPools()");
  const result = await discoverPools({ page_size: 20 });
  assert(typeof result.total === "number", `Has total count: ${result.total}`);
  assert(Array.isArray(result.pools), `Pools is array: ${result.pools?.length} items`);
  assert(result.pools.length > 0, `At least 1 pool passes relaxed filters: ${result.pools.length}`);

  const p = result.pools[0];
  assert(typeof p.pool === "string", `Pool has address: ${p.pool?.slice(0, 8)}`);
  assert(typeof p.name === "string", `Pool has name: ${p.name}`);
  assert(typeof p.tvl === "number" || typeof p.active_tvl === "number", `Pool has TVL`);
  assert(typeof p.volume === "number" || typeof p.volume_window === "number", `Pool has volume`);
  assert(typeof p.fee_tvl_ratio === "number" || typeof p.fee_active_tvl_ratio === "number", `Pool has fee/TVL`);

  console.log(`\n   Top pool: ${p.name} — fee/TVL=${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}, TVL=$${p.active_tvl}`);

  // Restore original config thresholds
  config.screening.minBinStep = origBinStep;
  config.screening.minVolume = origMinVol;
  config.screening.minTvl = origMinTvl;
  config.screening.minOrganic = origMinOrganic;

  // ─── Summary ──────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\nScreening test failed:", e.message);
  process.exit(1);
});

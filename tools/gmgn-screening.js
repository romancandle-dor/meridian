import { spawn } from "node:child_process";
import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked } from "../dev-blocklist.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { log } from "../logger.js";

const CLI = "/home/ubuntu/.local/bin/gmgn-cli";
const TIMEOUT = 20000;
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/search";

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ ok: false, err: "timeout" }); }, TIMEOUT);
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve({ ok: false, err }); return; }
      try { resolve({ ok: true, data: JSON.parse(out) }); }
      catch { resolve({ ok: false, err: "parse_error" }); }
    });
  });
}

function numeric(val) {
  if (val == null || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function scoreCandidate(c) {
  const feeTvl = numeric(c.fee_active_tvl_ratio) ?? 0;
  const organic = numeric(c.organic_score) ?? 0;
  const volume = numeric(c.volume) ?? 0;
  const holders = numeric(c.holder_count) ?? 0;
  const dumpBonus = numeric(c.dump_bonus) ?? 0;
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100 + dumpBonus;
}

async function dexScreenerSearch(mint) {
  try {
    const url = `${DEXSCREENER_API}?q=${mint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data?.pairs || [];
    const meteora = pairs.find(p =>
      p.chainId === "solana" &&
      p.dexId === "meteora" &&
      p.labels?.includes?.("DLMM") &&
      p.baseToken?.address === mint
    );
    if (meteora) return { poolAddress: meteora.pairAddress, liquidity: meteora.liquidity?.usd, volume: meteora.volume?.h24, fdv: meteora.fdv };
    const anyMeteora = pairs.find(p =>
      p.chainId === "solana" && p.dexId === "meteora" && p.baseToken?.address === mint
    );
    if (anyMeteora) return { poolAddress: anyMeteora.pairAddress, liquidity: anyMeteora.liquidity?.usd, volume: anyMeteora.volume?.h24, fdv: anyMeteora.fdv };
    return null;
  } catch {
    return null;
  }
}

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

async function fetchMeteoraPoolData(mint) {
  try {
    const url = `${POOL_DISCOVERY_BASE}/search?q=${mint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.pools?.length) return null;
    const pool = data.pools[0];
    return {
      pool_address: pool.address,
      name: pool.name,
      tvl: pool.tvl,
      volume: pool.volume,
      fee_tvl: pool.fee_active_tvl_ratio,
      volatility: pool.volatility,
      bin_step: pool.bin_step,
      fee_pct: pool.fee_pct,
      organic_score: pool.organic_score,
      mcap: pool.market_cap || pool.mcap,
      holders: pool.holders,
      base_mint: pool.base?.mint,
      base_symbol: pool.base?.symbol,
    };
  } catch {
    return null;
  }
}

export async function getGmgnCandidates({ limit = 10 } = {}) {
  const result = await runCli(["market", "trending", "--chain", "sol", "--interval", "1h", "--limit", "50", "--raw"]);
  if (!result.ok) {
    log("gmgn_screening", `GMGN trending failed: ${result.err || "unknown"}`);
    return { candidates: [], filtered_examples: [] };
  }

  const tokens = result.data?.data?.rank || [];
  if (tokens.length === 0) {
    log("gmgn_screening", "No trending tokens from GMGN");
    return { candidates: [], filtered_examples: [] };
  }

  log("gmgn_screening", `GMGN trending: ${tokens.length} tokens fetched`);

  const filteredOut = [];

  // Pre-filter by exchange & basic checks
  const meteoraTokens = tokens.filter(t => {
    const exchange = (t.exchange || "").toLowerCase();
    if (!exchange.includes("meteora")) {
      filteredOut.push({ name: t.symbol, reason: "not on Meteora" });
      return false;
    }
    if (!t.address) {
      filteredOut.push({ name: t.symbol, reason: "no mint address" });
      return false;
    }
    if (isBlacklisted(t.address)) {
      filteredOut.push({ name: t.symbol, reason: "blacklisted" });
      return false;
    }
    return true;
  });

  if (meteoraTokens.length === 0) {
    log("gmgn_screening", "No Meteora tokens in trending");
    return { candidates: [], filtered_examples: filteredOut };
  }

  log("gmgn_screening", `${meteoraTokens.length} Meteora tokens, fetching pool data...`);

  // Fetch Meteora pool data for each token using pool discovery API
  const poolDataResults = await Promise.allSettled(
    meteoraTokens.map(t => fetchMeteoraPoolData(t.address))
  );

  const enriched = [];
  for (let i = 0; i < meteoraTokens.length; i++) {
    const t = meteoraTokens[i];
    const poolResult = poolDataResults[i];
    const pool = poolResult.status === "fulfilled" ? poolResult.value : null;

    if (!pool?.pool_address) {
      // Fallback: try DexScreener for pool address
      const dsPool = await dexScreenerSearch(t.address);
      if (!dsPool?.poolAddress) {
        filteredOut.push({ name: t.symbol, reason: "no Meteora pool found" });
        continue;
      }
      // Use GMGN data as fallback but still track pool
      const top10Pct = numeric(t.top_10_holder_rate);
      const botPct = numeric(t.bot_degen_rate);
      const marketCap = numeric(t.market_cap);
      const volume = numeric(t.volume);
      const holders = numeric(t.holder_count);
      const bundlerRate = numeric(t.bundler_rate);
      const cfg = config.screening;
      let filtered = false;

      if (cfg.excludeHighSupplyConcentration && top10Pct != null && top10Pct > (cfg.maxTop10Pct ?? 60) / 100) {
        filteredOut.push({ name: t.symbol, reason: `top10 ${(top10Pct * 100).toFixed(0)}% > max ${cfg.maxTop10Pct}%` });
        filtered = true;
      }
      if (!filtered && cfg.minMcap && marketCap != null && marketCap < cfg.minMcap) {
        filteredOut.push({ name: t.symbol, reason: `mcap $${marketCap} < min $${cfg.minMcap}` });
        filtered = true;
      }
      if (!filtered && cfg.maxMcap && marketCap != null && marketCap > cfg.maxMcap) {
        filteredOut.push({ name: t.symbol, reason: `mcap $${marketCap} > max $${cfg.maxMcap}` });
        filtered = true;
      }
      if (!filtered && cfg.minVolume && volume != null && volume < cfg.minVolume) {
        filteredOut.push({ name: t.symbol, reason: `volume $${volume} < min $${cfg.minVolume}` });
        filtered = true;
      }
      if (!filtered && cfg.minHolders && holders != null && holders < cfg.minHolders) {
        filteredOut.push({ name: t.symbol, reason: `holders ${holders} < min ${cfg.minHolders}` });
        filtered = true;
      }
      if (!filtered && cfg.maxBotHoldersPct != null && botPct != null && botPct * 100 > cfg.maxBotHoldersPct) {
        filteredOut.push({ name: t.symbol, reason: `bot ${(botPct * 100).toFixed(0)}% > max ${cfg.maxBotHoldersPct}%` });
        filtered = true;
      }
      if (!filtered && bundlerRate != null && cfg.maxBundlePct != null && bundlerRate * 100 > cfg.maxBundlePct) {
        filteredOut.push({ name: t.symbol, reason: `bundler ${(bundlerRate * 100).toFixed(0)}% > max ${cfg.maxBundlePct}%` });
        filtered = true;
      }
      if (!filtered && t.creator && isDevBlocked(t.creator)) {
        filteredOut.push({ name: t.symbol, reason: "blocked deployer" });
        filtered = true;
      }

      if (!filtered) {
        enriched.push({
          pool: dsPool.poolAddress,
          name: `${t.symbol || "?"}-SOL`,
          symbol: t.symbol,
          base_mint: t.address,
          base: { mint: t.address, symbol: t.symbol },
          market_cap: marketCap,
          volume_window: volume,
          holder_count: holders,
          liquidity: numeric(dsPool.liquidity ?? t.liquidity),
          fee_active_tvl_ratio: null,
          organic_score: null,
          volatility: null,
          bin_step: null,
          fee_pct: null,
          gmgn_total_fee_sol: t.gas_fee ? numeric(t.gas_fee) : null,
          price_change_1h: t.price_change_percent1h ? numeric(t.price_change_percent1h) : null,
          smart_degen_count: t.smart_degen_count ?? 0,
          renowned_count: t.renowned_count ?? 0,
          source: "gmgn_trending",
        });
      }
      continue;
    }

    // We have full Meteora pool data — apply standard filters
    const mcap = numeric(pool.mcap);
    const volume = numeric(pool.volume);
    const tvl = numeric(pool.tvl);
    const holders = numeric(pool.holders);
    const feeTvl = numeric(pool.fee_tvl);
    const volatility = numeric(pool.volatility);
    const organic = numeric(pool.organic_score);
    const binStep = numeric(pool.bin_step);

    const cfg = config.screening;
    let filtered = false;

    if (cfg.minTvl && tvl != null && tvl < cfg.minTvl) {
      filteredOut.push({ name: pool.name, reason: `TVL $${tvl} < min $${cfg.minTvl}` });
      filtered = true;
    }
    if (!filtered && cfg.maxTvl && tvl != null && tvl > cfg.maxTvl) {
      filteredOut.push({ name: pool.name, reason: `TVL $${tvl} > max $${cfg.maxTvl}` });
      filtered = true;
    }
    if (!filtered && cfg.minMcap && mcap != null && mcap < cfg.minMcap) {
      filteredOut.push({ name: pool.name, reason: `mcap $${mcap} < min $${cfg.minMcap}` });
      filtered = true;
    }
    if (!filtered && cfg.maxMcap && mcap != null && mcap > cfg.maxMcap) {
      filteredOut.push({ name: pool.name, reason: `mcap $${mcap} > max $${cfg.maxMcap}` });
      filtered = true;
    }
    if (!filtered && cfg.minVolume && volume != null && volume < cfg.minVolume) {
      filteredOut.push({ name: pool.name, reason: `volume $${volume} < min $${cfg.minVolume}` });
      filtered = true;
    }
    if (!filtered && cfg.minHolders && holders != null && holders < cfg.minHolders) {
      filteredOut.push({ name: pool.name, reason: `holders ${holders} < min ${cfg.minHolders}` });
      filtered = true;
    }
    if (!filtered && cfg.minFeeActiveTvlRatio && feeTvl != null && feeTvl < cfg.minFeeActiveTvlRatio) {
      filteredOut.push({ name: pool.name, reason: `fee/TVL ${feeTvl} < min ${cfg.minFeeActiveTvlRatio}` });
      filtered = true;
    }
    if (!filtered && cfg.maxVolatility != null && volatility != null && volatility > cfg.maxVolatility) {
      filteredOut.push({ name: pool.name, reason: `vol ${volatility} > max ${cfg.maxVolatility}` });
      filtered = true;
    }
    if (!filtered && cfg.minBinStep && binStep != null && binStep < cfg.minBinStep) {
      filteredOut.push({ name: pool.name, reason: `binStep ${binStep} < min ${cfg.minBinStep}` });
      filtered = true;
    }
    if (!filtered && cfg.maxBinStep && binStep != null && binStep > cfg.maxBinStep) {
      filteredOut.push({ name: pool.name, reason: `binStep ${binStep} > max ${cfg.maxBinStep}` });
      filtered = true;
    }
    if (!filtered && organic != null && cfg.minOrganic && organic < cfg.minOrganic) {
      filteredOut.push({ name: pool.name, reason: `organic ${organic} < min ${cfg.minOrganic}` });
      filtered = true;
    }
    if (!filtered && isPoolOnCooldown(pool.pool_address)) {
      filteredOut.push({ name: pool.name, reason: "pool cooldown" });
      filtered = true;
    }
    if (!filtered && isBaseMintOnCooldown(pool.base_mint)) {
      filteredOut.push({ name: pool.name, reason: "token cooldown" });
      filtered = true;
    }
    if (!filtered && t.creator && isDevBlocked(t.creator)) {
      filteredOut.push({ name: pool.name, reason: "blocked deployer" });
      filtered = true;
    }

    if (filtered) continue;

    enriched.push({
      pool: pool.pool_address,
      name: pool.name || `${pool.base_symbol || t.symbol || "?"}-SOL`,
      symbol: pool.base_symbol || t.symbol,
      base_mint: pool.base_mint || t.address,
      base: { mint: pool.base_mint || t.address, symbol: pool.base_symbol || t.symbol },
      market_cap: mcap,
      volume_window: volume,
      holder_count: holders,
      liquidity: tvl,
      fee_active_tvl_ratio: feeTvl,
      organic_score: organic,
      volatility,
      bin_step: binStep,
      fee_pct: pool.fee_pct ? numeric(pool.fee_pct) : null,
      gmgn_total_fee_sol: t.gas_fee ? numeric(t.gas_fee) : null,
      price_change_1h: t.price_change_percent1h ? numeric(t.price_change_percent1h) : null,
      smart_degen_count: t.smart_degen_count ?? 0,
      renowned_count: t.renowned_count ?? 0,
      source: "gmgn_trending",
    });
  }

  enriched.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  const top = enriched.slice(0, limit);

  log("gmgn_screening", `${top.length} candidates passed filters out of ${tokens.length} trending`);

  return {
    candidates: top,
    filtered_examples: filteredOut.slice(0, 20),
    total_trending: tokens.length,
    total_meteora: meteoraTokens.length,
  };
}

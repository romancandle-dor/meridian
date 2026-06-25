import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  addLiquidityToPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken, getConnection, getWallet } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons, getConsecutiveLosses } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { normalizeTimeframe, scaleScreeningToTimeframe } from "../screening-scales.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

const SENSITIVE_CONFIG_KEYS = new Set([
  "gmgnApiKey",
  "hiveMindApiKey",
  "publicApiKey",
]);

function redactConfigValue(key, value) {
  if (!SENSITIVE_CONFIG_KEYS.has(key)) return value;
  return typeof value === "string" && value ? "***redacted***" : value;
}

function redactAppliedConfig(applied) {
  return Object.fromEntries(
    Object.entries(applied || {}).map(([key, value]) => [key, redactConfigValue(key, value)]),
  );
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  // DISABLED: Meteora fee_active_tvl_ratio unreliable (returns 0 for many pools).
      // Screening already applies config filters; safety check causes false positives.
      /*
      const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
      const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
      if (
        minFeeActiveTvlRatio != null &&
        minFeeActiveTvlRatio > 0 &&
        (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
      ) {
        return {
          pass: false,
          reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
        };
      }
      */

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }
  const maxVol = numberOrNull(config.screening.maxVolatility);
  if (maxVol != null && volatility > maxVol) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility} exceeds maxVolatility ${maxVol}. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  const baseMint = detail?.token_x?.address || detail?.base_token_address || null;
  const entryMarketData = {
    entry_mcap: numberOrNull(detail?.token_x?.market_cap ?? detail?.base_token_market_cap),
    entry_tvl: tvl,
    entry_volume: numberOrNull(detail?.volume),
    entry_holders: numberOrNull(detail?.base_token_holders ?? detail?.token_x?.holders),
  };

  return { pass: true, entryMarketData };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: async (args) => {
    const effectiveStrategy = args.strategy || config.strategy.strategy;
    const isHybrid = effectiveStrategy === "hybrid" || effectiveStrategy === "mixed" || effectiveStrategy === "multi_layer";
    if (isHybrid) {
    const totalAmount = Number(args.amount_y ?? args.amount_sol ?? 0);
    const bidAskAmount = Math.round(totalAmount * 0.8 * 10000) / 10000;
    const spotAmount = Math.round(totalAmount * 0.2 * 10000) / 10000;
      const bidAskArgs = { ...args, strategy: "bid_ask", amount_y: bidAskAmount, amount_sol: bidAskAmount };
      const result = await deployPosition(bidAskArgs);
      if (result?.success && result?.position && spotAmount > 0.01) {
        try {
          const addResult = await addLiquidityToPosition({ position_address: result.position, amount_sol: spotAmount, strategy: "spot" });
          result.spot_add = addResult;
          result.hybrid = true;
          result.amount_y = totalAmount;
          result.amount_sol = totalAmount;
        } catch (e) {
          result.spot_add = { success: false, error: e.message };
        }
      }
      return result;
    }
    return deployPosition(args);
  },
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  add_liquidity_to_position: addLiquidityToPosition,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: REPO_ROOT,
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // DISABLED Jun21 (user decision "flat aja"). All programmatic auto-evolve
    // paths (lessons.js §1/§2/§3 + Darwin + HiveMind + LP Agent Relay) were
    // already disabled, but the LLM could STILL call this tool from its own
    // volition and write to user-config.json (the deployAmountSol=3.5 SELF-TUNED
    // trap, etc.). Locking here is the single chokepoint — every key, every
    // reason, every caller rejected. To change a threshold, the user runs
    // `node cli.js config set <field> <n>` manually after discussing a case.
    return {
      error: "update_config is disabled — Meridian is FLAT. To change a threshold, run `node cli.js config set <field> <n>` manually.",
      attempted_keys: Object.keys(changes || {}),
      reason_ignored: reason || null,
    };
  },
  // ──────────────────────────────────────────────────────────────────
  //  update_config ORIGINALLY LIVED HERE (~312 lines of CONFIG_MAP +
  //  apply/write logic). It was DISABLED Jun21 — see the stub above.
  //  Original code preserved in git history if it ever needs to come back.
  //  Do NOT re-enable without explicit user approval.
  // ──────────────────────────────────────────────────────────────────
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee, volatility: args.volatility, feeTvlRatio: args.fee_tvl_ratio, organicScore: args.organic_score, entryMcap: args.entry_mcap, entryTvl: args.entry_tvl }).catch(() => {});
        if (result.success && result.position && result.pool) {
          (async () => {
            try {
              await new Promise(r => setTimeout(r, 30000));
              const pnl = await getPositionPnl({ pool_address: result.pool, position_address: result.position });
              const pnlPct = Number(pnl?.pnl_pct ?? 0);
              const currentValue = Number(pnl?.current_value_usd ?? 0);
              if (pnlPct < -5 && pnlPct > -99) {
                log("deploy", `Post-deploy validation: PnL ${pnlPct}% < -5% — bad position state, auto-closing`);
                await closePosition({ position_address: result.position, reason: "post_deploy_failed" });
              } else if (pnlPct <= -99) {
                log("deploy", `Post-deploy PnL ${pnlPct}% — position not yet indexed by API, skipping auto-close`);
              }
            } catch (e) {
              log("deploy", `Post-deploy PnL check failed: ${e.message}`);
            }
          })();
        }
      } else if (name === "close_position") {
        (async () => {
          const trackedClose = result.position ? getTrackedPosition(result.position) : null;
          const ageH = trackedClose?.deployed_at ? (Date.now() - new Date(trackedClose.deployed_at).getTime()) / 3600000 : null;
          notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0, reason: args.reason || null, feesUsd: trackedClose?.total_fees_claimed_usd ?? 0, ageHours: ageH }).catch(() => {});
        })();
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold or config disables it
        const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
        if (config.management.autoSwapAfterClaim && !args.skip_swap && result.base_mint && result.base_mint !== WRAPPED_SOL_MINT) {
          try {
            let tokenBalance = null;
            // Try Helius first (fast path), retry with delay for indexing lag
            for (let attempt = 0; attempt < 3; attempt++) {
              const balances = await getWalletBalances({});
              if (balances.error) {
                if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
                break;
              }
              const t = balances.tokens?.find(t => t.mint === result.base_mint);
              if (t && t.balance > 0) { tokenBalance = t.balance; break; }
              if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
            }
            // Fallback: direct RPC token account balance if Helius failed
            if (tokenBalance === null) {
              const walletAddress = getWallet().publicKey.toString();
              const rpcUrl = process.env.RPC_URL || config.rpcUrl;
              const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
              for (const progId of TOKEN_PROGRAMS) {
                for (let attempt = 0; attempt < 3; attempt++) {
                  try {
                    const res = await fetch(rpcUrl, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        jsonrpc: "2.0", id: 1,
                        method: "getTokenAccountsByOwner",
                        params: [walletAddress, { mint: result.base_mint, programId: progId }, { encoding: "jsonParsed" }]
                      })
                    });
                    const data = await res.json();
                    const accounts = data?.result?.value || [];
                    if (accounts.length > 0) {
                      const parsed = accounts[0].account?.data?.parsed?.info?.tokenAmount;
                      if (parsed && parseFloat(parsed.uiAmount) > 0) {
                        tokenBalance = parseFloat(parsed.uiAmount);
                        break;
                      }
                    }
                  } catch (rpcErr) {
                    log("executor_warn", `Auto-swap RPC fallback attempt ${attempt + 1}/3: ${rpcErr.message}`);
                  }
                  if (tokenBalance === null && attempt < 2) await new Promise(r => setTimeout(r, 2000));
                }
                if (tokenBalance !== null) break;
              }
            }
            if (tokenBalance !== null && tokenBalance > 0) {
              log("executor", `Auto-swapping ${result.base_mint.slice(0, 8)} (${tokenBalance}) back to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: tokenBalance });
              result.auto_swapped = true;
              result.auto_swap_note = `Base token already auto-swapped back to SOL. Do NOT call swap_token again.`;
              if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
            }
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          let tokenBalance = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const balances = await getWalletBalances({});
            if (balances.error) {
              if (attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue; }
              break;
            }
            const t = balances.tokens?.find(t => t.mint === result.base_mint);
            if (t && t.balance > 0) { tokenBalance = t.balance; break; }
            break;
          }
          if (tokenBalance === null) {
            try {
              const { PublicKey } = await import("@solana/web3.js");
              const conn = getConnection();
              const wallet = getWallet();
              const mintPubkey = new PublicKey(result.base_mint);
              const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
              for (const progId of TOKEN_PROGRAMS) {
                try {
                  const accounts = await conn.getTokenAccountsByOwner(wallet.publicKey, { mint: mintPubkey, programId: new PublicKey(progId) });
                  if (accounts.value.length > 0) {
                    const parsed = accounts.value[0].account.data?.parsed?.info?.tokenAmount;
                    if (parsed && parseFloat(parsed.uiAmount) > 0) {
                      tokenBalance = parseFloat(parsed.uiAmount);
                      break;
                    }
                  }
                } catch (_) {}
              }
            } catch (rpcErr) {
              log("executor_warn", `Auto-swap RPC fallback after claim failed: ${rpcErr.message}`);
            }
          }
          if (tokenBalance !== null && tokenBalance > 0) {
            log("executor", `Auto-swapping claimed ${result.base_mint.slice(0, 8)} (${tokenBalance}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: tokenBalance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const cl = getConsecutiveLosses();
      if (cl >= 3) {
        return { pass: false, reason: `Circuit breaker active (${cl} consecutive losses). Use /reset to clear.` };
      }

      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = 0.1;
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }
      // Hard cap: enforce deployAmountSol as absolute ceiling (prevent LLM override)
      const maxAllowed = config.management.deployAmountSol;
      if (amountY > maxAllowed) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL exceeds configured deployAmountSol (${maxAllowed} SOL). LLM cannot override.`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}

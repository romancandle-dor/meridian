/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_started_at: null,
    pending_trailing_current_pnl_pct: null,
    pending_trailing_peak_pnl_pct: null,
    pending_trailing_drop_pct: null,
    pending_trailing_started_at: null,
    confirmed_trailing_exit_reason: null,
    confirmed_trailing_exit_until: null,
    trailing_active: false,
    // Hold-until-profit safety net tracking
    tvl_dead_since: null,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

export function queuePeakConfirmation(position_address, candidatePnlPct, options = {}) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;

  if (options.immediate) {
    pos.peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL accepted at ${candidatePnlPct.toFixed(2)}% from rpc poll`);
    return true;
  }

  const changed =
    pos.pending_peak_pnl_pct == null ||
    candidatePnlPct > pos.pending_peak_pnl_pct;

  if (!changed) return false;

  pos.pending_peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} peak candidate ${candidatePnlPct.toFixed(2)}% queued for 15s confirmation`);
  return true;
}

export function resolvePendingPeak(position_address, currentPnlPct, toleranceRatio = 0.85) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) return { confirmed: false, pending: false };

  const pendingPeak = pos.pending_peak_pnl_pct;

  // RPC fail — trust the pending peak from the earlier valid RPC call
  if (currentPnlPct == null) {
    pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak);
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% (RPC null — trusted pending)`);
    return { confirmed: true, peak: pos.peak_pnl_pct };
  }

  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;

  if (currentPnlPct >= pendingPeak * toleranceRatio) {
    pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% after recheck`);
    return { confirmed: true, peak: pos.peak_pnl_pct };
  }

  save(state);
  log("state", `Position ${position_address} rejected pending peak ${pendingPeak.toFixed(2)}% after 15s recheck (current: ${currentPnlPct != null ? currentPnlPct.toFixed(2) : "?"}%)`);
  return { confirmed: false, rejected: true, pendingPeak };
}

export function queueTrailingDropConfirmation(position_address, peakPnlPct, currentPnlPct, trailingDropPct) {
  if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;
  const dropFromPeak = peakPnlPct - currentPnlPct;
  if (dropFromPeak < trailingDropPct) return false;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const changed =
    pos.pending_trailing_current_pnl_pct == null ||
    currentPnlPct < pos.pending_trailing_current_pnl_pct ||
    dropFromPeak > (pos.pending_trailing_drop_pct ?? -Infinity);

  if (!changed) return false;

  pos.pending_trailing_peak_pnl_pct = peakPnlPct;
  pos.pending_trailing_current_pnl_pct = currentPnlPct;
  pos.pending_trailing_drop_pct = dropFromPeak;
  pos.pending_trailing_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} trailing drop candidate queued: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}%`);
  return true;
}

export function resolvePendingTrailingDrop(position_address, currentPnlPct, trailingDropPct, tolerancePct = 1.0) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_trailing_current_pnl_pct == null || pos.pending_trailing_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingCurrent = pos.pending_trailing_current_pnl_pct;
  const pendingPeak = pos.pending_trailing_peak_pnl_pct;
  const pendingDrop = pos.pending_trailing_drop_pct ?? (pendingPeak - pendingCurrent);

  // RPC fail — trust the drop from the earlier valid RPC call
  if (currentPnlPct == null) {
    pos.pending_trailing_current_pnl_pct = null;
    pos.pending_trailing_peak_pnl_pct = null;
    pos.pending_trailing_drop_pct = null;
    pos.pending_trailing_started_at = null;
    save(state);
    log("state", `Position ${position_address} trailing drop confirmed (RPC null — trusted pending: peak ${pendingPeak.toFixed(2)}% → current ${pendingCurrent.toFixed(2)}%, drop ${pendingDrop.toFixed(2)}%)`);
    return { confirmed: true, reason: `Trailing TP (RPC null fallback): peak ${pendingPeak.toFixed(2)}% → ${pendingCurrent.toFixed(2)}%` };
  }

  pos.pending_trailing_current_pnl_pct = null;
  pos.pending_trailing_peak_pnl_pct = null;
  pos.pending_trailing_drop_pct = null;
  pos.pending_trailing_started_at = null;

  const stillNearCrash = currentPnlPct <= pendingCurrent + tolerancePct;
  const stillDroppedEnough = (pendingPeak - currentPnlPct) >= trailingDropPct;

  if (stillNearCrash && stillDroppedEnough) {
    const reason = `Trailing TP: peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${(pendingPeak - currentPnlPct).toFixed(2)}% >= ${trailingDropPct}%)`;
    pos.confirmed_trailing_exit_reason = reason;
    pos.confirmed_trailing_exit_until = new Date(Date.now() + 30_000).toISOString();
    save(state);
    log("state", `Position ${position_address} trailing drop confirmed after recheck: pending drop ${pendingDrop.toFixed(2)}%, current ${currentPnlPct.toFixed(2)}%`);
    return { confirmed: true, reason };
  }

  save(state);
  log("state", `Position ${position_address} rejected trailing drop after 15s recheck (pending current: ${pendingCurrent.toFixed(2)}%, current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Compute dynamic OOR wait (5-15 min) based on how far price is from range.
 * Further OOR = shorter wait (faster capital rotation).
 * Defaults to baseWait when bin info is unavailable.
 */
export function dynamicOorWaitMinutes(positionData, baseWait = 15) {
  const { active_bin, upper_bin, lower_bin } = positionData;
  if (active_bin == null) return baseWait;
  let binsOor = 0;
  if (upper_bin != null && active_bin > upper_bin) {
    binsOor = active_bin - upper_bin;
  } else if (lower_bin != null && active_bin < lower_bin) {
    binsOor = lower_bin - active_bin;
  }
  if (binsOor <= 0) return baseWait;
  const clampedBins = Math.min(binsOor, 10);
  return Math.max(5, Math.round(baseWait - (clampedBins / 10) * (baseWait - 5)));
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  if (pos.confirmed_trailing_exit_until) {
    if (new Date(pos.confirmed_trailing_exit_until).getTime() > Date.now() && pos.confirmed_trailing_exit_reason) {
      const reason = pos.confirmed_trailing_exit_reason;
      pos.confirmed_trailing_exit_reason = null;
      pos.confirmed_trailing_exit_until = null;
      save(state);
      return { action: "TRAILING_TP", reason, confirmed_recheck: true };
    }
    pos.confirmed_trailing_exit_reason = null;
    pos.confirmed_trailing_exit_until = null;
  }

  let changed = false;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  // ── Stop loss with bounce hold buffer (only when OOR if stopLossOnlyWhenOor is set) ──
  const holdMode = mgmtConfig.holdUntilProfit === true;
  let slTriggered = false;

  // ── Stop loss — DISABLED in hold-until-profit mode ──
  // In hold mode, depth safety (PnL ≤ holdUntilProfitDepthLossPct) replaces SL.
  // Bounce-hold SL buffer is also skipped (mutually exclusive with hold mode).
  if (!holdMode) {
    const slOorOk = !mgmtConfig.stopLossOnlyWhenOor || in_range === false;
    if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct && slOorOk) {
      slTriggered = true;
      const holdMin = mgmtConfig.stopLossHoldMinutes ?? 30;
      const now = Date.now();

      // First time hitting SL — set hold buffer and skip close
      if (!pos.sl_hold_until) {
        pos.sl_hold_until = now + holdMin * 60_000;
        pos.sl_trigger_pnl_pct = currentPnlPct;
        save(state);
        log("state", `Position ${position_address} entered SL bounce-hold (${holdMin}m) — PnL ${currentPnlPct.toFixed(2)}% awaiting bounce or escalation`);
        return null;
      }

      // During hold: check hard-CLOSE bypass conditions
      const triggerPnl = pos.sl_trigger_pnl_pct ?? currentPnlPct;
      const lossDeepened = (triggerPnl - currentPnlPct) > 10;
      const tvlCollapsed = fee_per_tvl_24h != null && fee_per_tvl_24h < 2;
      const holdExpired = now >= pos.sl_hold_until;

      if (lossDeepened || tvlCollapsed || holdExpired) {
        delete pos.sl_hold_until;
        delete pos.sl_trigger_pnl_pct;
        save(state);
        const bypass = lossDeepened ? " (loss deepened 10%+)" : tvlCollapsed ? " (TVL collapsed)" : ` (held ${holdMin}m, no bounce)`;
        return {
          action: "STOP_LOSS",
          reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%${mgmtConfig.stopLossOnlyWhenOor ? " (OOR only)" : ""}${bypass}`,
        };
      }

      // Bounce detected — cancel hold
      if (currentPnlPct > triggerPnl + 1) {
        log("state", `Position ${position_address} SL hold cancelled — bounce ${triggerPnl.toFixed(2)}% → ${currentPnlPct.toFixed(2)}%`);
        delete pos.sl_hold_until;
        delete pos.sl_trigger_pnl_pct;
        save(state);
        return null;
      }

      // Still in hold — no action
      return null;
    }

    // Clear hold state if PnL recovers above SL threshold
    if (pos.sl_hold_until && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct > mgmtConfig.stopLossPct) {
      log("state", `Position ${position_address} SL hold cleared — PnL ${currentPnlPct.toFixed(2)}% above SL ${mgmtConfig.stopLossPct}%`);
      delete pos.sl_hold_until;
      delete pos.sl_trigger_pnl_pct;
      save(state);
    }
  }

  // ── Hold-until-profit: depth safety ──────────────────────────────
  // Catastrophic loss exit. Bounded downside in hold mode — replaces SL.
  if (holdMode && !pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.holdUntilProfitDepthLossPct != null && currentPnlPct <= mgmtConfig.holdUntilProfitDepthLossPct) {
    delete pos.tvl_dead_since;
    return {
      action: "DEPTH_SAFETY",
      reason: `Hold-mode depth safety: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.holdUntilProfitDepthLossPct}% (catastrophic — pool unsalvageable)`,
    };
  }

  // ── Hold-until-profit: TVL/fee safety net ──────────────────────
  // Pool "dead" = fee/TVL 24h below threshold sustained for N hours.
  // Uses fee/TVL as a proxy (already in positionData) instead of raw TVL diff.
  if (holdMode && fee_per_tvl_24h != null && mgmtConfig.holdUntilProfitTvlThreshold != null && fee_per_tvl_24h < mgmtConfig.holdUntilProfitTvlThreshold) {
    const now = Date.now();
    if (!pos.tvl_dead_since) {
      pos.tvl_dead_since = new Date(now).toISOString();
      save(state);
      log("state", `Position ${position_address} TVL-dead timer started (fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < ${mgmtConfig.holdUntilProfitTvlThreshold}%)`);
    } else {
      const deadHours = (now - new Date(pos.tvl_dead_since).getTime()) / 3600000;
      if (deadHours >= (mgmtConfig.holdUntilProfitTvlHours ?? 4)) {
        delete pos.tvl_dead_since;
        return {
          action: "TVL_DEAD",
          reason: `Hold-mode TVL safety: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < ${mgmtConfig.holdUntilProfitTvlThreshold}% for ${deadHours.toFixed(1)}h (pool dead)`,
        };
      }
    }
  } else if (holdMode && pos.tvl_dead_since) {
    // fee/TVL recovered — clear dead timer
    log("state", `Position ${position_address} TVL-dead timer cleared (fee/TVL recovered)`);
    delete pos.tvl_dead_since;
    save(state);
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Profit floor (Jun21) ───────────────────────────────────────
  // Once a position has proven itself (peak ≥ trigger), lock a hard floor
  // so it can NEVER close below `profitFloorLockPct`. Catches the case where
  // trailing drop wouldn't fire fast enough and price falls back to a loss.
  // Checked AFTER trailing (so trailing wins when both apply — higher exit
  // is better) but BEFORE other exits so this acts as a last-line floor.
  if (
    !pnl_pct_suspicious &&
    mgmtConfig.profitFloorEnabled === true &&
    mgmtConfig.profitFloorTriggerPct != null &&
    mgmtConfig.profitFloorLockPct != null &&
    pos.peak_pnl_pct != null &&
    currentPnlPct != null &&
    pos.peak_pnl_pct >= mgmtConfig.profitFloorTriggerPct &&
    currentPnlPct <= mgmtConfig.profitFloorLockPct
  ) {
    return {
      action: "PROFIT_FLOOR",
      reason: `Profit floor: peak ${pos.peak_pnl_pct.toFixed(2)}% ≥ ${mgmtConfig.profitFloorTriggerPct}%, current ${currentPnlPct.toFixed(2)}% ≤ floor ${mgmtConfig.profitFloorLockPct}% (lock activated)`,
    };
  }

  // ── Out of range too long (dynamic 5-15 min based on bin distance) ──
  // SKIPPED in hold-until-profit mode — a bleeding position that goes OOR is
  // held to wait for the bounce back into range (TVL_DEAD handles truly dead pools).
  if (!holdMode && pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    const oorWait = dynamicOorWaitMinutes(positionData, mgmtConfig.outOfRangeWaitMinutes);
    if (minutesOOR >= oorWait) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${oorWait}m, bins OOR)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  // In NON-hold mode: fires regardless of PnL (original behaviour).
  // In HOLD mode: still fires, BUT only when the position is at/above breakeven
  //   (currentPnlPct >= 0). This rotates capital out of pools whose post-deploy
  //   24h fee/TVL is below threshold ("pool not worth it") WITHOUT ever realizing
  //   a loss — losing positions stay held for the bounce (TVL_DEAD net catches
  //   truly dead pools). Implements the user's intent: wait minAge, judge yield,
  //   drop the unworthy — without breaking hold-until-profit downside protection.
  const { age_minutes } = positionData;
  const yieldGateAllowed = !holdMode || (currentPnlPct != null && currentPnlPct >= 0);
  if (yieldGateAllowed) {
    const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
    if (
      fee_per_tvl_24h != null &&
      mgmtConfig.minFeePerTvl24h != null &&
      fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
      (age_minutes == null || age_minutes >= minAgeForYieldCheck)
    ) {
      return {
        action: "LOW_YIELD",
        reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m, PnL ${currentPnlPct == null ? "?" : currentPnlPct.toFixed(2)}% — rotating green capital)`,
      };
    }
  }

  // ── Hold-until-profit: profit target ────────────────────────────
  // Primary exit in hold mode — close when PnL crosses profit floor.
  if (holdMode && !pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.holdUntilProfitMinPct != null && currentPnlPct >= mgmtConfig.holdUntilProfitMinPct) {
    delete pos.tvl_dead_since;
    return {
      action: "PROFIT_TARGET",
      reason: `Hold-mode profit target hit: PnL ${currentPnlPct.toFixed(2)}% >= ${mgmtConfig.holdUntilProfitMinPct}%`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}

// ─── Agent Meridian API client ──────────────────────────────────────
//
// Centralized HTTP wrapper for the Agent Meridian relay API
// (https://api.agentmeridian.xyz/api). Used by:
//   - tools/dlmm.js     → deploy/close relay (`/execution/zap-in/*`, `/execution/zap-out/*`)
//   - tools/dlmm.js     → position discovery (`/positions/open/raw`)
//   - tools/screening.js → Discord signal candidates (`/signals/discord/candidates`)
//
// All endpoints are gated on `config.api.lpAgentRelayEnabled` in the callers; the
// helpers here only build the URL/headers and run the request. `shouldUseLpAgentRelay`
// is the single source of truth for whether to call these at all.

import { config } from "../config.js";

const DEFAULT_API_URL = "https://api.agentmeridian.xyz/api";

// ─── Public helpers ─────────────────────────────────────────────────

export function getAgentMeridianBase() {
  return String(config.api?.url || DEFAULT_API_URL).replace(/\/+$/, "");
}

export function getAgentMeridianHeaders({ json = false } = {}) {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  if (config.api?.publicApiKey) {
    headers["x-api-key"] = config.api.publicApiKey;
  }
  return headers;
}

export function getAgentIdForRequests() {
  // Single source of truth lives in hiveMind.agentId (user-config.json: "agentId").
  // Falls back to env AGENT_ID if config is missing.
  return (
    config.hiveMind?.agentId ??
    process.env.AGENT_ID ??
    null
  );
}

// ─── Retryable fetch wrapper ────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableMeridianStatus(status) {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function isRetryableMeridianError(error) {
  if (isRetryableMeridianStatus(Number(error?.status || 0))) return true;
  const name = String(error?.name || "");
  const message = String(error?.message || "").toLowerCase();
  return (
    name === "AbortError" ||
    message.includes("aborted") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}

function meridianRetryDelayMs(error, attempt) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 10_000);
  }
  return Math.min(500 * 2 ** attempt, 5_000);
}

async function meridianFetchWithTimeout(url, options, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal;
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromParent);
  }
}

async function meridianJsonOnce(pathname, options = {}, timeoutMs = null) {
  const res = await meridianFetchWithTimeout(
    `${getAgentMeridianBase()}${pathname}`,
    options,
    timeoutMs,
  );
  const text = await res.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(payload?.error || `${pathname} ${res.status}`);
    error.status = res.status;
    error.payload = payload;
    error.retryAfter = res.headers.get("retry-after");
    throw error;
  }
  return payload;
}

// ─── Public: agentMeridianJson ──────────────────────────────────────
//
// Drop-in replacement for the old `meridianJson(pathname, options)`. Pass
// `options.retry = { maxElapsedMs, maxAttempts, perAttemptTimeoutMs }` to
// opt into exponential-backoff retry on 408/409/425/429/5xx or network errors.
// Without `retry`, performs a single attempt.

export async function agentMeridianJson(pathname, options = {}) {
  const { retry, ...fetchOptions } = options;
  if (!retry) {
    return meridianJsonOnce(pathname, fetchOptions);
  }

  const maxElapsedMs = Number(retry.maxElapsedMs || 30_000);
  const maxAttempts = Number(retry.maxAttempts || 10);
  const startedAt = Date.now();
  let attempt = 0;
  let lastError = null;

  while (Date.now() - startedAt < maxElapsedMs && attempt < maxAttempts) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(1, maxElapsedMs - elapsedMs);
    try {
      return await meridianJsonOnce(
        pathname,
        fetchOptions,
        Math.min(Number(retry.perAttemptTimeoutMs || 10_000), remainingMs),
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableMeridianError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }
      const waitMs = Math.min(
        meridianRetryDelayMs(error, attempt),
        Math.max(0, remainingMs - 1),
      );
      if (waitMs <= 0) break;
      await sleep(waitMs);
      attempt += 1;
    }
  }

  throw lastError || new Error(`${pathname} retry budget exhausted`);
}

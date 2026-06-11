// ─── Meteora Data API client ──────────────────────────────────────────
// See /home/ubuntu/meridian/docs/apis.md for field definitions.

'use strict';

const DATA_API = 'https://dlmm.datapi.meteora.ag';

async function _getJson(url, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Meteora ${url} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function getPortfolioOpen(wallet) {
  if (!wallet) throw new Error('wallet required');
  return _getJson(`${DATA_API}/portfolio/open?user=${wallet}`);
}

async function getPoolMetadata(poolAddress) {
  if (!poolAddress) throw new Error('poolAddress required');
  return _getJson(`${DATA_API}/pools/${poolAddress}`);
}

async function getPositionPnl(poolAddress, wallet, { status = 'open' } = {}) {
  if (!poolAddress || !wallet) throw new Error('poolAddress + wallet required');
  return _getJson(
    `${DATA_API}/positions/${poolAddress}/pnl?user=${wallet}&status=${status}`,
  );
}

async function batchPositionPnl(poolAddresses, wallet, { status = 'open' } = {}) {
  return Promise.all(poolAddresses.map((p) => getPositionPnl(p, wallet, { status })));
}

// Parallel pnl + portfolio for poll loops.
async function pollTick(poolAddresses, wallet) {
  const start = Date.now();
  const [pnlDatas, portfolio] = await Promise.all([
    batchPositionPnl(poolAddresses, wallet),
    getPortfolioOpen(wallet),
  ]);
  return {
    pnlDatas,
    portfolio,
    elapsedMs: Date.now() - start,
  };
}

module.exports = {
  DATA_API,
  getPortfolioOpen,
  getPoolMetadata,
  getPositionPnl,
  batchPositionPnl,
  pollTick,
};

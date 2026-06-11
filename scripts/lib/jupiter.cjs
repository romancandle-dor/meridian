// ─── Jupiter Data API price fetcher ───────────────────────────────────
// Realtime USD price. NEVER CACHE.
// See /home/ubuntu/meridian/docs/apis.md for batch + field details.

'use strict';

const JUPITER = 'https://datapi.jup.ag';

async function getTokenPrices(mints) {
  if (!mints || mints.length === 0) return [];
  if (Array.isArray(mints)) mints = mints.join(',');
  const url = `${JUPITER}/v1/assets/search?query=${mints}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jupiter ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  // Build a map for easy lookup
  const byId = new Map();
  for (const asset of data) {
    if (asset?.id) byId.set(asset.id, asset);
  }
  return data;
}

async function getTokenXPrice(mint) {
  const arr = await getTokenPrices([mint]);
  return arr[0] || null;
}

module.exports = {
  JUPITER,
  getTokenPrices,
  getTokenXPrice,
};

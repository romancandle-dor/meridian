// ─── PnL formula ──────────────────────────────────────────────────────
// Validated against Meteora /portfolio/open.
// USD: exact match. SOL: ~99.8% match, drift 0.0003-0.003 SOL.
// See /home/ubuntu/meridian/docs/pnl-formula.md for derivation.

'use strict';

const n = (v) => Number(v ?? 0);

function claimableFeesUsd(u) {
  return (
    n(u?.unclaimedFeeTokenX?.usd) +
    n(u?.unclaimedFeeTokenY?.usd) +
    n(u?.unclaimedRewardTokenX?.usd) +
    n(u?.unclaimedRewardTokenY?.usd)
  );
}

function claimableFeesSol(u) {
  return (
    n(u?.unclaimedFeeTokenX?.amountSol) +
    n(u?.unclaimedFeeTokenY?.amountSol) +
    n(u?.unclaimedRewardTokenX?.amountSol) +
    n(u?.unclaimedRewardTokenY?.amountSol)
  );
}

function calcPnlUsd(position) {
  const u = position.unrealizedPnl || {};
  return (
    n(u.balances) +
    n(position.allTimeWithdrawals?.total?.usd) +
    claimableFeesUsd(u) +
    n(position.allTimeFees?.total?.usd) -
    n(position.allTimeDeposits?.total?.usd)
  );
}

function calcPnlSol(position) {
  const u = position.unrealizedPnl || {};
  return (
    n(u.balancesSol) +
    n(position.allTimeWithdrawals?.total?.sol) +
    claimableFeesSol(u) +
    n(position.allTimeFees?.total?.sol) -
    n(position.allTimeDeposits?.total?.sol)
  );
}

function calcPnlPct(pnlValue, depositsValue) {
  if (!Number.isFinite(depositsValue) || depositsValue === 0) return 0;
  return (pnlValue / depositsValue) * 100;
}

// Pool-level: sum across positions in a pool.
function poolPnlUsd(positions) {
  return positions.reduce((sum, p) => sum + calcPnlUsd(p), 0);
}
function poolPnlSol(positions) {
  return positions.reduce((sum, p) => sum + calcPnlSol(p), 0);
}
function poolDepositsUsd(positions) {
  return positions.reduce((sum, p) => sum + n(p.allTimeDeposits?.total?.usd), 0);
}
function poolDepositsSol(positions) {
  return positions.reduce((sum, p) => sum + n(p.allTimeDeposits?.total?.sol), 0);
}

// Compare with Meteora's pre-computed portfolio values.
function compareWithPortfolio(ours, portfolio) {
  return {
    usdDelta: ours.usd - (portfolio?.pnlUsd ?? 0),
    solDelta: ours.sol - (portfolio?.pnlSol ?? 0),
  };
}

module.exports = {
  n,
  claimableFeesUsd,
  claimableFeesSol,
  calcPnlUsd,
  calcPnlSol,
  calcPnlPct,
  poolPnlUsd,
  poolPnlSol,
  poolDepositsUsd,
  poolDepositsSol,
  compareWithPortfolio,
};

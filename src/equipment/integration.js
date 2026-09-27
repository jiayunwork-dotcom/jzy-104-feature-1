'use strict';

// 受监测设备的时序积分内核。
// 相邻两条读数之间电流密度视为线性变化，按梯形积分得到通过的电量，
// 再乘材料档的电化学当量系数换成单位面积失重（g/m²）与壁厚损失（mm）。
// 系数全部由单点核算同一套当量公式与单位换算导出（1 A/m² 下的速率），
// 不在这里另抄一份公式。

const { massLossRateKgPerM2S } = require('../physics/equivalent');
const { penetrationRateMPerS } = require('../physics/depth');
const {
  SECONDS_PER_DAY,
  MM_PER_M,
  GRAMS_PER_KG,
} = require('../physics/constants');

const MS_PER_SECOND = 1000;
const MS_PER_DAY = SECONDS_PER_DAY * MS_PER_SECOND;

// 每 (A/m²·s) 电量对应的失重与深度系数：取 1 A/m² 下的单点速率即得。
function chargeCoefficients(material) {
  const unitMassRateKgPerM2S = massLossRateKgPerM2S(
    material.molarMassKgPerMol,
    1,
    material.valence
  );
  return {
    // g/m² per (A/m²·s)
    massGPerM2PerCharge: unitMassRateKgPerM2S * GRAMS_PER_KG,
    // mm per (A/m²·s)
    depthMmPerCharge:
      penetrationRateMPerS(unitMassRateKgPerM2S, material.densityKgPerM3) *
      MM_PER_M,
  };
}

// 把按时间升序的读数 [{t(ms), i(A/m²)}] 切成相邻区段；
// 间隔超过 maxGapMs 的区段标记为数据缺口，不参与积分。
function buildSegments(sortedReadings, maxGapMs) {
  const segments = [];
  for (let k = 0; k + 1 < sortedReadings.length; k += 1) {
    const a = sortedReadings[k];
    const b = sortedReadings[k + 1];
    segments.push({
      t0: a.t,
      t1: b.t,
      i0: a.i,
      i1: b.i,
      gap: b.t - a.t > maxGapMs,
    });
  }
  return segments;
}

// 区段内 t 时刻的电流（两端线性插值）。
function currentAt(segment, tMs) {
  const frac = (tMs - segment.t0) / (segment.t1 - segment.t0);
  return segment.i0 + (segment.i1 - segment.i0) * frac;
}

// 区段 [sMs, eMs] 上通过的电量（A/m²·s）：电流线性，梯形即精确积分。
function chargeBetween(segment, sMs, eMs) {
  const dtSec = (eMs - sMs) / MS_PER_SECOND;
  const iStart = currentAt(segment, sMs);
  const iEnd = currentAt(segment, eMs);
  return ((iStart + iEnd) / 2) * dtSec;
}

// 在 [aMs, bMs] 上积分：返回电量、实际覆盖毫秒数与落在范围内的缺口。
function integrateRange(segments, aMs, bMs) {
  let charge = 0;
  let coveredMs = 0;
  const gaps = [];
  for (const segment of segments) {
    const s = Math.max(segment.t0, aMs);
    const e = Math.min(segment.t1, bMs);
    if (e <= s) continue;
    if (segment.gap) {
      gaps.push({ startMs: s, endMs: e });
      continue;
    }
    charge += chargeBetween(segment, s, e);
    coveredMs += e - s;
  }
  return { charge, coveredMs, gaps };
}

// 累计壁厚损失首次达到腐蚀裕量的准确时刻（毫秒），达不到返回 null。
// 区段内电流线性变化 ⇒ 损失随时间是二次曲线，在段内解二次方程，
// 不拿端点凑、不按区间平均速率倒推。
function findExhaustionMs(segments, endMs, allowanceMm, depthMmPerCharge) {
  let lossMm = 0;
  for (const segment of segments) {
    const s = segment.t0;
    const e = Math.min(segment.t1, endMs);
    if (e <= s) continue;
    if (segment.gap) continue;

    const dtSec = (e - s) / MS_PER_SECOND;
    const iStart = currentAt(segment, s);
    const iEnd = currentAt(segment, e);
    const segmentLossMm =
      depthMmPerCharge * ((iStart + iEnd) / 2) * dtSec;

    if (lossMm + segmentLossMm >= allowanceMm) {
      // 解 depth·[i0·τ + (i1-i0)·τ²/(2Δt)] = allowance - loss，τ ∈ [0, Δt]
      const a = (depthMmPerCharge * (iEnd - iStart)) / (2 * dtSec);
      const b = depthMmPerCharge * iStart;
      const c = lossMm - allowanceMm; // ≤ 0
      let tauSec;
      if (a === 0) {
        // 恒定电流：退化为一次方程（b 为 0 时只可能 c 也为 0，τ 取 0）
        tauSec = b === 0 ? 0 : -c / b;
      } else {
        // 数值稳定的求根：τ = -2c / (b + √(b²-4ac))，b ≥ 0 无对消
        const discriminant = Math.max(b * b - 4 * a * c, 0);
        tauSec = (-2 * c) / (b + Math.sqrt(discriminant));
      }
      if (!(tauSec >= 0)) tauSec = 0; // 浮点兜底，钳回段内
      if (tauSec > dtSec) tauSec = dtSec;
      return s + tauSec * MS_PER_SECOND;
    }
    lossMm += segmentLossMm;
  }
  return null;
}

// 剩余寿命预测：窗口 [endMs - windowDays, endMs] 内的平均深度速率
// = 窗口内壁厚损失 / 窗口内实际覆盖天数（缺口不算进分母）。
// 窗口比已有数据长时只用有数据的部分（wStart 不小于首条读数）。
function predictRemainingLife(
  segments,
  endMs,
  firstMs,
  windowDays,
  remainingAllowanceMm,
  depthMmPerCharge
) {
  const windowMs = windowDays * MS_PER_DAY;
  const wStart = Math.max(endMs - windowMs, firstMs === null ? endMs : firstMs);
  const within = integrateRange(segments, wStart, endMs);
  const coveredDaysInWindow = within.coveredMs / MS_PER_DAY;
  const lossInWindowMm = depthMmPerCharge * within.charge;

  const base = { windowDays, coveredDaysInWindow };
  if (within.coveredMs <= 0) {
    return {
      ...base,
      averageRateMmPerDay: null,
      remainingDays: null,
      projectedExhaustionAt: null,
      reason: '窗口内没有可积分的读数区间（读数不足，或有效区间均被数据缺口截断）',
    };
  }
  if (lossInWindowMm === 0) {
    return {
      ...base,
      averageRateMmPerDay: 0,
      remainingDays: null,
      projectedExhaustionAt: null,
      reason: '窗口内平均腐蚀深度速率为零，无法外推剩余寿命',
    };
  }
  const averageRateMmPerDay = lossInWindowMm / coveredDaysInWindow;
  const remainingDays = remainingAllowanceMm / averageRateMmPerDay;
  return {
    ...base,
    averageRateMmPerDay,
    remainingDays,
    projectedExhaustionAt: new Date(
      endMs + remainingDays * MS_PER_DAY
    ).toISOString(),
    reason: null,
  };
}

// 设备截至某一时刻的完整状态。asOfMs 为 null 时取最后一条读数时刻。
// 第一条读数之前、最后一条读数之后都不计入。
function computeStatus({
  equipment,
  material,
  sortedReadings,
  asOfMs,
  windowDays,
}) {
  const coef = chargeCoefficients(material);
  const count = sortedReadings.length;
  const firstMs = count > 0 ? sortedReadings[0].t : null;
  const lastMs = count > 0 ? sortedReadings[count - 1].t : null;

  const effectiveAsOfMs = asOfMs !== null ? asOfMs : lastMs;
  const endMs =
    lastMs === null
      ? 0
      : Math.min(effectiveAsOfMs === null ? lastMs : effectiveAsOfMs, lastMs);

  const maxGapMs = equipment.maxReadingGapDays * MS_PER_DAY;
  const segments = buildSegments(sortedReadings, maxGapMs);

  const total = integrateRange(segments, firstMs === null ? 0 : firstMs, endMs);
  const lossMm = coef.depthMmPerCharge * total.charge;
  const massGPerM2 = coef.massGPerM2PerCharge * total.charge;
  const remainingAllowanceMm = equipment.corrosionAllowanceMm - lossMm;

  const exceededMs = findExhaustionMs(
    segments,
    endMs,
    equipment.corrosionAllowanceMm,
    coef.depthMmPerCharge
  );

  return {
    asOfMs: effectiveAsOfMs,
    cumulativeThicknessLossMm: lossMm,
    cumulativeMassLossGPerM2: massGPerM2,
    remainingThicknessMm: equipment.initialThicknessMm - lossMm,
    remainingAllowanceMm,
    coverage: {
      coveredDays: total.coveredMs / MS_PER_DAY,
      totalSpanDays:
        count >= 2 ? Math.max(0, endMs - firstMs) / MS_PER_DAY : 0,
      gaps: total.gaps.map((gap) => ({
        start: new Date(gap.startMs).toISOString(),
        end: new Date(gap.endMs).toISOString(),
        days: (gap.endMs - gap.startMs) / MS_PER_DAY,
      })),
    },
    allowanceExhausted: exceededMs !== null,
    exceededScrapAt:
      exceededMs === null ? null : new Date(exceededMs).toISOString(),
    prediction:
      exceededMs !== null
        ? null
        : predictRemainingLife(
            segments,
            endMs,
            firstMs,
            windowDays,
            remainingAllowanceMm,
            coef.depthMmPerCharge
          ),
  };
}

module.exports = {
  MS_PER_DAY,
  chargeCoefficients,
  buildSegments,
  integrateRange,
  findExhaustionMs,
  computeStatus,
};

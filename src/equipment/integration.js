'use strict';

// 读数时间积分内核：把「腐蚀电流密度-时间」折线转成累计失重与累计壁厚损失。
//
// 相邻两条读数之间电流密度视为线性变化，按梯形求这一段通过的电量，
// 再换算成失重与壁厚损失。所有电化学当量公式与工程单位换算都直接调用
// 单点核算同一套物理内核（physics/equivalent.js、physics/depth.js），
// 本模块只负责时间轴上的离散与求和，不另抄一份公式。

const {
  massLossRateKgPerM2S,
  toGramsPerM2Day,
} = require('../physics/equivalent');
const { penetrationRateMPerS, toMmPerYear } = require('../physics/depth');
const { SECONDS_PER_DAY, DAYS_PER_YEAR } = require('../physics/constants');

const MS_PER_DAY = SECONDS_PER_DAY * 1000;

// 平均电流 avgI（A/m²）持续 days 天的累计量。
// 日质量损失率 g/(m²·天) 与日深度速率 mm/天（年速率按 365 天折日）
// 与单点核算接口返回的数值出自同一公式链。
function accumulated(material, avgCurrentAmpPerM2, days) {
  const massRate = massLossRateKgPerM2S(
    material.molarMassKgPerMol,
    avgCurrentAmpPerM2,
    material.valence
  );
  const penetration = penetrationRateMPerS(massRate, material.densityKgPerM3);
  return {
    massLossGPerM2: toGramsPerM2Day(massRate) * days,
    wallLossMm: (toMmPerYear(penetration) / DAYS_PER_YEAR) * days,
  };
}

// 单位电流（1 A/m²）的日深度速率 mm/天，供越线时刻的方程求解使用。
// 当量公式对电流是线性的，任意电流的速率 = 该值 × 电流。
function depthRatePerUnitCurrentMmPerDay(material) {
  const massRate = massLossRateKgPerM2S(
    material.molarMassKgPerMol,
    1,
    material.valence
  );
  const penetration = penetrationRateMPerS(massRate, material.densityKgPerM3);
  return toMmPerYear(penetration) / DAYS_PER_YEAR;
}

// 把读数序列切成与 [fromMs, toMs] 相交的段，逐段给出端点时刻、
// 端点处（线性插值的）电流、段长（天）以及该段是否属于数据缺口。
// 缺口判定看两条读数自身的原始间距，与查询窗口无关。
function* clippedSegments(readings, maxGapMs, fromMs, toMs) {
  for (let j = 0; j + 1 < readings.length; j++) {
    const a = readings[j];
    const b = readings[j + 1];
    const s = Math.max(a.ms, fromMs);
    const e = Math.min(b.ms, toMs);
    if (e <= s) continue;
    const segMs = b.ms - a.ms;
    const iS = a.i + (b.i - a.i) * ((s - a.ms) / segMs);
    const iE = a.i + (b.i - a.i) * ((e - a.ms) / segMs);
    yield {
      startMs: s,
      endMs: e,
      startCurrent: iS,
      endCurrent: iE,
      days: (e - s) / MS_PER_DAY,
      gap: segMs > maxGapMs,
    };
  }
}

// 对 [fromMs, toMs] 内所有可积分段求和；缺口段不参与积分，
// 而是（裁剪到区间内后）写进缺口列表。返回累计量与已覆盖天数。
function integrateRange(readings, material, maxGapMs, fromMs, toMs) {
  const acc = { wallLossMm: 0, massLossGPerM2: 0, coveredDays: 0, gaps: [] };
  for (const seg of clippedSegments(readings, maxGapMs, fromMs, toMs)) {
    if (seg.gap) {
      acc.gaps.push({
        from: new Date(seg.startMs).toISOString(),
        to: new Date(seg.endMs).toISOString(),
        days: seg.days,
      });
      continue;
    }
    const part = accumulated(
      material,
      (seg.startCurrent + seg.endCurrent) / 2,
      seg.days
    );
    acc.wallLossMm += part.wallLossMm;
    acc.massLossGPerM2 += part.massLossGPerM2;
    acc.coveredDays += seg.days;
  }
  return acc;
}

// 电流在区间内线性变化时，壁厚损失随时间是二次曲线：
//   L(τ) = k·(i0·τ + (i1−i0)·τ²/(2T))     （τ 为距段起点的天数）
// 令 L(τ) = targetMm 得二次方程，取区间内根。用求根公式的稳定形式
//   τ = 2·target / (k·i0 + √((k·i0)² + 2·k·(i1−i0)·target/T))
// 电流上升、下降、恒定（i0=i1）三种情形统一适用；恒定电流时退化为
// 线性关系 τ = target/(k·i0)。不拿端点凑、不按区间平均速率倒推。
function solveCrossingOffsetDays(material, i0, i1, days, targetMm) {
  const k = depthRatePerUnitCurrentMmPerDay(material);
  const linear = k * i0;
  const discriminant =
    linear * linear + (2 * k * (i1 - i0) * targetMm) / days;
  return (2 * targetMm) / (linear + Math.sqrt(Math.max(0, discriminant)));
}

// 从头遍历可积分段，定位累计壁厚损失达到 allowanceMm 的区间，
// 在该区间内解二次方程给出越线的准确时刻（epoch 毫秒）。
// 调用前已确认区间终点处累计量达到裕量，故必然找得到。
function findExhaustionMs(readings, material, maxGapMs, fromMs, toMs, allowanceMm) {
  let cumulative = 0;
  for (const seg of clippedSegments(readings, maxGapMs, fromMs, toMs)) {
    if (seg.gap) continue;
    const part = accumulated(
      material,
      (seg.startCurrent + seg.endCurrent) / 2,
      seg.days
    );
    if (part.wallLossMm > 0 && cumulative + part.wallLossMm >= allowanceMm) {
      const offsetDays = solveCrossingOffsetDays(
        material,
        seg.startCurrent,
        seg.endCurrent,
        seg.days,
        allowanceMm - cumulative
      );
      return seg.startMs + offsetDays * MS_PER_DAY;
    }
    cumulative += part.wallLossMm;
  }
  return null;
}

module.exports = {
  MS_PER_DAY,
  accumulated,
  integrateRange,
  findExhaustionMs,
  solveCrossingOffsetDays,
};

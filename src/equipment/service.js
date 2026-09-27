'use strict';

// 受监测设备的状态编排：累计壁厚损失、缺口、越线时刻与剩余寿命预测。
// 物理计算全部落在 equipment/integration.js（其内部走单点核算的物理内核），
// 本层只负责取数、定时间窗与组装结果。

const { ValidationError } = require('../errors');
const {
  MS_PER_DAY,
  integrateRange,
  findExhaustionMs,
} = require('./integration');

const DEFAULT_WINDOW_DAYS = 30;

function toIso(ms) {
  return new Date(ms).toISOString();
}

function sortedReadings(eq) {
  return [...eq.readings.entries()]
    .map(([ms, i]) => ({ ms, i }))
    .sort((a, b) => a.ms - b.ms);
}

class EquipmentService {
  constructor(equipmentRepository, materialRepository) {
    this.equipment = equipmentRepository;
    this.materials = materialRepository;
  }

  register(input) {
    // 材料档没登记过 → 404（在设备名冲突检查之前，先保证引用的档存在）
    this.materials.get(input.materialName);
    return this.equipment.register(input);
  }

  status(name, { asOfMs = null, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
    if (asOfMs !== null && !Number.isFinite(asOfMs)) {
      throw new ValidationError('asOf', '必须是可解析的 ISO 8601 时间戳');
    }
    if (!Number.isFinite(windowDays) || windowDays <= 0) {
      throw new ValidationError('windowDays', '必须是正数（天）');
    }

    const eq = this.equipment.getRef(name);
    const material = this.materials.get(eq.materialName);
    const readings = sortedReadings(eq);
    const maxGapMs = eq.maxReadingGapDays * MS_PER_DAY;

    const firstMs = readings.length > 0 ? readings[0].ms : null;
    const lastMs = readings.length > 0 ? readings[readings.length - 1].ms : null;
    // 不带截止时刻就取最后一条读数的时刻
    const cutoffMs = asOfMs !== null ? asOfMs : lastMs;

    // 第一条之前、最后一条之后都不算：积分区间裁剪到 [首读数, min(截止, 末读数)]
    let totals = { wallLossMm: 0, massLossGPerM2: 0, coveredDays: 0, gaps: [] };
    let spanEndMs = firstMs;
    if (readings.length >= 2 && cutoffMs !== null && cutoffMs > firstMs) {
      spanEndMs = Math.min(cutoffMs, lastMs);
      totals = integrateRange(readings, material, maxGapMs, firstMs, spanEndMs);
    }

    const wallLossMm = totals.wallLossMm;
    const remainingAllowanceMm = eq.corrosionAllowanceMm - wallLossMm;
    const allowanceExhausted = wallLossMm >= eq.corrosionAllowanceMm;

    // 裕量已耗尽 → 在区间内解二次方程给出越过报废厚度的准确时刻
    let exhaustedAtMs = null;
    if (allowanceExhausted) {
      exhaustedAtMs = findExhaustionMs(
        readings,
        material,
        maxGapMs,
        firstMs,
        spanEndMs,
        eq.corrosionAllowanceMm
      );
    }

    const prediction = this._predict({
      eq,
      material,
      readings,
      maxGapMs,
      firstMs,
      spanEndMs,
      windowDays,
      allowanceExhausted,
      remainingAllowanceMm,
    });

    return {
      equipment: eq.name,
      materialName: eq.materialName,
      asOf: cutoffMs !== null ? toIso(cutoffMs) : null,
      readingCount: readings.length,
      firstReadingAt: firstMs !== null ? toIso(firstMs) : null,
      lastReadingAt: lastMs !== null ? toIso(lastMs) : null,
      initialThicknessMm: eq.initialThicknessMm,
      corrosionAllowanceMm: eq.corrosionAllowanceMm,
      retirementThicknessMm: eq.retirementThicknessMm,
      maxReadingGapDays: eq.maxReadingGapDays,
      cumulativeWallLossMm: wallLossMm,
      cumulativeMassLossGPerM2: totals.massLossGPerM2,
      remainingThicknessMm: eq.initialThicknessMm - wallLossMm,
      remainingAllowanceMm,
      coveredDays: totals.coveredDays,
      totalSpanDays:
        firstMs !== null && spanEndMs > firstMs
          ? (spanEndMs - firstMs) / MS_PER_DAY
          : 0,
      gaps: totals.gaps,
      allowanceExhausted,
      exhaustedAt: exhaustedAtMs !== null ? toIso(exhaustedAtMs) : null,
      prediction,
    };
  }

  // 剩余寿命 = 剩余裕量 / 窗口内平均深度速率。
  // 窗口平均速率 = 窗口内壁厚损失 / 窗口内实际覆盖天数（缺口不算进分母）；
  // 窗口比已有数据长时只用有数据的部分。速率为零或窗口内没有可积分区间时，
  // 预测字段给空值并附原因，绝不返回 Infinity/NaN。
  _predict({
    eq,
    material,
    readings,
    maxGapMs,
    firstMs,
    spanEndMs,
    windowDays,
    allowanceExhausted,
    remainingAllowanceMm,
  }) {
    const prediction = {
      windowDays,
      windowStart: null,
      coveredDays: 0,
      wallLossMm: 0,
      averageRateMmPerDay: null,
      remainingDays: null,
      expectedExhaustedAt: null,
      reason: null,
    };

    if (allowanceExhausted) {
      prediction.reason = '腐蚀裕量已耗尽，越线时刻见 exhaustedAt';
      return prediction;
    }
    if (readings.length < 2 || spanEndMs <= firstMs) {
      prediction.reason = '可积分的读数区间为空（读数不足两条）';
      return prediction;
    }

    const windowStartMs = Math.max(firstMs, spanEndMs - windowDays * MS_PER_DAY);
    const window = integrateRange(
      readings,
      material,
      maxGapMs,
      windowStartMs,
      spanEndMs
    );
    prediction.windowStart = toIso(windowStartMs);
    prediction.coveredDays = window.coveredDays;
    prediction.wallLossMm = window.wallLossMm;

    if (window.coveredDays <= 0) {
      prediction.reason = '窗口内没有可积分的连续读数区间（全是数据缺口）';
      return prediction;
    }
    const rate = window.wallLossMm / window.coveredDays;
    if (rate <= 0) {
      prediction.reason = '窗口内平均腐蚀速率为零，无法外推剩余寿命';
      return prediction;
    }
    prediction.averageRateMmPerDay = rate;
    prediction.remainingDays = remainingAllowanceMm / rate;
    prediction.expectedExhaustedAt = toIso(
      spanEndMs + prediction.remainingDays * MS_PER_DAY
    );
    return prediction;
  }
}

module.exports = { EquipmentService, DEFAULT_WINDOW_DAYS };

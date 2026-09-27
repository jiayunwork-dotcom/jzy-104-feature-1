'use strict';

// 受监测设备与探头读数的入参拦截：在进入任何积分之前把非法输入挡住，
// 并讲清是哪个字段、哪一条读数（批内下标）、为什么不合法。

const { ValidationError } = require('../errors');
const { assertName, assertPositiveNumber } = require('../validation');

const DEFAULT_MAX_READING_GAP_DAYS = 7;
const DEFAULT_PREDICTION_WINDOW_DAYS = 30;

// 探头厂家两种出数单位：μA/cm² 与 A/m²。1 μA/cm² = 0.01 A/m²。
// 键为声明的单位串（兼容 u/µ/μ 与 ²/2 写法），值为换算除数：
// A/m² = value / divisor。用除法而不是乘 0.01，只有一次舍入。
const UNIT_DIVISORS = new Map([
  ['A/m2', 1],
  ['A/m²', 1],
  ['uA/cm2', 100],
  ['uA/cm²', 100],
  ['µA/cm2', 100],
  ['µA/cm²', 100],
  ['μA/cm2', 100],
  ['μA/cm²', 100],
]);

// 登记受监测设备入参。报废厚度 = 初始壁厚 - 腐蚀裕量。
function validateEquipmentInput(body = {}) {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('body', '必须是 JSON 对象');
  }
  const name = assertName('name', body.name);
  const materialName = assertName('materialName', body.materialName);
  const initialThicknessMm = assertPositiveNumber(
    'initialThicknessMm',
    body.initialThicknessMm
  );
  const corrosionAllowanceMm = assertPositiveNumber(
    'corrosionAllowanceMm',
    body.corrosionAllowanceMm
  );

  let maxReadingGapDays = DEFAULT_MAX_READING_GAP_DAYS;
  if (body.maxReadingGapDays !== undefined && body.maxReadingGapDays !== null) {
    maxReadingGapDays = assertPositiveNumber(
      'maxReadingGapDays',
      body.maxReadingGapDays
    );
  }

  if (corrosionAllowanceMm >= initialThicknessMm) {
    throw new ValidationError(
      'corrosionAllowanceMm',
      '必须小于初始壁厚 initialThicknessMm'
    );
  }

  return {
    name,
    materialName,
    initialThicknessMm,
    corrosionAllowanceMm,
    maxReadingGapDays,
    scrapThicknessMm: initialThicknessMm - corrosionAllowanceMm,
  };
}

function parseTimestampMs(value) {
  if (typeof value !== 'string') return NaN;
  return Date.parse(value);
}

// 解析批量读数：逐条校验格式，不合法的条目连同批内下标收集进 problems，
// 合法的条目规范化为 { index, tMs, ampPerM2 }。本函数不做时间戳冲突检查
// （冲突检查需要设备已有读数，由服务层完成），也不抛错——
// 批量问题要一次列全，由服务层汇总后统一抛 400/409。
function parseReadingsBatch(body = {}) {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('body', '必须是 JSON 对象');
  }
  const list = body.readings;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ValidationError('readings', '必须是非空数组');
  }

  const entries = [];
  const problems = [];
  list.forEach((reading, index) => {
    if (typeof reading !== 'object' || reading === null || Array.isArray(reading)) {
      problems.push({
        index,
        field: 'reading',
        reason: '必须是包含 timestamp、value、unit 的对象',
      });
      return;
    }

    const tMs = parseTimestampMs(reading.timestamp);
    let ok = true;
    if (!Number.isFinite(tMs)) {
      problems.push({
        index,
        field: 'timestamp',
        reason: '必须是可解析的 ISO 8601 时间戳',
      });
      ok = false;
    }

    const value = reading.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push({ index, field: 'value', reason: '必须是有限数值' });
      ok = false;
    } else if (value < 0) {
      problems.push({
        index,
        field: 'value',
        reason: '不能为负数（零表示探头未显示活性腐蚀）',
      });
      ok = false;
    }

    const divisor = UNIT_DIVISORS.get(reading.unit);
    if (divisor === undefined) {
      problems.push({
        index,
        field: 'unit',
        reason: '只认 μA/cm² 与 A/m² 两种单位',
      });
      ok = false;
    }

    if (ok) {
      entries.push({ index, tMs, ampPerM2: value / divisor });
    }
  });

  return { entries, problems };
}

// 状态查询的 query 参数：截止时刻 asOf 与预测窗口 windowDays。
function parseStatusQuery(query = {}) {
  let asOfMs = null;
  if (query.asOf !== undefined && query.asOf !== null) {
    asOfMs = parseTimestampMs(query.asOf);
    if (!Number.isFinite(asOfMs)) {
      throw new ValidationError('asOf', '必须是可解析的 ISO 8601 时间戳');
    }
  }

  let windowDays = DEFAULT_PREDICTION_WINDOW_DAYS;
  if (query.windowDays !== undefined && query.windowDays !== null) {
    const parsed = Number(query.windowDays);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ValidationError('windowDays', '必须是正数（天）');
    }
    windowDays = parsed;
  }

  return { asOfMs, windowDays };
}

module.exports = {
  DEFAULT_MAX_READING_GAP_DAYS,
  DEFAULT_PREDICTION_WINDOW_DAYS,
  validateEquipmentInput,
  parseReadingsBatch,
  parseStatusQuery,
};

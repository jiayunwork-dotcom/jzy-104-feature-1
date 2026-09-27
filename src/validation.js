'use strict';

// 参数合法性拦截，独立于核算逻辑：在进入任何公式之前把非法输入挡住，
// 避免服务算到一半因除零等情况崩掉，并讲清是哪个字段、为什么不合法。

const { ValidationError } = require('./errors');

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertName(field, name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError(field, '必须是非空字符串');
  }
  return name.trim();
}

// 正数（严格大于 0）。
function assertPositiveNumber(field, value) {
  if (!isFiniteNumber(value)) {
    throw new ValidationError(field, '必须是有限数值');
  }
  if (value <= 0) {
    throw new ValidationError(field, '必须为正数（大于 0）');
  }
  return value;
}

// 离子价数必须是正整数（1, 2, 3, ...）。
function assertPositiveInteger(field, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(field, '必须是正整数');
  }
  return value;
}

// 登记/更新材料档入参。
// 接口采用 SI 单位：摩尔质量 kg/mol、密度 kg/m³。
function validateMaterialInput(input = {}) {
  if (typeof input !== 'object' || input === null) {
    throw new ValidationError('body', '必须是 JSON 对象');
  }
  assertName('name', input.name);
  assertPositiveNumber('molarMassKgPerMol', input.molarMassKgPerMol);
  assertPositiveInteger('valence', input.valence);
  assertPositiveNumber('densityKgPerM3', input.densityKgPerM3);

  const material = {
    name: assertName('name', input.name),
    molarMassKgPerMol: assertPositiveNumber(
      'molarMassKgPerMol',
      input.molarMassKgPerMol
    ),
    valence: assertPositiveInteger('valence', input.valence),
    densityKgPerM3: assertPositiveNumber(
      'densityKgPerM3',
      input.densityKgPerM3
    ),
  };
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      throw new ValidationError('description', '必须是字符串');
    }
    material.description = input.description;
  }
  return material;
}

// 核算入参：腐蚀电流密度必须为正（A/m²）。
// 纯物理内核仍可接收 0（此时速率为 0），由单元测试钉住；
// HTTP 边界处 0 与负数一样属于无意义/非法评估条件，提前挡住。
function validateCalculationInput(body = {}) {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('body', '必须是 JSON 对象');
  }
  assertName('materialName', body.materialName);
  assertPositiveNumber('currentDensityAmpPerM2', body.currentDensityAmpPerM2);

  const result = {
    materialName: body.materialName.trim(),
    currentDensityAmpPerM2: body.currentDensityAmpPerM2,
  };

  if (body.areaM2 !== undefined && body.areaM2 !== null) {
    result.areaM2 = assertPositiveNumber('areaM2', body.areaM2);
  }
  if (body.durationDays !== undefined && body.durationDays !== null) {
    result.durationDays = assertPositiveNumber(
      'durationDays',
      body.durationDays
    );
  }

  // 只给时长不给面积无法求“累计质量损失”，属于请求自相矛盾。
  if (result.durationDays !== undefined && result.areaM2 === undefined) {
    throw new ValidationError(
      'durationDays',
      '给出评估时长时必须同时提供受腐蚀面积 areaM2'
    );
  }

  return result;
}

// 探头读数只认这两种单位；1 μA/cm² = 0.01 A/m²。
const READING_UNITS = ['uA/cm2', 'A/m2'];
const UA_PER_CM2_TO_A_PER_M2 = 0.01;

// 受监测设备登记入参：初始壁厚、腐蚀裕量、最长读数间隔都必须是正数，
// 且裕量必须小于初始壁厚；最长间隔不给就按 7 天。
const DEFAULT_MAX_READING_GAP_DAYS = 7;

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
  if (corrosionAllowanceMm >= initialThicknessMm) {
    throw new ValidationError(
      'corrosionAllowanceMm',
      '必须小于初始壁厚 initialThicknessMm'
    );
  }
  let maxReadingGapDays = DEFAULT_MAX_READING_GAP_DAYS;
  if (body.maxReadingGapDays !== undefined && body.maxReadingGapDays !== null) {
    maxReadingGapDays = assertPositiveNumber(
      'maxReadingGapDays',
      body.maxReadingGapDays
    );
  }
  return {
    name,
    materialName,
    initialThicknessMm,
    corrosionAllowanceMm,
    maxReadingGapDays,
  };
}

// ISO 8601 时间戳 → epoch 毫秒；解析不了就拦下。
function parseTimestamp(field, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(field, '必须是 ISO 8601 时间戳字符串');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ValidationError(field, `无法解析的时间戳「${value}」`);
  }
  return ms;
}

// 单条读数：{timestamp, value, unit}。零合法（探头显示没有活性腐蚀），
// 负数、非数值、未知单位、解析不了的时间戳都在此拦下。
function validateReadingEntry(entry) {
  if (typeof entry !== 'object' || entry === null) {
    throw new ValidationError(
      'reading',
      '必须是对象 {timestamp, value, unit}'
    );
  }
  const ms = parseTimestamp('timestamp', entry.timestamp);
  const value = entry.value;
  if (!isFiniteNumber(value)) {
    throw new ValidationError('value', '必须是有限数值');
  }
  if (value < 0) {
    throw new ValidationError('value', '不能为负数（零表示无活性腐蚀）');
  }
  if (!READING_UNITS.includes(entry.unit)) {
    throw new ValidationError(
      'unit',
      `只认 ${READING_UNITS.join(' 与 ')} 两种单位`
    );
  }
  const ampPerM2 =
    entry.unit === 'uA/cm2' ? value * UA_PER_CM2_TO_A_PER_M2 : value;
  return { ms, timestamp: new Date(ms).toISOString(), ampPerM2 };
}

// 批量读数入参：逐条校验并把出问题的条目连同批内下标一次列全，
// 不让调用方改一条交一次。形状不合法（不是数组/为空）直接抛 400；
// 条目级问题收集在返回值里，由路由决定 400 响应（可能还要附上时间戳冲突）。
function parseReadingsPayload(body) {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? body.readings
      : undefined;
  if (!Array.isArray(list)) {
    throw new ValidationError(
      'readings',
      '请求体必须是读数数组，或含 readings 数组的对象'
    );
  }
  if (list.length === 0) {
    throw new ValidationError('readings', '读数数组不能为空');
  }
  const entries = [];
  const errors = [];
  list.forEach((raw, index) => {
    try {
      entries.push({ index, ...validateReadingEntry(raw) });
    } catch (err) {
      if (err instanceof ValidationError) {
        errors.push({ index, field: err.field, reason: err.reason });
      } else {
        throw err;
      }
    }
  });
  return { entries, errors };
}

// 状态查询参数：asOf（截止时刻，可选）与 windowDays（预测窗口，默认 30 天）。
function validateStatusQuery(query = {}) {
  let asOfMs = null;
  if (query.asOf !== undefined && query.asOf !== null && query.asOf !== '') {
    asOfMs = parseTimestamp('asOf', query.asOf);
  }
  let windowDays = 30;
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
  assertName,
  assertPositiveNumber,
  assertPositiveInteger,
  validateMaterialInput,
  validateCalculationInput,
  validateEquipmentInput,
  validateReadingEntry,
  parseReadingsPayload,
  validateStatusQuery,
  READING_UNITS,
  DEFAULT_MAX_READING_GAP_DAYS,
};

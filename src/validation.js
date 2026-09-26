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

module.exports = {
  assertName,
  assertPositiveNumber,
  assertPositiveInteger,
  validateMaterialInput,
  validateCalculationInput,
};

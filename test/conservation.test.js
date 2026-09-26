'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FARADAY_CONSTANT } = require('../src/physics/constants');
const {
  massLossRateKgPerM2S,
  toGramsPerM2Day,
} = require('../src/physics/equivalent');
const {
  penetrationRateMPerS,
  toMmPerYear,
} = require('../src/physics/depth');
const { cumulativeMassLossKg } = require('../src/physics/totals');
const { CorrosionService } = require('../src/corrosion-service');
const { MaterialRepository } = require('../src/materials/repository');
const { IRON_SEAWATER } = require('../src/materials/seed');

const REL_TOL = 1e-12;

function approxEqual(actual, expected, relTol = REL_TOL) {
  assert.ok(
    Math.abs(actual - expected) <= relTol * Math.max(1, Math.abs(expected)),
    `expected ${actual} ≈ ${expected} (relTol=${relTol})`
  );
}

// 纯内核辅助：给定参数直接算质量损失率与深度速率。
function rates({ molarMass, valence, density, currentDensity }) {
  const massRate = massLossRateKgPerM2S(molarMass, currentDensity, valence);
  const penetration = penetrationRateMPerS(massRate, density);
  return { massRate, penetration };
}

const IRON = {
  molarMass: 0.055845, // kg/mol
  valence: 2,
  density: 7870, // kg/m³
};

test('法拉第常数使用准确的公认取值（CODATA 推荐值），而非近似整数', () => {
  approxEqual(FARADAY_CONSTANT, 96485.33212, 1e-12);
  assert.notEqual(FARADAY_CONSTANT, 96500);
});

test('守恒1：腐蚀电流密度取零时，深度速率与质量损失率都必须为零', () => {
  const { massRate, penetration } = rates({ ...IRON, currentDensity: 0 });
  assert.equal(massRate, 0);
  assert.equal(penetration, 0);
  assert.equal(toGramsPerM2Day(massRate), 0);
  assert.equal(toMmPerYear(penetration), 0);
});

test('守恒2：同一材料档下电流密度翻倍，质量损失率与深度速率同步翻倍', () => {
  const one = rates({ ...IRON, currentDensity: 1.0 });
  const two = rates({ ...IRON, currentDensity: 2.0 });
  approxEqual(two.massRate, 2 * one.massRate);
  approxEqual(two.penetration, 2 * one.penetration);
});

test('守恒3：离子价数单独翻倍，同样电流下腐蚀速率减半', () => {
  const z2 = rates({ ...IRON, valence: 2, currentDensity: 1.0 });
  const z4 = rates({ ...IRON, valence: 4, currentDensity: 1.0 });
  approxEqual(z4.massRate, z2.massRate / 2);
  approxEqual(z4.penetration, z2.penetration / 2);
});

test('守恒4：密度单独翻倍，单位面积质量损失率不变而深度速率减半', () => {
  const r1 = rates({ ...IRON, density: 7870, currentDensity: 1.0 });
  const r2 = rates({ ...IRON, density: 7870 * 2, currentDensity: 1.0 });
  approxEqual(r2.massRate, r1.massRate); // 失重率只取决于 M、z、i
  approxEqual(r2.penetration, r1.penetration / 2); // 更致密 → 更薄一层
});

test('守恒5：不同金属档（铁 vs 铝）在相同电流密度下深度速率必须不同', () => {
  const fe = rates({ ...IRON, currentDensity: 1.0 });
  const al = rates({
    molarMass: 0.02698, // 26.98 g/mol
    valence: 3,
    density: 2700, // kg/m³
    currentDensity: 1.0,
  });
  assert.ok(Math.abs(fe.penetration - al.penetration) > 1e-13);
  // 同时给一个量级核对
  approxEqual(toMmPerYear(fe.penetration), 1.1596445147826109);
  approxEqual(toMmPerYear(al.penetration), 1.0886849951730604);
});

test('守恒6：评估时长翻倍，均匀腐蚀下累计失重随之翻倍', () => {
  const area = 3.5; // m²
  const massRate = massLossRateKgPerM2S(IRON.molarMass, 1.0, IRON.valence);
  const oneDay = cumulativeMassLossKg(massRate, area, 1);
  const twoDays = cumulativeMassLossKg(massRate, area, 2);
  approxEqual(twoDays, 2 * oneDay);
  // 面积翻倍也应使总失重翻倍
  const doubleArea = cumulativeMassLossKg(massRate, area * 2, 1);
  approxEqual(doubleArea, 2 * oneDay);
});

test('基准回归：铁-海水档 i=1 A/m²（=100 μA/cm²）的可手算数值', () => {
  const repo = new MaterialRepository();
  repo.register(IRON_SEAWATER);
  const service = new CorrosionService(repo);

  const out = service.calculate({
    materialName: 'iron-seawater',
    currentDensityAmpPerM2: 1,
  });

  assert.equal(out.materialName, 'iron-seawater');
  // 钉死 SI 内核值与工程单位值
  approxEqual(out.rates.massLossKgPerM2S, 2.8939631948690855e-7);
  approxEqual(out.rates.massLossGPerM2Day, 25.0038420036689);
  approxEqual(out.rates.penetrationMPerS, 3.677208633887021e-11);
  approxEqual(out.rates.penetrationMmPerYear, 1.1596445147826109);
});

test('给面积与时长时返回总电流与累计失重，时长翻倍则累计失重翻倍', () => {
  const repo = new MaterialRepository();
  repo.register(IRON_SEAWATER);
  const service = new CorrosionService(repo);

  const one = service.calculate({
    materialName: 'iron-seawater',
    currentDensityAmpPerM2: 1,
    areaM2: 2,
    durationDays: 1,
  });
  const two = service.calculate({
    materialName: 'iron-seawater',
    currentDensityAmpPerM2: 1,
    areaM2: 2,
    durationDays: 2,
  });

  assert.equal(one.totals.totalCurrentAmp, 2); // I = i·A = 1·2
  approxEqual(
    two.totals.cumulativeMassLossKg,
    2 * one.totals.cumulativeMassLossKg
  );
});

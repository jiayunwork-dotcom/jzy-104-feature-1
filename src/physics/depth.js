'use strict';

// 腐蚀深度速率及其单位换算。
// 深度速率 = 单位面积质量损失速率 / 密度（同样的失重铺在更致密的金属上更薄）。
// 内核使用 SI：密度 kg/m³、深度速率 m/s；对外换算为工程常用的 mm/年。

const { SECONDS_PER_YEAR, MM_PER_M } = require('./constants');

// 质量损失速率除以密度，得到穿透（深度）速率，单位 m/s。
function penetrationRateMPerS(massLossRateKgPerM2S, densityKgPerM3) {
  return massLossRateKgPerM2S / densityKgPerM3;
}

// 工程换算：m/s -> mm/年（按 365 天计）。
function toMmPerYear(rateMPerS) {
  return rateMPerS * SECONDS_PER_YEAR * MM_PER_M;
}

module.exports = {
  penetrationRateMPerS,
  toMmPerYear,
};

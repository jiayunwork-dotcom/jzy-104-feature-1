'use strict';

// 电解当量与单位面积质量损失速率（法拉第电解定律）。
// 这一层只做“当量公式”，全部使用 SI 单位：
//   摩尔质量 M：kg/mol
//   电流密度 i：A/m²
//   质量损失速率：kg/(m²·s)

const { FARADAY_CONSTANT, SECONDS_PER_DAY, GRAMS_PER_KG } = require('./constants');

// 电化学当量 M/(z·F)：每库仑电量对应溶解/析出的质量，单位 kg/C。
function electrochemicalEquivalent(molarMassKgPerMol, valence) {
  return molarMassKgPerMol / (valence * FARADAY_CONSTANT);
}

// 单位面积质量损失速率：m_dot/A = M·i/(z·F)，单位 kg/(m²·s)。
function massLossRateKgPerM2S(molarMassKgPerMol, currentDensityAmpPerM2, valence) {
  return (
    (molarMassKgPerMol * currentDensityAmpPerM2) /
    (valence * FARADAY_CONSTANT)
  );
}

// 工程换算：kg/(m²·s) -> g/(m²·天)。
function toGramsPerM2Day(rateKgPerM2S) {
  return rateKgPerM2S * SECONDS_PER_DAY * GRAMS_PER_KG;
}

module.exports = {
  electrochemicalEquivalent,
  massLossRateKgPerM2S,
  toGramsPerM2Day,
};

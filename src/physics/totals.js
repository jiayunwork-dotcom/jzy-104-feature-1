'use strict';

// 给定受腐蚀面积与评估时长后的总量核算：
// 总腐蚀电流与一段时间内的累计质量损失。

const { SECONDS_PER_DAY } = require('./constants');

// 总腐蚀电流 I = i·A，单位 A。
function totalCurrent(currentDensityAmpPerM2, areaM2) {
  return currentDensityAmpPerM2 * areaM2;
}

// 累计质量损失 = 单位面积质量损失速率 × 面积 × 时长（秒），单位 kg。
function cumulativeMassLossKg(massLossRateKgPerM2S, areaM2, durationDays) {
  return (
    massLossRateKgPerM2S * areaM2 * durationDays * SECONDS_PER_DAY
  );
}

module.exports = {
  totalCurrent,
  cumulativeMassLossKg,
};

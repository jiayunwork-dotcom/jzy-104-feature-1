'use strict';

// 核算编排：取出具名材料档，调用物理内核完成速率与总量计算，并完成 SI->工程单位换算。
// 这一层不含 HTTP、不含路由，便于直接对其做守恒关系的自动化测试。

const { massLossRateKgPerM2S, toGramsPerM2Day } = require('./physics/equivalent');
const { penetrationRateMPerS, toMmPerYear } = require('./physics/depth');
const { totalCurrent, cumulativeMassLossKg } = require('./physics/totals');
const { GRAMS_PER_KG } = require('./physics/constants');

class CorrosionService {
  constructor(repository) {
    this.repository = repository;
  }

  calculate(input) {
    // 只从具名档取参，参数严格属于该档，不与其他档混杂。
    const material = this.repository.get(input.materialName);

    const massRateKgM2S = massLossRateKgPerM2S(
      material.molarMassKgPerMol,
      input.currentDensityAmpPerM2,
      material.valence
    );
    const penetrationMS = penetrationRateMPerS(
      massRateKgM2S,
      material.densityKgPerM3
    );

    const result = {
      materialName: material.name,
      input: {
        currentDensityAmpPerM2: input.currentDensityAmpPerM2,
      },
      rates: {
        massLossKgPerM2S: massRateKgM2S,
        massLossGPerM2Day: toGramsPerM2Day(massRateKgM2S),
        penetrationMPerS: penetrationMS,
        penetrationMmPerYear: toMmPerYear(penetrationMS),
      },
    };

    if (input.areaM2 !== undefined) {
      result.input.areaM2 = input.areaM2;
      result.totals = {
        totalCurrentAmp: totalCurrent(
          input.currentDensityAmpPerM2,
          input.areaM2
        ),
      };
    }

    if (input.areaM2 !== undefined && input.durationDays !== undefined) {
      result.input.durationDays = input.durationDays;
      const massKg = cumulativeMassLossKg(
        massRateKgM2S,
        input.areaM2,
        input.durationDays
      );
      result.totals.cumulativeMassLossKg = massKg;
      result.totals.cumulativeMassLossG = massKg * GRAMS_PER_KG;
    }

    return result;
  }
}

module.exports = { CorrosionService };

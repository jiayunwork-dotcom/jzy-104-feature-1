'use strict';

// 预置基准档：铁在海水环境数量级，可手算核对，并钉进回归测试。
// 取工业纯铁（按 Fe²⁺ 溶解）：
//   摩尔质量 55.845 g/mol = 0.055845 kg/mol
//   离子价数 z = 2
//   密度 7.87 g/cm³ = 7870 kg/m³
// 手算基准（i = 1 A/m²，即 100 μA/cm²）：
//   质量损失率 ≈ 25.004 g/(m²·天)
//   深度速率   ≈ 1.1597 mm/年
// 与工程常用系数 3.27×10^-3 · i[μA/cm²] · M/(z·ρ) 同一量级。
const IRON_SEAWATER = {
  name: 'iron-seawater',
  molarMassKgPerMol: 0.055845,
  valence: 2,
  densityKgPerM3: 7870,
  description:
    '预置基准档：工业纯铁按 Fe²⁺ 溶解，海水环境数量级（M=55.845 g/mol, z=2, ρ=7.87 g/cm³）',
};

function seedDefaultMaterials(repository) {
  repository.register(IRON_SEAWATER);
}

module.exports = { IRON_SEAWATER, seedDefaultMaterials };

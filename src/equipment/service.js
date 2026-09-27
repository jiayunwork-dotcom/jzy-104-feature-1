'use strict';

// 受监测设备编排：登记、批量读数入库、状态查询。
// 这一层不含 HTTP；积分物理全部交给 integration.js（复用单点核算内核）。

const { ValidationError, ConflictError, NotFoundError } = require('../errors');
const {
  validateEquipmentInput,
  parseReadingsBatch,
  parseStatusQuery,
} = require('./validation');
const { computeStatus } = require('./integration');

function toIso(ms) {
  return new Date(ms).toISOString();
}

// 设备对外视图（不含读数明细）。
function toEquipmentView(equipment) {
  let firstMs = null;
  let lastMs = null;
  for (const reading of equipment.readings.values()) {
    if (firstMs === null || reading.t < firstMs) firstMs = reading.t;
    if (lastMs === null || reading.t > lastMs) lastMs = reading.t;
  }
  return {
    name: equipment.name,
    materialName: equipment.materialName,
    initialThicknessMm: equipment.initialThicknessMm,
    corrosionAllowanceMm: equipment.corrosionAllowanceMm,
    scrapThicknessMm: equipment.scrapThicknessMm,
    maxReadingGapDays: equipment.maxReadingGapDays,
    readingCount: equipment.readings.size,
    firstReadingAt: firstMs === null ? null : toIso(firstMs),
    lastReadingAt: lastMs === null ? null : toIso(lastMs),
  };
}

class EquipmentService {
  constructor(equipmentRepository, materialRepository) {
    this.equipmentRepository = equipmentRepository;
    this.materialRepository = materialRepository;
  }

  registerEquipment(body) {
    const input = validateEquipmentInput(body);
    // 材料档必须已登记（404）；设备名不得重复（409）。
    this.materialRepository.get(input.materialName);
    return toEquipmentView(this.equipmentRepository.register(input));
  }

  getEquipment(name) {
    return toEquipmentView(this.equipmentRepository.get(name));
  }

  listEquipment() {
    const views = this.equipmentRepository.list().map(toEquipmentView);
    return { count: views.length, equipment: views };
  }

  // 批量读数入库。整批先校验后落库：任何一条出问题，整批都不入库，
  // 响应一次列全所有问题条目（含批内下标）。
  // 格式不合法 → 400；全部合法仅时间戳冲突 → 409。
  addReadings(name, body) {
    const equipment = this.equipmentRepository.get(name); // 404
    const { entries, problems } = parseReadingsBatch(body);

    // 时间戳冲突检查：既查设备已有读数，也查本批内部自相重复。
    const conflicts = [];
    const seenInBatch = new Map(); // tMs -> 首次出现的批内下标
    for (const entry of entries) {
      const iso = toIso(entry.tMs);
      if (equipment.readings.has(entry.tMs)) {
        conflicts.push({
          index: entry.index,
          field: 'timestamp',
          timestamp: iso,
          reason: `时间戳 ${iso} 与该设备已有读数冲突`,
        });
      } else if (seenInBatch.has(entry.tMs)) {
        conflicts.push({
          index: entry.index,
          field: 'timestamp',
          timestamp: iso,
          reason: `时间戳 ${iso} 与本批第 ${seenInBatch.get(entry.tMs)} 条重复`,
        });
      } else {
        seenInBatch.set(entry.tMs, entry.index);
      }
    }

    if (problems.length > 0 || conflicts.length > 0) {
      const all = [...problems, ...conflicts].sort((a, b) => a.index - b.index);
      const error =
        problems.length > 0
          ? new ValidationError(
              'readings',
              `批量提交中有 ${all.length} 处问题，整批未入库`
            )
          : new ConflictError(
              'timestamp',
              `批量提交中有 ${all.length} 个时间戳冲突，整批未入库`
            );
      error.problems = all;
      throw error;
    }

    // 校验与落库之间没有任何 await：Node 单线程模型下这段是原子的，
    // 并发请求同一台设备也不会丢读数或放过重复时间戳。
    for (const entry of entries) {
      equipment.readings.set(entry.tMs, { t: entry.tMs, i: entry.ampPerM2 });
    }
    return {
      equipment: equipment.name,
      accepted: entries.length,
      readingCount: equipment.readings.size,
    };
  }

  getStatus(name, query) {
    const equipment = this.equipmentRepository.get(name); // 404
    const { asOfMs, windowDays } = parseStatusQuery(query);
    const material = this.materialRepository.get(equipment.materialName);

    const sortedReadings = [...equipment.readings.values()].sort(
      (a, b) => a.t - b.t
    );
    const status = computeStatus({
      equipment,
      material,
      sortedReadings,
      asOfMs,
      windowDays,
    });

    return {
      ...toEquipmentView(equipment),
      asOf: status.asOfMs === null ? null : toIso(status.asOfMs),
      cumulativeThicknessLossMm: status.cumulativeThicknessLossMm,
      cumulativeMassLossGPerM2: status.cumulativeMassLossGPerM2,
      remainingThicknessMm: status.remainingThicknessMm,
      remainingAllowanceMm: status.remainingAllowanceMm,
      coverage: status.coverage,
      allowanceExhausted: status.allowanceExhausted,
      exceededScrapAt: status.exceededScrapAt,
      prediction: status.prediction,
    };
  }
}

module.exports = { EquipmentService, toEquipmentView };

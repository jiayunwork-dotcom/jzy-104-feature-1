'use strict';

// 受监测设备与其读数的进程内存存取。
// 与材料档一样只活在进程内存里，重启后由调用方重新登记。
// 读数按「epoch 毫秒 → 电流密度（A/m²，已换算）」存放；
// 冲突检查与落库在同一个同步方法内完成（Node 单线程，中途不让出事件循环），
// 因此并发请求要么整批成功要么整批拒绝，不会丢读数也不会冒出重复时间戳。

const { ConflictError, NotFoundError } = require('../errors');

function summarize(eq) {
  const timestamps = [...eq.readings.keys()];
  return {
    name: eq.name,
    materialName: eq.materialName,
    initialThicknessMm: eq.initialThicknessMm,
    corrosionAllowanceMm: eq.corrosionAllowanceMm,
    retirementThicknessMm: eq.retirementThicknessMm,
    maxReadingGapDays: eq.maxReadingGapDays,
    readingCount: eq.readings.size,
    firstReadingAt:
      timestamps.length > 0
        ? new Date(Math.min(...timestamps)).toISOString()
        : null,
    lastReadingAt:
      timestamps.length > 0
        ? new Date(Math.max(...timestamps)).toISOString()
        : null,
  };
}

class EquipmentRepository {
  constructor() {
    this._equipment = new Map();
  }

  register(equipment) {
    if (this._equipment.has(equipment.name)) {
      throw new ConflictError(
        'name',
        `受监测设备「${equipment.name}」已存在，不能重复登记`
      );
    }
    this._equipment.set(equipment.name, {
      ...equipment,
      // 报废厚度 = 初始壁厚 − 腐蚀裕量
      retirementThicknessMm:
        equipment.initialThicknessMm - equipment.corrosionAllowanceMm,
      readings: new Map(),
    });
    return this.get(equipment.name);
  }

  // 内部引用（含读数表），仅供服务层使用，不外泄。
  getRef(name) {
    const eq = this._equipment.get(name);
    if (!eq) {
      throw new NotFoundError(
        'equipment',
        `受监测设备「${name}」尚未登记，请先登记`
      );
    }
    return eq;
  }

  get(name) {
    return summarize(this.getRef(name));
  }

  list() {
    return [...this._equipment.values()].map(summarize);
  }

  // 纯检查：批内自撞 + 与已存读数冲突，逐条列出（含批内下标），不改任何状态。
  findConflicts(name, entries) {
    const eq = this.getRef(name);
    const conflicts = [];
    const seenInBatch = new Map();
    entries.forEach((entry, position) => {
      // 条目自带它在原始批次里的下标（非法条目被剔除后仍指向原位置）
      const index = entry.index !== undefined ? entry.index : position;
      const firstIndex = seenInBatch.get(entry.ms);
      if (firstIndex !== undefined) {
        conflicts.push({
          index,
          timestamp: entry.timestamp,
          reason: `与本批第 ${firstIndex} 条读数时间戳相同`,
        });
      } else if (eq.readings.has(entry.ms)) {
        conflicts.push({
          index,
          timestamp: entry.timestamp,
          reason: '该时间戳已存在读数，拒绝覆盖',
        });
      } else {
        seenInBatch.set(entry.ms, index);
      }
    });
    return conflicts;
  }

  // 整批落库：先查冲突，全部干净才一次性写入；任一冲突则整批拒绝（409）。
  addReadings(name, entries) {
    const conflicts = this.findConflicts(name, entries);
    if (conflicts.length > 0) {
      const error = new ConflictError(
        'readings',
        `有 ${conflicts.length} 条读数时间戳冲突，整批未入库`
      );
      error.details = { conflicts };
      throw error;
    }
    const eq = this.getRef(name);
    for (const entry of entries) {
      eq.readings.set(entry.ms, entry.ampPerM2);
    }
    return { inserted: entries.length, readingCount: eq.readings.size };
  }
}

module.exports = { EquipmentRepository };

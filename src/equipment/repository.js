'use strict';

// 受监测设备在进程内的登记与取用。
// 与材料档一样只活在进程内存中：重启后由调用方重新登记即可。
// 读数直接挂在设备对象上（Map：时间戳毫秒 -> 读数），
// 校验与写入在同一个同步代码段内完成，Node 单线程模型下
// 并发请求不会交错，因此不会丢读数、也不会冒出重复时间戳。

const { ConflictError, NotFoundError } = require('../errors');

class EquipmentRepository {
  constructor() {
    this._equipment = new Map();
  }

  register(equipment) {
    if (this._equipment.has(equipment.name)) {
      throw new ConflictError(
        'name',
        `受监测设备「${equipment.name}」已登记，不能重复登记`
      );
    }
    this._equipment.set(equipment.name, {
      ...equipment,
      readings: new Map(),
    });
    return this.get(equipment.name);
  }

  get(name) {
    const equipment = this._equipment.get(name);
    if (!equipment) {
      throw new NotFoundError(
        'equipmentName',
        `受监测设备「${name}」尚未登记，请先登记后再操作`
      );
    }
    return equipment;
  }

  has(name) {
    return this._equipment.has(name);
  }

  list() {
    return [...this._equipment.values()];
  }

  clear() {
    this._equipment.clear();
  }
}

module.exports = { EquipmentRepository };

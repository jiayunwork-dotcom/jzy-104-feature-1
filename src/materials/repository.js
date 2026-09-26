'use strict';

// 材料档在进程内的登记、按名取用与清单列表。
// 只活在进程内存中：重启后由调用方（含预置档）重新登记即可；
// 运行期间所有读写都经过这一层，保证各档的 M、z、ρ 彼此隔离、不会串档。

const { ConflictError, NotFoundError } = require('../errors');

class MaterialRepository {
  constructor() {
    this._materials = new Map();
  }

  register(material) {
    if (this._materials.has(material.name)) {
      throw new ConflictError(
        'name',
        `材料档「${material.name}」已存在，不能重复登记`
      );
    }
    this._materials.set(material.name, { ...material });
    return this.get(material.name);
  }

  get(name) {
    const material = this._materials.get(name);
    if (!material) {
      throw new NotFoundError(
        'materialName',
        `材料档「${name}」尚未登记，请先登记后再核算`
      );
    }
    // 返回副本，避免外部改动污染库内数据。
    return { ...material };
  }

  list() {
    return [...this._materials.values()].map((material) => ({ ...material }));
  }

  has(name) {
    return this._materials.has(name);
  }

  clear() {
    this._materials.clear();
  }
}

module.exports = { MaterialRepository };

'use strict';

// 受监测设备的边界与错误处理：登记校验、读数校验、查询参数、
// 剩余寿命预测的退化情形、并发写入的原子性。

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApp } = require('../src/app');

const DAY_MS = 86400 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const day = (d) => new Date(T0 + d * DAY_MS).toISOString();

const REL_TOL = 1e-9;
function approxEqual(actual, expected, relTol = REL_TOL) {
  assert.ok(
    Math.abs(actual - expected) <= relTol * Math.max(1, Math.abs(expected)),
    `expected ${actual} ≈ ${expected} (relTol=${relTol})`
  );
}

async function withApp(run) {
  const app = buildApp({ logger: false });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

function equipmentPayload(overrides = {}) {
  return {
    name: 'eq-1',
    materialName: 'iron-seawater',
    initialThicknessMm: 10,
    corrosionAllowanceMm: 3,
    ...overrides,
  };
}

async function register(app, overrides = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/equipment',
    payload: equipmentPayload(overrides),
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

async function postReadings(app, name, readings) {
  return app.inject({
    method: 'POST',
    url: `/equipment/${name}/readings`,
    payload: { readings },
  });
}

async function getStatus(app, name, qs = '') {
  return app.inject({ method: 'GET', url: `/equipment/${name}/status${qs}` });
}

test('登记成功：默认最长间隔 7 天，报废厚度 = 初始壁厚 − 裕量', async () => {
  await withApp(async (app) => {
    const created = await register(app);
    assert.equal(created.maxReadingGapDays, 7);
    assert.equal(created.retirementThicknessMm, 7);
    assert.equal(created.readingCount, 0);

    const fetched = await app.inject({ method: 'GET', url: '/equipment/eq-1' });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().name, 'eq-1');

    const list = await app.inject({ method: 'GET', url: '/equipment' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().count, 1);
  });
});

test('登记校验：材料档不存在 404；壁厚/裕量/间隔不合法 400 并点名字段；重名 409', async () => {
  await withApp(async (app) => {
    const ghost = await app.inject({
      method: 'POST',
      url: '/equipment',
      payload: equipmentPayload({ materialName: 'ghost' }),
    });
    assert.equal(ghost.statusCode, 404);
    assert.equal(ghost.json().field, 'materialName');

    const badCases = [
      [{ initialThicknessMm: 0 }, 'initialThicknessMm'],
      [{ initialThicknessMm: -5 }, 'initialThicknessMm'],
      [{ initialThicknessMm: '10' }, 'initialThicknessMm'],
      [{ corrosionAllowanceMm: 0 }, 'corrosionAllowanceMm'],
      [{ corrosionAllowanceMm: -1 }, 'corrosionAllowanceMm'],
      [{ corrosionAllowanceMm: 10 }, 'corrosionAllowanceMm'], // 等于初始壁厚
      [{ corrosionAllowanceMm: 12 }, 'corrosionAllowanceMm'], // 大于初始壁厚
      [{ maxReadingGapDays: 0 }, 'maxReadingGapDays'],
      [{ maxReadingGapDays: -2 }, 'maxReadingGapDays'],
      [{ name: '' }, 'name'],
    ];
    for (const [overrides, field] of badCases) {
      const res = await app.inject({
        method: 'POST',
        url: '/equipment',
        payload: equipmentPayload(overrides),
      });
      assert.equal(res.statusCode, 400, JSON.stringify(overrides));
      assert.equal(res.json().field, field, JSON.stringify(overrides));
    }

    await register(app);
    const dup = await app.inject({
      method: 'POST',
      url: '/equipment',
      payload: equipmentPayload(),
    });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().field, 'name');
  });
});

test('读数校验：零合法；负值、非数值、未知单位、坏时间戳都 400 并点名字段', async () => {
  await withApp(async (app) => {
    await register(app);

    const zero = await postReadings(app, 'eq-1', [
      { timestamp: day(0), value: 0, unit: 'A/m2' },
    ]);
    assert.equal(zero.statusCode, 201, zero.body);

    const badEntries = [
      [{ timestamp: day(1), value: -1, unit: 'A/m2' }, 'value'],
      [{ timestamp: day(1), value: '1', unit: 'A/m2' }, 'value'],
      [{ timestamp: day(1), value: NaN, unit: 'A/m2' }, 'value'],
      [{ timestamp: day(1), value: 1, unit: 'mA/m2' }, 'unit'],
      [{ timestamp: day(1), value: 1 }, 'unit'],
      [{ timestamp: '2026-13-40', value: 1, unit: 'A/m2' }, 'timestamp'],
      [{ value: 1, unit: 'A/m2' }, 'timestamp'],
    ];
    for (const [entry, field] of badEntries) {
      const res = await postReadings(app, 'eq-1', [entry]);
      assert.equal(res.statusCode, 400, JSON.stringify(entry));
      assert.equal(res.json().errors[0].field, field, JSON.stringify(entry));
      assert.equal(res.json().errors[0].index, 0);
    }

    // 空批与错误形状
    const empty = await postReadings(app, 'eq-1', []);
    assert.equal(empty.statusCode, 400);
    const noList = await app.inject({
      method: 'POST',
      url: '/equipment/eq-1/readings',
      payload: { hello: 'world' },
    });
    assert.equal(noList.statusCode, 400);

    // 只有最初那条零值读数入库
    const eq = await app.inject({ method: 'GET', url: '/equipment/eq-1' });
    assert.equal(eq.json().readingCount, 1);
  });
});

test('未登记设备：取档、交读数、查状态都 404', async () => {
  await withApp(async (app) => {
    const get = await app.inject({ method: 'GET', url: '/equipment/ghost' });
    assert.equal(get.statusCode, 404);

    const post = await postReadings(app, 'ghost', [
      { timestamp: day(0), value: 1, unit: 'A/m2' },
    ]);
    assert.equal(post.statusCode, 404);

    const status = await getStatus(app, 'ghost');
    assert.equal(status.statusCode, 404);
  });
});

test('状态查询参数：坏 asOf / 坏 windowDays 返回 400 并点名字段', async () => {
  await withApp(async (app) => {
    await register(app);
    const badAsOf = await getStatus(app, 'eq-1', '?asOf=bogus');
    assert.equal(badAsOf.statusCode, 400);
    assert.equal(badAsOf.json().field, 'asOf');

    for (const w of ['abc', '-3', '0']) {
      const res = await getStatus(app, 'eq-1', `?windowDays=${w}`);
      assert.equal(res.statusCode, 400, `windowDays=${w}`);
      assert.equal(res.json().field, 'windowDays');
    }
  });
});

test('剩余寿命预测：恒定电流下预计耗尽时刻与解析解一致，窗口参数生效', async () => {
  await withApp(async (app) => {
    await register(app);
    await postReadings(
      app,
      'eq-1',
      Array.from({ length: 11 }, (_, d) => ({
        timestamp: day(d),
        value: 1,
        unit: 'A/m2',
      }))
    );

    const calc = await app.inject({
      method: 'POST',
      url: '/corrosion/calculate',
      payload: { materialName: 'iron-seawater', currentDensityAmpPerM2: 1 },
    });
    const k = calc.json().rates.penetrationMmPerYear / 365; // mm/天

    for (const qs of ['', '?windowDays=5', '?windowDays=365']) {
      const res = await getStatus(app, 'eq-1', qs);
      assert.equal(res.statusCode, 200);
      const p = res.json().prediction;
      assert.equal(p.reason, null);
      approxEqual(p.averageRateMmPerDay, k);
      approxEqual(p.remainingDays, (3 - k * 10) / k);
      // 恒定电流下预计耗尽时刻距起点 = 裕量 / 日速率，与窗口长短无关
      const expectedDays = (Date.parse(p.expectedExhaustedAt) - T0) / DAY_MS;
      approxEqual(expectedDays, 3 / k);
    }

    // 窗口比数据短：只用窗口内部分
    const res = await getStatus(app, 'eq-1', '?windowDays=4');
    const p = res.json().prediction;
    approxEqual(p.coveredDays, 4);
    approxEqual(p.wallLossMm, k * 4);
  });
});

test('预测退化情形：零速率、窗口内全是缺口、读数不足都给空值与原因，不抛 500', async () => {
  await withApp(async (app) => {
    // 全程零电流
    await register(app, { name: 'zero' });
    await postReadings(app, 'zero', [
      { timestamp: day(0), value: 0, unit: 'uA/cm2' },
      { timestamp: day(5), value: 0, unit: 'uA/cm2' },
    ]);
    const zero = (await getStatus(app, 'zero')).json();
    assert.equal(zero.cumulativeWallLossMm, 0);
    assert.equal(zero.allowanceExhausted, false);
    assert.equal(zero.prediction.averageRateMmPerDay, null);
    assert.equal(zero.prediction.remainingDays, null);
    assert.equal(zero.prediction.expectedExhaustedAt, null);
    assert.ok(zero.prediction.reason.length > 0);

    // 窗口内只有缺口（两条读数隔 10 天 > 默认 7 天，窗口 5 天落在缺口里）
    await register(app, { name: 'gap-only' });
    await postReadings(app, 'gap-only', [
      { timestamp: day(0), value: 1, unit: 'A/m2' },
      { timestamp: day(10), value: 1, unit: 'A/m2' },
    ]);
    const gapOnly = (await getStatus(app, 'gap-only', '?windowDays=5')).json();
    assert.equal(gapOnly.prediction.coveredDays, 0);
    assert.equal(gapOnly.prediction.remainingDays, null);
    assert.ok(gapOnly.prediction.reason.length > 0);

    // 只有一条读数
    await register(app, { name: 'single' });
    await postReadings(app, 'single', [
      { timestamp: day(0), value: 1, unit: 'A/m2' },
    ]);
    const single = (await getStatus(app, 'single')).json();
    assert.equal(single.cumulativeWallLossMm, 0);
    assert.equal(single.coveredDays, 0);
    assert.equal(single.prediction.remainingDays, null);
    assert.ok(single.prediction.reason.length > 0);

    // 完全没有读数
    await register(app, { name: 'empty' });
    const empty = (await getStatus(app, 'empty')).json();
    assert.equal(empty.asOf, null);
    assert.equal(empty.readingCount, 0);
    assert.equal(empty.cumulativeWallLossMm, 0);
    assert.equal(empty.remainingThicknessMm, 10);
    assert.equal(empty.remainingAllowanceMm, 3);
    assert.equal(empty.prediction.remainingDays, null);
    assert.ok(empty.prediction.reason.length > 0);
  });
});

test('裕量耗尽：给出越线时刻，预测字段附原因', async () => {
  await withApp(async (app) => {
    await register(app, { maxReadingGapDays: 5000 });
    await postReadings(app, 'eq-1', [
      { timestamp: day(0), value: 1, unit: 'A/m2' },
      { timestamp: day(2000), value: 1, unit: 'A/m2' },
    ]);
    const s = (await getStatus(app, 'eq-1')).json();
    assert.equal(s.allowanceExhausted, true);
    assert.equal(typeof s.exhaustedAt, 'string');
    assert.ok(Date.parse(s.exhaustedAt) > T0);
    assert.ok(s.remainingAllowanceMm <= 0);
    assert.equal(s.prediction.remainingDays, null);
    assert.equal(s.prediction.expectedExhaustedAt, null);
    assert.ok(s.prediction.reason.length > 0);
  });
});

test('并发写入：两批时间戳重叠的读数同时提交，恰有一批成功，不丢读数不出重复', async () => {
  await withApp(async (app) => {
    await register(app);
    const batchA = [1, 2, 3].map((d) => ({
      timestamp: day(d),
      value: 1,
      unit: 'A/m2',
    }));
    const batchB = [2, 3, 4].map((d) => ({
      timestamp: day(d),
      value: 2,
      unit: 'A/m2',
    }));
    const [ra, rb] = await Promise.all([
      postReadings(app, 'eq-1', batchA),
      postReadings(app, 'eq-1', batchB),
    ]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    assert.deepEqual(codes, [201, 409]);

    // 再并发补几批互不重叠的，全部成功且读数不丢
    const more = await Promise.all(
      [10, 20, 30].map((base) =>
        postReadings(
          app,
          'eq-1',
          [0, 1, 2].map((o) => ({
            timestamp: day(base + o),
            value: 1,
            unit: 'A/m2',
          }))
        )
      )
    );
    assert.ok(more.every((r) => r.statusCode === 201));

    const eq = await app.inject({ method: 'GET', url: '/equipment/eq-1' });
    assert.equal(eq.json().readingCount, 3 + 9);
  });
});

test('分批补传与乱序到：读数累计入档，条数与时间戳集合正确', async () => {
  await withApp(async (app) => {
    await register(app);
    const r1 = await postReadings(app, 'eq-1', [
      { timestamp: day(5), value: 1, unit: 'A/m2' },
      { timestamp: day(1), value: 1, unit: 'A/m2' },
    ]);
    assert.equal(r1.statusCode, 201);
    assert.equal(r1.json().inserted, 2);
    assert.equal(r1.json().readingCount, 2);

    const r2 = await postReadings(app, 'eq-1', [
      { timestamp: day(3), value: 1, unit: 'A/m2' },
    ]);
    assert.equal(r2.json().readingCount, 3);

    const eq = await app.inject({ method: 'GET', url: '/equipment/eq-1' });
    assert.equal(eq.json().firstReadingAt, day(1));
    assert.equal(eq.json().lastReadingAt, day(5));
  });
});

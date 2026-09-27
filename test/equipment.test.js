'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApp } = require('../src/app');

const REL_TOL = 1e-9;
const DAY_MS = 86400000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

const iso = (ms) => new Date(ms).toISOString();

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

let seq = 0;
function uniqueName(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

async function registerEquipment(app, overrides = {}) {
  const body = {
    name: uniqueName('eq'),
    materialName: 'iron-seawater',
    initialThicknessMm: 10,
    corrosionAllowanceMm: 3,
    ...overrides,
  };
  const res = await app.inject({ method: 'POST', url: '/equipment', payload: body });
  assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
  return body.name;
}

async function postReadings(app, name, readings, expectStatus = 201) {
  const res = await app.inject({
    method: 'POST',
    url: `/equipment/${name}/readings`,
    payload: { readings },
  });
  assert.equal(res.statusCode, expectStatus, JSON.stringify(res.json()));
  return res;
}

async function getStatus(app, name, query = {}) {
  const params = new URLSearchParams();
  if (query.asOf !== undefined) params.set('asOf', query.asOf);
  if (query.windowDays !== undefined) params.set('windowDays', String(query.windowDays));
  const qs = params.toString();
  const res = await app.inject({
    method: 'GET',
    url: `/equipment/${name}/status${qs ? `?${qs}` : ''}`,
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  return res.json();
}

// 单点核算给出的铁档基准速率（1 A/m²）
async function ironRates(app) {
  const res = await app.inject({
    method: 'POST',
    url: '/corrosion/calculate',
    payload: { materialName: 'iron-seawater', currentDensityAmpPerM2: 1 },
  });
  assert.equal(res.statusCode, 200);
  return res.json().rates;
}

// 关系 1：恒定 1 A/m² 覆盖 D 天，累计失重 = 日质量损失率 × D，
// 累计壁厚损失 = 年深度速率折日速率 × D
test('关系1：恒定电流下累计量等于单点日速率乘以天数', async () => {
  await withApp(async (app) => {
    const D = 10;
    const name = await registerEquipment(app);
    const readings = [];
    for (let k = 0; k <= D; k += 1) {
      readings.push({ timestamp: iso(T0 + k * DAY_MS), value: 1, unit: 'A/m2' });
    }
    await postReadings(app, name, readings);

    const rates = await ironRates(app);
    const status = await getStatus(app, name);

    approxEqual(status.cumulativeMassLossGPerM2, rates.massLossGPerM2Day * D);
    approxEqual(
      status.cumulativeThicknessLossMm,
      (rates.penetrationMmPerYear / 365) * D
    );
    assert.equal(status.coverage.coveredDays, D);
    assert.equal(status.coverage.totalSpanDays, D);
    assert.deepEqual(status.coverage.gaps, []);
  });
});

// 关系 2：线性区间正中间插一条恰等于插值的读数，累计量不变
test('关系2：线性区间中点插入插值读数不改变累计量', async () => {
  await withApp(async (app) => {
    const name = await registerEquipment(app);
    // i(t) = 0.5 + 0.25·t天：t0 → 0.5，t0+2d → 1.0，t0+4d → 1.5
    await postReadings(app, name, [
      { timestamp: iso(T0), value: 0.5, unit: 'A/m2' },
      { timestamp: iso(T0 + 4 * DAY_MS), value: 1.5, unit: 'A/m2' },
    ]);
    const before = await getStatus(app, name);

    // 补传中点（乱序补传），值恰为线性插值 1.0
    await postReadings(app, name, [
      { timestamp: iso(T0 + 2 * DAY_MS), value: 1.0, unit: 'A/m2' },
    ]);
    const after = await getStatus(app, name);

    approxEqual(after.cumulativeThicknessLossMm, before.cumulativeThicknessLossMm);
    approxEqual(after.cumulativeMassLossGPerM2, before.cumulativeMassLossGPerM2);
    approxEqual(after.remainingThicknessMm, before.remainingThicknessMm);
    approxEqual(after.remainingAllowanceMm, before.remainingAllowanceMm);
    assert.equal(after.coverage.coveredDays, before.coverage.coveredDays);
    assert.equal(after.coverage.totalSpanDays, before.coverage.totalSpanDays);
  });
});

// 关系 3：同一组读数任意打乱、任意分批，结果逐字段相同
test('关系3：乱序分批提交，状态逐字段相同', async () => {
  await withApp(async (app) => {
    const base = [];
    for (let k = 0; k < 12; k += 1) {
      base.push({
        timestamp: iso(T0 + k * 0.75 * DAY_MS),
        value: 0.5 + 0.1 * k,
        unit: 'A/m2',
      });
    }

    const nameA = await registerEquipment(app);
    await postReadings(app, nameA, base);

    // 固定置换打乱，分三批
    const nameB = await registerEquipment(app);
    const perm = [5, 1, 9, 0, 7, 3, 11, 2, 8, 4, 10, 6].map((k) => base[k]);
    await postReadings(app, nameB, perm.slice(0, 4));
    await postReadings(app, nameB, perm.slice(4, 8));
    await postReadings(app, nameB, perm.slice(8));

    // 倒序，分两批
    const nameC = await registerEquipment(app);
    const reversed = [...base].reverse();
    await postReadings(app, nameC, reversed.slice(0, 7));
    await postReadings(app, nameC, reversed.slice(7));

    const [sa, sb, sc] = await Promise.all([
      getStatus(app, nameA),
      getStatus(app, nameB),
      getStatus(app, nameC),
    ]);
    for (const s of [sa, sb, sc]) delete s.name;
    assert.deepEqual(sb, sa);
    assert.deepEqual(sc, sa);
  });
});

// 关系 4：0 → i 线性上升的一段，累计量恰为全程恒 i 的一半
test('关系4：线性上升段的累计量是恒定电流的一半', async () => {
  await withApp(async (app) => {
    const spanMs = 8 * DAY_MS;
    const ramp = await registerEquipment(app);
    await postReadings(app, ramp, [
      { timestamp: iso(T0), value: 0, unit: 'A/m2' },
      { timestamp: iso(T0 + spanMs), value: 1.5, unit: 'A/m2' },
    ]);

    const constant = await registerEquipment(app);
    await postReadings(app, constant, [
      { timestamp: iso(T0), value: 1.5, unit: 'A/m2' },
      { timestamp: iso(T0 + spanMs), value: 1.5, unit: 'A/m2' },
    ]);

    const sr = await getStatus(app, ramp);
    const sc = await getStatus(app, constant);
    approxEqual(sr.cumulativeThicknessLossMm, sc.cumulativeThicknessLossMm / 2);
    approxEqual(sr.cumulativeMassLossGPerM2, sc.cumulativeMassLossGPerM2 / 2);
  });
});

// 关系 5：截止时刻后推累计量单调不减；取末读数时刻与不带截止相同
test('关系5：截止时刻单调性与末读数等价', async () => {
  await withApp(async (app) => {
    const name = await registerEquipment(app);
    const readings = [];
    for (let k = 0; k <= 10; k += 1) {
      readings.push({
        timestamp: iso(T0 + k * DAY_MS),
        value: 0.5 + 0.05 * k,
        unit: 'A/m2',
      });
    }
    await postReadings(app, name, readings);

    let prev = -Infinity;
    for (let k = 0; k <= 22; k += 1) {
      const status = await getStatus(app, name, {
        asOf: iso(T0 + k * 0.5 * DAY_MS),
      });
      assert.ok(
        status.cumulativeThicknessLossMm >= prev,
        `step ${k}: ${status.cumulativeThicknessLossMm} >= ${prev}`
      );
      prev = status.cumulativeThicknessLossMm;
    }

    const atLast = await getStatus(app, name, { asOf: iso(T0 + 10 * DAY_MS) });
    const fallback = await getStatus(app, name);
    assert.deepEqual(atLast, fallback);
  });
});

// 关系 6：恒定电流越线时刻 = 裕量 / 日深度速率；
// 线性上升区间越线时刻回查，累计壁厚损失恰等于裕量
test('关系6：越线时刻（恒定电流解析解 + 线性区间二次方程）', async () => {
  await withApp(async (app) => {
    const allowance = 3;
    const rates = await ironRates(app);
    const dailyDepthMm = rates.penetrationMmPerYear / 365;

    // 恒定 1 A/m²，每 30 天一条，覆盖 990 天
    const nameC = await registerEquipment(app, {
      corrosionAllowanceMm: allowance,
      maxReadingGapDays: 40,
    });
    const readings = [];
    for (let k = 0; k <= 33; k += 1) {
      readings.push({
        timestamp: iso(T0 + k * 30 * DAY_MS),
        value: 1,
        unit: 'A/m2',
      });
    }
    await postReadings(app, nameC, readings);
    const sc = await getStatus(app, nameC);
    assert.equal(sc.allowanceExhausted, true);
    assert.equal(sc.prediction, null);
    const daysC = (Date.parse(sc.exceededScrapAt) - T0) / DAY_MS;
    approxEqual(daysC, allowance / dailyDepthMm);

    // 0 → 2 A/m² 线性上升，单段 1000 天（最长间隔需覆盖整段）
    const nameR = await registerEquipment(app, {
      corrosionAllowanceMm: allowance,
      maxReadingGapDays: 1500,
    });
    await postReadings(app, nameR, [
      { timestamp: iso(T0), value: 0, unit: 'A/m2' },
      { timestamp: iso(T0 + 1000 * DAY_MS), value: 2, unit: 'A/m2' },
    ]);
    const sr = await getStatus(app, nameR);
    assert.equal(sr.allowanceExhausted, true);
    const crossedMs = Date.parse(sr.exceededScrapAt);
    assert.ok(crossedMs > T0 && crossedMs < T0 + 1000 * DAY_MS);

    // 把求出的越线时刻作为截止时刻再查：累计壁厚损失 = 裕量
    const followUp = await getStatus(app, nameR, { asOf: sr.exceededScrapAt });
    approxEqual(followUp.cumulativeThicknessLossMm, allowance);
  });
});

// 关系 7：同一组数据分别按 μA/cm² 与 A/m² 提交，结果一致
test('关系7：μA/cm² 与 A/m² 两种单位结果一致', async () => {
  await withApp(async (app) => {
    const offsetsDays = [0, 1, 2.5, 5, 9];
    const micro = [100, 0, 250, 75, 10]; // μA/cm²

    const nameU = await registerEquipment(app);
    await postReadings(
      app,
      nameU,
      offsetsDays.map((d, k) => ({
        timestamp: iso(T0 + d * DAY_MS),
        value: micro[k],
        unit: 'μA/cm²',
      }))
    );

    const nameA = await registerEquipment(app);
    await postReadings(
      app,
      nameA,
      offsetsDays.map((d, k) => ({
        timestamp: iso(T0 + d * DAY_MS),
        value: micro[k] / 100,
        unit: 'A/m2',
      }))
    );

    const su = await getStatus(app, nameU);
    const sa = await getStatus(app, nameA);
    approxEqual(su.cumulativeThicknessLossMm, sa.cumulativeThicknessLossMm);
    approxEqual(su.cumulativeMassLossGPerM2, sa.cumulativeMassLossGPerM2);
    approxEqual(su.remainingThicknessMm, sa.remainingThicknessMm);
    assert.equal(su.coverage.coveredDays, sa.coverage.coveredDays);
  });
});

// 关系 8：超过最长间隔的缺口不计入累计量，覆盖天数减少，缺口入列
test('关系8：缺口不参与积分并写入缺口列表', async () => {
  await withApp(async (app) => {
    const name = await registerEquipment(app); // 默认最长间隔 7 天
    const readings = [];
    for (let k = 0; k <= 5; k += 1) {
      readings.push({ timestamp: iso(T0 + k * DAY_MS), value: 1, unit: 'A/m2' });
    }
    for (let k = 20; k <= 25; k += 1) {
      readings.push({ timestamp: iso(T0 + k * DAY_MS), value: 1, unit: 'A/m2' });
    }
    await postReadings(app, name, readings);

    const rates = await ironRates(app);
    const status = await getStatus(app, name);

    assert.equal(status.coverage.totalSpanDays, 25);
    assert.equal(status.coverage.coveredDays, 10); // 缺口 15 天不覆盖
    assert.equal(status.coverage.gaps.length, 1);
    assert.equal(status.coverage.gaps[0].start, iso(T0 + 5 * DAY_MS));
    assert.equal(status.coverage.gaps[0].end, iso(T0 + 20 * DAY_MS));
    assert.equal(status.coverage.gaps[0].days, 15);

    approxEqual(
      status.cumulativeThicknessLossMm,
      (rates.penetrationMmPerYear / 365) * 10
    );
    approxEqual(status.cumulativeMassLossGPerM2, rates.massLossGPerM2Day * 10);
  });
});

// 关系 9：批量中混入非法与冲突条目，整批不入库，状态不变
test('关系9：批量问题整批拒绝且设备状态不变', async () => {
  await withApp(async (app) => {
    const name = await registerEquipment(app);
    const initial = [];
    for (let k = 0; k <= 4; k += 1) {
      initial.push({ timestamp: iso(T0 + k * DAY_MS), value: 1, unit: 'A/m2' });
    }
    await postReadings(app, name, initial);
    const before = await getStatus(app, name);

    // 两条非法（负值、坏时间戳）+ 一条与已有时间戳冲突 → 400，问题一次列全
    const mixed = await app.inject({
      method: 'POST',
      url: `/equipment/${name}/readings`,
      payload: {
        readings: [
          { timestamp: iso(T0 + 10 * DAY_MS), value: 1, unit: 'A/m2' },
          { timestamp: iso(T0 + 11 * DAY_MS), value: -0.5, unit: 'A/m2' },
          { timestamp: 'not-a-time', value: 1, unit: 'A/m2' },
          { timestamp: iso(T0 + 2 * DAY_MS), value: 2, unit: 'A/m2' },
        ],
      },
    });
    assert.equal(mixed.statusCode, 400);
    const problems = mixed.json().problems;
    assert.ok(Array.isArray(problems));
    assert.deepEqual([...new Set(problems.map((p) => p.index))].sort(), [1, 2, 3]);
    assert.ok(problems.some((p) => p.field === 'value'));
    assert.ok(problems.some((p) => p.field === 'timestamp'));

    const afterMixed = await getStatus(app, name);
    assert.deepEqual(afterMixed, before);

    // 全部合法但含冲突（与已有 + 批内自撞）→ 409，点名冲突时间戳
    const conflictTs = iso(T0 + 3 * DAY_MS);
    const dupTs = iso(T0 + 20 * DAY_MS);
    const conflict = await app.inject({
      method: 'POST',
      url: `/equipment/${name}/readings`,
      payload: {
        readings: [
          { timestamp: iso(T0 + 5 * DAY_MS), value: 1, unit: 'A/m2' },
          { timestamp: conflictTs, value: 2, unit: 'A/m2' },
          { timestamp: dupTs, value: 1, unit: 'A/m2' },
          { timestamp: dupTs, value: 2, unit: 'A/m2' },
        ],
      },
    });
    assert.equal(conflict.statusCode, 409);
    const cProblems = conflict.json().problems;
    assert.deepEqual(cProblems.map((p) => p.index), [1, 3]);
    assert.ok(cProblems[0].reason.includes(conflictTs));
    assert.ok(cProblems[1].reason.includes(dupTs));

    const afterConflict = await getStatus(app, name);
    assert.deepEqual(afterConflict, before);
  });
});

// --- 登记与读数的参数拦截 ---

test('登记设备：材料档不存在 404，非法字段 400 并点名，重名 409', async () => {
  await withApp(async (app) => {
    const missing = await app.inject({
      method: 'POST',
      url: '/equipment',
      payload: {
        name: 'ghost-eq',
        materialName: 'no-such-material',
        initialThicknessMm: 10,
        corrosionAllowanceMm: 3,
      },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().field, 'materialName');

    const badCases = [
      [{ initialThicknessMm: 0 }, 'initialThicknessMm'],
      [{ initialThicknessMm: -5 }, 'initialThicknessMm'],
      [{ initialThicknessMm: '10' }, 'initialThicknessMm'],
      [{ corrosionAllowanceMm: 0 }, 'corrosionAllowanceMm'],
      [{ corrosionAllowanceMm: -1 }, 'corrosionAllowanceMm'],
      [{ corrosionAllowanceMm: 10 }, 'corrosionAllowanceMm'], // 等于初始壁厚
      [{ corrosionAllowanceMm: 12 }, 'corrosionAllowanceMm'], // 大于初始壁厚
      [{ maxReadingGapDays: 0 }, 'maxReadingGapDays'],
      [{ maxReadingGapDays: -3 }, 'maxReadingGapDays'],
    ];
    for (const [patch, field] of badCases) {
      const res = await app.inject({
        method: 'POST',
        url: '/equipment',
        payload: {
          name: uniqueName('bad'),
          materialName: 'iron-seawater',
          initialThicknessMm: 10,
          corrosionAllowanceMm: 3,
          ...patch,
        },
      });
      assert.equal(res.statusCode, 400, JSON.stringify(patch));
      assert.equal(res.json().field, field);
    }

    const ok = await app.inject({
      method: 'POST',
      url: '/equipment',
      payload: {
        name: 'dup-eq',
        materialName: 'iron-seawater',
        initialThicknessMm: 10,
        corrosionAllowanceMm: 3,
      },
    });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.json().maxReadingGapDays, 7); // 默认 7 天
    assert.equal(ok.json().scrapThicknessMm, 7); // 报废厚度 = 10 - 3

    const dup = await app.inject({
      method: 'POST',
      url: '/equipment',
      payload: {
        name: 'dup-eq',
        materialName: 'iron-seawater',
        initialThicknessMm: 8,
        corrosionAllowanceMm: 2,
      },
    });
    assert.equal(dup.statusCode, 409);
  });
});

test('读数：单位只认 μA/cm² 与 A/m²，零值合法，未知设备 404', async () => {
  await withApp(async (app) => {
    const name = await registerEquipment(app);

    const badUnit = await app.inject({
      method: 'POST',
      url: `/equipment/${name}/readings`,
      payload: {
        readings: [{ timestamp: iso(T0), value: 1, unit: 'mA/cm2' }],
      },
    });
    assert.equal(badUnit.statusCode, 400);
    assert.equal(badUnit.json().problems[0].field, 'unit');

    // 零值合法（探头未显示活性腐蚀），兼容各种单位写法
    const zero = await app.inject({
      method: 'POST',
      url: `/equipment/${name}/readings`,
      payload: {
        readings: [
          { timestamp: iso(T0), value: 0, unit: 'uA/cm2' },
          { timestamp: iso(T0 + DAY_MS), value: 0, unit: 'A/m²' },
        ],
      },
    });
    assert.equal(zero.statusCode, 201);
    assert.equal(zero.json().accepted, 2);

    const unknown = await app.inject({
      method: 'POST',
      url: '/equipment/no-such-eq/readings',
      payload: {
        readings: [{ timestamp: iso(T0), value: 1, unit: 'A/m2' }],
      },
    });
    assert.equal(unknown.statusCode, 404);

    const status404 = await app.inject({
      method: 'GET',
      url: '/equipment/no-such-eq/status',
    });
    assert.equal(status404.statusCode, 404);
  });
});

test('预测：零速率与无可积分区间给空值和原因，窗口可改', async () => {
  await withApp(async (app) => {
    // 全程零电流：速率为零
    const zeroEq = await registerEquipment(app);
    await postReadings(app, zeroEq, [
      { timestamp: iso(T0), value: 0, unit: 'A/m2' },
      { timestamp: iso(T0 + 5 * DAY_MS), value: 0, unit: 'A/m2' },
    ]);
    const sz = await getStatus(app, zeroEq);
    assert.equal(sz.allowanceExhausted, false);
    assert.equal(sz.prediction.averageRateMmPerDay, 0);
    assert.equal(sz.prediction.remainingDays, null);
    assert.equal(sz.prediction.projectedExhaustionAt, null);
    assert.ok(sz.prediction.reason.length > 0);

    // 只有一条读数：窗口里没有可积分区间
    const oneEq = await registerEquipment(app);
    await postReadings(app, oneEq, [
      { timestamp: iso(T0), value: 1, unit: 'A/m2' },
    ]);
    const so = await getStatus(app, oneEq);
    assert.equal(so.cumulativeThicknessLossMm, 0);
    assert.equal(so.prediction.remainingDays, null);
    assert.equal(so.prediction.projectedExhaustionAt, null);
    assert.ok(so.prediction.reason.length > 0);

    // 窗口参数可改；非法窗口/截止时刻 → 400
    const winEq = await registerEquipment(app);
    const readings = [];
    for (let k = 0; k <= 10; k += 1) {
      readings.push({ timestamp: iso(T0 + k * DAY_MS), value: 1, unit: 'A/m2' });
    }
    await postReadings(app, winEq, readings);
    const sw = await getStatus(app, winEq, { windowDays: 5 });
    assert.equal(sw.prediction.windowDays, 5);
    assert.equal(sw.prediction.coveredDaysInWindow, 5);
    assert.ok(sw.prediction.remainingDays > 0);
    assert.ok(sw.prediction.projectedExhaustionAt !== null);

    const badWindow = await app.inject({
      method: 'GET',
      url: `/equipment/${winEq}/status?windowDays=abc`,
    });
    assert.equal(badWindow.statusCode, 400);
    assert.equal(badWindow.json().field, 'windowDays');

    const badAsOf = await app.inject({
      method: 'GET',
      url: `/equipment/${winEq}/status?asOf=not-a-time`,
    });
    assert.equal(badAsOf.statusCode, 400);
    assert.equal(badAsOf.json().field, 'asOf');
  });
});

test('并发写入同一台设备：不丢读数、不放过重复时间戳', async () => {
  await withApp(async (app) => {
    const name = await registerEquipment(app);

    // 40 个并发批次，每批 5 条互不重叠的读数
    const batches = [];
    for (let b = 0; b < 40; b += 1) {
      const readings = [];
      for (let k = 0; k < 5; k += 1) {
        readings.push({
          timestamp: iso(T0 + (b * 5 + k) * 3600000), // 每小时一条
          value: 1,
          unit: 'A/m2',
        });
      }
      batches.push(
        app.inject({
          method: 'POST',
          url: `/equipment/${name}/readings`,
          payload: { readings },
        })
      );
    }
    const results = await Promise.all(batches);
    for (const res of results) assert.equal(res.statusCode, 201);

    const detail = await app.inject({ method: 'GET', url: `/equipment/${name}` });
    assert.equal(detail.json().readingCount, 200);

    // 两个并发批次撞同一时间戳：一个成功，一个 409
    const clashTs = iso(T0 + 300 * DAY_MS);
    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/equipment/${name}/readings`,
        payload: { readings: [{ timestamp: clashTs, value: 1, unit: 'A/m2' }] },
      }),
      app.inject({
        method: 'POST',
        url: `/equipment/${name}/readings`,
        payload: { readings: [{ timestamp: clashTs, value: 2, unit: 'A/m2' }] },
      }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    assert.deepEqual(codes, [201, 409]);
  });
});

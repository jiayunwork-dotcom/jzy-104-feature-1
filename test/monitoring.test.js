'use strict';

// 受监测设备的九条规定关系：累计量与单点核算的一致性、插值不变性、
// 乱序/分批等价性、梯形积分的几何关系、单调性、越线时刻、单位换算、
// 缺口处理、批量原子性。浮点比较相对误差不超过 1e-9。

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApp } = require('../src/app');

const REL_TOL = 1e-9;
const DAY_MS = 86400 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function approxEqual(actual, expected, relTol = REL_TOL) {
  assert.ok(
    Number.isFinite(actual),
    `expected a finite number, got ${actual}`
  );
  assert.ok(
    Math.abs(actual - expected) <= relTol * Math.max(1, Math.abs(expected)),
    `expected ${actual} ≈ ${expected} (relTol=${relTol})`
  );
}

const day = (d) => new Date(T0 + d * DAY_MS).toISOString();

async function withApp(run) {
  const app = buildApp({ logger: false });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

async function registerEquipment(app, name, overrides = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/equipment',
    payload: {
      name,
      materialName: 'iron-seawater',
      initialThicknessMm: 10,
      corrosionAllowanceMm: 3,
      ...overrides,
    },
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

async function mustPost(app, name, readings) {
  const res = await postReadings(app, name, readings);
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

async function status(app, name, query = {}) {
  const params = new URLSearchParams();
  if (query.asOf !== undefined) params.set('asOf', query.asOf);
  if (query.windowDays !== undefined) params.set('windowDays', String(query.windowDays));
  const qs = params.toString();
  const res = await app.inject({
    method: 'GET',
    url: `/equipment/${name}/status${qs ? `?${qs}` : ''}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

// 单点核算接口给出的铁档基准速率（1 A/m²）
async function ironRates(app) {
  const res = await app.inject({
    method: 'POST',
    url: '/corrosion/calculate',
    payload: { materialName: 'iron-seawater', currentDensityAmpPerM2: 1 },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().rates;
}

test('1. 恒定 1 A/m² 覆盖 D 天：累计失重 = 日质量损失率×D，累计壁厚损失 = 年速率折日×D', async () => {
  await withApp(async (app) => {
    const D = 10;
    await registerEquipment(app, 't1');
    // 每 12 小时一条，间隔不超过最长间隔（默认 7 天）
    const readings = [];
    for (let h = 0; h <= 2 * D; h++) {
      readings.push({ timestamp: day(h / 2), value: 1, unit: 'A/m2' });
    }
    await mustPost(app, 't1', readings);

    const rates = await ironRates(app);
    const s = await status(app, 't1');
    approxEqual(s.cumulativeMassLossGPerM2, rates.massLossGPerM2Day * D);
    approxEqual(s.cumulativeWallLossMm, (rates.penetrationMmPerYear / 365) * D);
    approxEqual(s.coveredDays, D);
    approxEqual(s.totalSpanDays, D);
    assert.deepEqual(s.gaps, []);
  });
});

test('2. 在线性区间正中间插入恰为插值的读数，所有累计量不变', async () => {
  await withApp(async (app) => {
    await registerEquipment(app, 't2a');
    await mustPost(app, 't2a', [
      { timestamp: day(0), value: 0.5, unit: 'A/m2' },
      { timestamp: day(4), value: 1.5, unit: 'A/m2' },
    ]);

    await registerEquipment(app, 't2b');
    await mustPost(app, 't2b', [
      { timestamp: day(0), value: 0.5, unit: 'A/m2' },
      { timestamp: day(2), value: 1.0, unit: 'A/m2' }, // 恰为线性插值
      { timestamp: day(4), value: 1.5, unit: 'A/m2' },
    ]);

    const a = await status(app, 't2a');
    const b = await status(app, 't2b');
    approxEqual(b.cumulativeWallLossMm, a.cumulativeWallLossMm);
    approxEqual(b.cumulativeMassLossGPerM2, a.cumulativeMassLossGPerM2);
    approxEqual(b.coveredDays, a.coveredDays);
    approxEqual(b.remainingThicknessMm, a.remainingThicknessMm);
    approxEqual(b.remainingAllowanceMm, a.remainingAllowanceMm);
  });
});

test('3. 同一组读数任意打乱、拆成几批提交，所有结果逐字段相同', async () => {
  await withApp(async (app) => {
    const base = [
      { d: 0, v: 1.0 },
      { d: 1.5, v: 0.4 },
      { d: 2, v: 0.9 },
      { d: 4.25, v: 1.3 },
      { d: 5, v: 0.2 },
      { d: 8, v: 1.1 },
      { d: 9.5, v: 0.7 },
      { d: 10, v: 1.0 },
    ].map(({ d, v }) => ({ timestamp: day(d), value: v, unit: 'A/m2' }));

    await registerEquipment(app, 't3a');
    await mustPost(app, 't3a', base); // 顺序、单批

    // 确定性乱序 + 拆三批
    const shuffled = [3, 0, 6, 1, 7, 2, 5, 4].map((i) => base[i]);
    await registerEquipment(app, 't3b');
    await mustPost(app, 't3b', shuffled.slice(0, 3));
    await mustPost(app, 't3b', shuffled.slice(3, 6));
    await mustPost(app, 't3b', shuffled.slice(6));

    const a = await status(app, 't3a');
    const b = await status(app, 't3b');
    // 除设备名外的所有结果字段逐一相同
    assert.deepEqual({ ...b, equipment: a.equipment }, a);

    // 截止时刻夹在两条读数中间时同样逐字段相同
    const aMid = await status(app, 't3a', { asOf: day(6) });
    const bMid = await status(app, 't3b', { asOf: day(6) });
    assert.deepEqual({ ...bMid, equipment: aMid.equipment }, aMid);
  });
});

test('4. 电流从 0 线性升到 i 的一段，累计量正好是全程恒为 i 时的一半', async () => {
  await withApp(async (app) => {
    await registerEquipment(app, 't4ramp');
    await mustPost(app, 't4ramp', [
      { timestamp: day(0), value: 0, unit: 'A/m2' },
      { timestamp: day(5), value: 2, unit: 'A/m2' },
    ]);

    await registerEquipment(app, 't4const');
    await mustPost(app, 't4const', [
      { timestamp: day(0), value: 2, unit: 'A/m2' },
      { timestamp: day(5), value: 2, unit: 'A/m2' },
    ]);

    const ramp = await status(app, 't4ramp');
    const konst = await status(app, 't4const');
    assert.ok(konst.cumulativeWallLossMm > 0);
    approxEqual(ramp.cumulativeWallLossMm, konst.cumulativeWallLossMm / 2);
    approxEqual(ramp.cumulativeMassLossGPerM2, konst.cumulativeMassLossGPerM2 / 2);
  });
});

test('5. 截止时刻后推累计壁厚损失单调不减；截止取末读数时与不带截止相同', async () => {
  await withApp(async (app) => {
    await registerEquipment(app, 't5');
    const values = [1, 0.5, 2, 1.5, 0.8, 1.2];
    await mustPost(
      app,
      't5',
      values.map((v, d) => ({ timestamp: day(d), value: v, unit: 'A/m2' }))
    );

    let previous = -1;
    for (const offset of [0, 0.5, 1, 2.3, 3.7, 4.9, 5]) {
      const s = await status(app, 't5', { asOf: day(offset) });
      assert.ok(
        s.cumulativeWallLossMm >= previous,
        `asOf=${day(offset)} 时累计量回落：${s.cumulativeWallLossMm} < ${previous}`
      );
      previous = s.cumulativeWallLossMm;
    }

    const atLast = await status(app, 't5', { asOf: day(5) });
    const byDefault = await status(app, 't5');
    assert.deepEqual(atLast, byDefault);
  });
});

test('6. 越线时刻：恒流下等于裕量/日深度速率；线性上升段内越线时刻回查累计量等于裕量', async () => {
  await withApp(async (app) => {
    const rates = await ironRates(app);
    const k = rates.penetrationMmPerYear / 365; // mm/天（1 A/m² 恒定）
    const allowance = 3;

    // 恒定 1 A/m²，读数间隔 2000 天 < 最长间隔 5000 天
    await registerEquipment(app, 't6a', { maxReadingGapDays: 5000 });
    await mustPost(app, 't6a', [
      { timestamp: day(0), value: 1, unit: 'A/m2' },
      { timestamp: day(2000), value: 1, unit: 'A/m2' },
    ]);
    const constStatus = await status(app, 't6a');
    assert.equal(constStatus.allowanceExhausted, true);
    const constDays = (Date.parse(constStatus.exhaustedAt) - T0) / DAY_MS;
    approxEqual(constDays, allowance / k);

    // 线性上升 0 → 4 A/m²（2000 天）：累计(t) = k·t²/1000，越线 t = √(3000/k)
    await registerEquipment(app, 't6b', { maxReadingGapDays: 5000 });
    await mustPost(app, 't6b', [
      { timestamp: day(0), value: 0, unit: 'A/m2' },
      { timestamp: day(2000), value: 4, unit: 'A/m2' },
    ]);
    const rampStatus = await status(app, 't6b');
    assert.equal(rampStatus.allowanceExhausted, true);
    const rampDays = (Date.parse(rampStatus.exhaustedAt) - T0) / DAY_MS;
    approxEqual(rampDays, Math.sqrt(3000 / k));

    // 把求出的越线时刻作为截止时刻再查一次：累计壁厚损失 = 裕量
    const recheck = await status(app, 't6b', { asOf: rampStatus.exhaustedAt });
    approxEqual(recheck.cumulativeWallLossMm, allowance);
  });
});

test('7. 同一组数据分别用 μA/cm² 和 A/m² 提交，结果一致', async () => {
  await withApp(async (app) => {
    const data = [
      { d: 0, v: 1 },
      { d: 3, v: 2 },
      { d: 6, v: 0.5 },
    ];
    await registerEquipment(app, 't7si');
    await mustPost(
      app,
      't7si',
      data.map(({ d, v }) => ({ timestamp: day(d), value: v, unit: 'A/m2' }))
    );

    await registerEquipment(app, 't7micro');
    await mustPost(
      app,
      't7micro',
      data.map(({ d, v }) => ({
        timestamp: day(d),
        value: v * 100, // 1 A/m² = 100 μA/cm²
        unit: 'uA/cm2',
      }))
    );

    const si = await status(app, 't7si');
    const micro = await status(app, 't7micro');
    approxEqual(micro.cumulativeWallLossMm, si.cumulativeWallLossMm);
    approxEqual(micro.cumulativeMassLossGPerM2, si.cumulativeMassLossGPerM2);
    approxEqual(micro.remainingThicknessMm, si.remainingThicknessMm);
    approxEqual(micro.remainingAllowanceMm, si.remainingAllowanceMm);
    approxEqual(micro.coveredDays, si.coveredDays);
  });
});

test('8. 超过最长间隔的缺口不参与积分，覆盖天数减少，缺口写进结果列表', async () => {
  await withApp(async (app) => {
    await registerEquipment(app, 't8'); // 最长间隔取默认 7 天
    await mustPost(app, 't8', [
      { timestamp: day(0), value: 1, unit: 'A/m2' },
      { timestamp: day(1), value: 1, unit: 'A/m2' },
      { timestamp: day(2), value: 1, unit: 'A/m2' },
      // 10 天无数据（换电池），超过最长间隔
      { timestamp: day(12), value: 1, unit: 'A/m2' },
      { timestamp: day(13), value: 1, unit: 'A/m2' },
    ]);

    const rates = await ironRates(app);
    const k = rates.penetrationMmPerYear / 365;

    const s = await status(app, 't8');
    approxEqual(s.coveredDays, 3); // 只有三段可积分：0-1、1-2、12-13
    approxEqual(s.totalSpanDays, 13);
    approxEqual(s.cumulativeWallLossMm, k * 3);
    assert.equal(s.gaps.length, 1);
    assert.equal(s.gaps[0].from, day(2));
    assert.equal(s.gaps[0].to, day(12));
    approxEqual(s.gaps[0].days, 10);

    // 与无缺口的对照设备（0-3 天连续）累计量相同
    await registerEquipment(app, 't8ref');
    await mustPost(
      app,
      't8ref',
      [0, 1, 2, 3].map((d) => ({ timestamp: day(d), value: 1, unit: 'A/m2' }))
    );
    const ref = await status(app, 't8ref');
    approxEqual(s.cumulativeWallLossMm, ref.cumulativeWallLossMm);

    // 截止时刻落在缺口中间：缺口段不计入，缺口裁剪到截止时刻
    const mid = await status(app, 't8', { asOf: day(7) });
    approxEqual(mid.cumulativeWallLossMm, k * 2);
    approxEqual(mid.coveredDays, 2);
    assert.equal(mid.gaps.length, 1);
    assert.equal(mid.gaps[0].from, day(2));
    assert.equal(mid.gaps[0].to, day(7));
    approxEqual(mid.gaps[0].days, 5);
  });
});

test('9. 批量混入非法与冲突读数：整批不入库，设备状态与提交前完全相同', async () => {
  await withApp(async (app) => {
    await registerEquipment(app, 't9');
    await mustPost(app, 't9', [
      { timestamp: day(1), value: 1, unit: 'A/m2' },
    ]);
    const before = await status(app, 't9');

    const res = await postReadings(app, 't9', [
      { timestamp: day(2), value: 1, unit: 'A/m2' }, // 合法
      { timestamp: day(3), value: -0.5, unit: 'A/m2' }, // 非法：负值
      { timestamp: 'not-a-timestamp', value: 1, unit: 'A/m2' }, // 非法：时间戳
      { timestamp: day(1), value: 2, unit: 'A/m2' }, // 与已有读数冲突
    ]);
    assert.equal(res.statusCode, 400, res.body);
    const body = res.json();
    const errorIndexes = body.errors.map((e) => e.index).sort();
    assert.deepEqual(errorIndexes, [1, 2]);
    assert.equal(body.errors[0].field, 'value');
    assert.equal(body.errors[1].field, 'timestamp');
    // 冲突条目也一并列出，不用改一条交一次
    assert.ok(
      body.conflicts.some((c) => c.index === 3 && c.timestamp === day(1))
    );

    const after = await status(app, 't9');
    assert.deepEqual(after, before);

    // 全部合法、仅时间戳冲突 → 409，且说清冲突的是哪个时间戳
    const dup = await postReadings(app, 't9', [
      { timestamp: day(1), value: 5, unit: 'A/m2' },
    ]);
    assert.equal(dup.statusCode, 409, dup.body);
    assert.equal(dup.json().conflicts[0].timestamp, day(1));

    // 批内自撞时间戳同样 409
    const selfDup = await postReadings(app, 't9', [
      { timestamp: day(5), value: 1, unit: 'A/m2' },
      { timestamp: day(5), value: 2, unit: 'A/m2' },
    ]);
    assert.equal(selfDup.statusCode, 409, selfDup.body);
    assert.equal(selfDup.json().conflicts[0].timestamp, day(5));

    // 旧值不被覆盖，状态始终不变
    assert.deepEqual(await status(app, 't9'), before);
  });
});

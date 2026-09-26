'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApp } = require('../src/app');

async function withApp(run) {
  const app = buildApp({ logger: false });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test('健康检查', async () => {
  await withApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  });
});

test('预置铁-海水基准档可列出、可点名取用', async () => {
  await withApp(async (app) => {
    const list = await app.inject({ method: 'GET', url: '/materials' });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.equal(body.count, 1);
    assert.equal(body.materials[0].name, 'iron-seawater');

    const one = await app.inject({
      method: 'GET',
      url: '/materials/iron-seawater',
    });
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().valence, 2);
  });
});

test('基准档核算结果钉在回归值上（1 A/m²）', async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: 'POST',
      url: '/corrosion/calculate',
      payload: { materialName: 'iron-seawater', currentDensityAmpPerM2: 1 },
    });
    assert.equal(res.statusCode, 200);
    const { rates } = res.json();
    assert.ok(Math.abs(rates.penetrationMmPerYear - 1.1596445147826109) < 1e-9);
    assert.ok(Math.abs(rates.massLossGPerM2Day - 25.0038420036689) < 1e-9);
  });
});

test('登记新档并核算，多档参数互不串用', async () => {
  await withApp(async (app) => {
    const reg = await app.inject({
      method: 'POST',
      url: '/materials',
      payload: {
        name: 'aluminium',
        molarMassKgPerMol: 0.02698,
        valence: 3,
        densityKgPerM3: 2700,
      },
    });
    assert.equal(reg.statusCode, 201);

    const fe = await app.inject({
      method: 'POST',
      url: '/corrosion/calculate',
      payload: { materialName: 'iron-seawater', currentDensityAmpPerM2: 1 },
    });
    const al = await app.inject({
      method: 'POST',
      url: '/corrosion/calculate',
      payload: { materialName: 'aluminium', currentDensityAmpPerM2: 1 },
    });
    assert.ok(
      Math.abs(
        fe.json().rates.penetrationMmPerYear -
          al.json().rates.penetrationMmPerYear
      ) > 0.05
    );
    // 铁档参数不被铝档改动
    assert.equal(fe.json().materialName, 'iron-seawater');
  });
});

test('提供面积与时长时返回总电流与累计失重', async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: 'POST',
      url: '/corrosion/calculate',
      payload: {
        materialName: 'iron-seawater',
        currentDensityAmpPerM2: 1,
        areaM2: 2,
        durationDays: 1,
      },
    });
    assert.equal(res.statusCode, 200);
    const { totals } = res.json();
    assert.equal(totals.totalCurrentAmp, 2);
    assert.ok(totals.cumulativeMassLossKg > 0);
    assert.ok(Math.abs(totals.cumulativeMassLossG - totals.cumulativeMassLossKg * 1000) < 1e-12);
  });
});

test('非法参数在计算前被挡住：电流密度为零/为负', async () => {
  await withApp(async (app) => {
    for (const bad of [0, -1]) {
      const res = await app.inject({
        method: 'POST',
        url: '/corrosion/calculate',
        payload: {
          materialName: 'iron-seawater',
          currentDensityAmpPerM2: bad,
        },
      });
      assert.equal(res.statusCode, 400);
      const json = res.json();
      assert.equal(json.field, 'currentDensityAmpPerM2');
      assert.ok(json.reason.length > 0);
    }
  });
});

test('离子价数不是正整数被拒绝（含 0、负数、小数、字符串）', async () => {
  await withApp(async (app) => {
    for (const bad of [0, -2, 2.5, '2']) {
      const res = await app.inject({
        method: 'POST',
        url: '/materials',
        payload: {
          name: `bad-${String(bad)}`,
          molarMassKgPerMol: 0.05,
          valence: bad,
          densityKgPerM3: 7000,
        },
      });
      assert.equal(res.statusCode, 400, `valence=${bad}`);
      assert.equal(res.json().field, 'valence');
    }
  });
});

test('密度不为正、摩尔质量不为正被拒绝', async () => {
  await withApp(async (app) => {
    const badDensity = await app.inject({
      method: 'POST',
      url: '/materials',
      payload: {
        name: 'bad-density',
        molarMassKgPerMol: 0.05,
        valence: 2,
        densityKgPerM3: 0,
      },
    });
    assert.equal(badDensity.statusCode, 400);
    assert.equal(badDensity.json().field, 'densityKgPerM3');

    const badMass = await app.inject({
      method: 'POST',
      url: '/materials',
      payload: {
        name: 'bad-mass',
        molarMassKgPerMol: -0.01,
        valence: 2,
        densityKgPerM3: 7000,
      },
    });
    assert.equal(badMass.statusCode, 400);
    assert.equal(badMass.json().field, 'molarMassKgPerMol');
  });
});

test('点名未登记档返回 404，重复登记返回 409', async () => {
  await withApp(async (app) => {
    const missing = await app.inject({
      method: 'POST',
      url: '/corrosion/calculate',
      payload: { materialName: 'ghost', currentDensityAmpPerM2: 1 },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().field, 'materialName');

    const dup = await app.inject({
      method: 'POST',
      url: '/materials',
      payload: {
        name: 'iron-seawater',
        molarMassKgPerMol: 0.055845,
        valence: 2,
        densityKgPerM3: 7870,
      },
    });
    assert.equal(dup.statusCode, 409);
  });
});

test('只给时长不给面积属于自相矛盾，返回 400', async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: 'POST',
      url: '/corrosion/calculate',
      payload: {
        materialName: 'iron-seawater',
        currentDensityAmpPerM2: 1,
        durationDays: 7,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().field, 'durationDays');
  });
});

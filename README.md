# 均匀腐蚀速率核算服务

基于法拉第电解当量的均匀腐蚀（general corrosion）速率核算 HTTP 服务。
调用方先把金属登记为具名「材料档」（摩尔质量、离子价数、密度），之后点名某档并给出
当时测到的**腐蚀电流密度**，服务即按电化学当量算出去年腐蚀深度（mm/年）与
单位面积每天质量损失（g/(m²·天)）。只提供 HTTP 接口，不含任何页面，也不做采购单/巡检工单。

- 运行时：Node.js 20
- HTTP 层：Fastify（仅这一个外部依赖）
- 交付：`docker build` 一键镜像，启动即可用

## 物理内核

法拉第电解定律（F 取 CODATA 公认值 **96485.33212 C/mol**，非 96500 近似整数）：

```
单位面积质量损失速率  ṁ/A = M·i / (z·F)          [kg/(m²·s)]
腐蚀深度速率          v    = (ṁ/A) / ρ            [m/s]
```

工程换算（365 天/年）：

```
g/(m²·天) = kg/(m²·s) × 86400 × 1000
mm/年     = m/s × 31 536 000 × 1000
```

给定受腐蚀面积 A 与评估时长 t：

```
总腐蚀电流  I = i·A          [A]
累计质量损失 m = (ṁ/A)·A·t    [kg]
```

腐蚀电流密度直接作为输入接收；塔菲尔外推等求解手段不属于本服务。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/materials` | 登记材料档 |
| GET | `/materials` | 列出全部档 |
| GET | `/materials/:name` | 按名取档 |
| POST | `/corrosion/calculate` | 点名某档核算速率/总量 |

### 登记材料档

```jsonc
POST /materials
{
  "name": "aluminium",
  "molarMassKgPerMol": 0.02698, // kg/mol（26.98 g/mol）
  "valence": 3,                 // 正整数
  "densityKgPerM3": 2700        // kg/m³（2.70 g/cm³）
}
```

### 核算

```jsonc
POST /corrosion/calculate
{
  "materialName": "iron-seawater",
  "currentDensityAmpPerM2": 1,  // A/m²，必须为正（1 A/m² = 100 μA/cm²）
  "areaM2": 2,                   // 可选，给了才返回总电流
  "durationDays": 7              // 可选，需与 areaM2 同时给出
}
```

非法输入（电流密度不为正、价数非正整数、密度/摩尔质量不为正等）在进入公式前被拦截，
返回带 `field` 与 `reason` 的 400；档不存在返回 404；重复登记返回 409。

## 预置基准档（回归基准，可手算）

`iron-seawater`：工业纯铁按 Fe²⁺ 溶解，M = 55.845 g/mol、z = 2、ρ = 7.87 g/cm³。

i = 1 A/m²（= 100 μA/cm²）时：

- 质量损失率 ≈ **25.0038 g/(m²·天)**
- 深度速率 ≈ **1.15964 mm/年**（与工程系数 3.27×10⁻³·i[μA/cm²]·M/(z·ρ) 同量级）

## 本地开发

```bash
npm install
npm test     # node:test，19 个用例覆盖全部守恒关系与非法参数拦截
npm start    # 默认监听 0.0.0.0:8080
```

## 构建与运行镜像

```bash
docker build -t corrosion-rate-service .
docker run --rm -p 8080:8080 corrosion-rate-service
```

## 文件划分

```
src/
  physics/
    constants.js   # 法拉第常数与时间/单位基准
    equivalent.js  # 电解当量、单位面积质量速率
    depth.js       # 深度速率与单位换算
    totals.js      # 总电流与累计失重
  materials/
    repository.js  # 材料档进程内存取（登记/取用/清单）
    seed.js        # 预置铁-海水基准档
  validation.js    # 参数合法性拦截（计算前）
  errors.js        # 带原因的结构化错误
  corrosion-service.js # 核算编排（无 HTTP 依赖）
  app.js           # 薄薄的 Fastify 路由层
  index.js         # 启动入口
test/
  conservation.test.js # 六条守恒关系 + 基准回归
  http.test.js         # 接口、非法参数、错误码
```

# 均匀腐蚀速率核算服务

基于法拉第电解当量的均匀腐蚀（general corrosion）速率核算 HTTP 服务。
调用方先把金属登记为具名「材料档」（摩尔质量、离子价数、密度），之后点名某档并给出
当时测到的**腐蚀电流密度**，服务即按电化学当量算出去年腐蚀深度（mm/年）与
单位面积每天质量损失（g/(m²·天)）。只提供 HTTP 接口，不含任何页面，也不做采购单/巡检工单。

在此之上还有「受监测设备」：把线性极化探头的读数流挂到设备下面，服务对时间积分，
回答巡检工程师真正关心的问题——投用到现在被吃掉了多少壁厚、腐蚀裕量还剩多少、
照最近的势头再过多少天会碰到报废厚度。

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

## 累计量的时序积分

相邻两条读数之间电流密度视为线性变化，按梯形算出这一段通过的电量
`Q = (i₁+i₂)/2 · Δt`，再乘以材料档在 1 A/m² 下的单点速率系数
（即 `massLossRateKgPerM2S`/`penetrationRateMPerS` 同一套当量公式与单位换算）
得到单位面积失重与壁厚损失，不另抄一份公式。越线时刻则解段内二次方程
`k·[i₁·τ + (i₂−i₁)·τ²/(2Δt)] = 剩余裕量`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/materials` | 登记材料档 |
| GET | `/materials` | 列出全部档 |
| GET | `/materials/:name` | 按名取档 |
| POST | `/corrosion/calculate` | 点名某档核算速率/总量 |
| POST | `/equipment` | 登记受监测设备 |
| GET | `/equipment` | 列出全部设备 |
| GET | `/equipment/:name` | 按名取设备 |
| POST | `/equipment/:name/readings` | 批量提交探头读数 |
| GET | `/equipment/:name/status` | 查设备状态（累计量/缺口/越线时刻/剩余寿命） |

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

### 登记受监测设备

```jsonc
POST /equipment
{
  "name": "tank-01",
  "materialName": "iron-seawater", // 必须已登记，否则 404
  "initialThicknessMm": 12,        // 初始壁厚，正数
  "corrosionAllowanceMm": 3,       // 腐蚀裕量，正数且小于初始壁厚
  "maxReadingGapDays": 7           // 允许的最长读数间隔（天），可省，默认 7
}
```

报废厚度 = 初始壁厚 − 腐蚀裕量。字段不合法返回点名字段的 400；设备名重复返回 409。

### 提交探头读数

```jsonc
POST /equipment/tank-01/readings
{
  "readings": [
    { "timestamp": "2026-01-01T00:00:00Z", "value": 100, "unit": "μA/cm²" },
    { "timestamp": "2026-01-02T00:00:00Z", "value": 1.0, "unit": "A/m²" }
  ]
}
```

- 单位只认 `μA/cm²`（兼容 `uA/cm²`/`µA/cm²`/`²` 等写法）与 `A/m²`；
  1 μA/cm² = 0.01 A/m²，入库时统一换算为 A/m²。
- 值可以是零（探头未显示活性腐蚀）；负数、非数值、解析不了的时间戳 → 400。
- 读数可批量、可乱序、可分几次补传。同一台设备同一时间戳（含批内自撞）→ 409，
  冲突时间戳写进响应，不覆盖旧值。
- 一批中任何一条出问题则**整批不入库**，响应 `problems` 数组一次列全所有问题
  （含批内下标）；有格式不合法条目按 400 回，全合法只是时间戳冲突按 409 回。
- 校验与落库在同一个同步代码段内完成，并发请求不会丢读数或放过重复时间戳。

### 查询设备状态

```
GET /equipment/tank-01/status?asOf=2026-02-01T00:00:00Z&windowDays=30
```

- 不带 `asOf` 取最后一条读数时刻；`asOf` 夹在两条读数中间时只积到该时刻，
  截止处电流按两端线性插值。第一条之前、最后一条之后都不算。
- 相邻读数间隔超过设备 `maxReadingGapDays` 的整段按数据缺口处理：不参与积分，
  列入 `coverage.gaps`（起止时间与天数），并给出 `coveredDays` 与 `totalSpanDays`。
- 返回累计壁厚损失（mm）、单位面积累计失重（g/m²）、剩余壁厚、剩余裕量。
- 裕量已耗尽：`allowanceExhausted: true`，`exceededScrapAt` 给出准确越线时刻——
  区间内电流线性、壁厚损失是时间的二次函数，服务在段内解二次方程，
  不用区间端点凑、也不按平均速率倒推。
- 裕量未耗尽：`prediction` 取截止时刻往前一个窗口（默认 30 天，可改）的
  平均深度速率（窗口内壁厚损失 / 窗口内实际覆盖天数，缺口不算进分母；
  窗口比已有数据长则只用有数据的部分），给出剩余天数与预计到达日期；
  窗口内速率为零或没有可积分区间时，预测字段为 `null` 并附 `reason`，
  不返回无穷大/NaN，也不会报 500。

## 预置基准档（回归基准，可手算）

`iron-seawater`：工业纯铁按 Fe²⁺ 溶解，M = 55.845 g/mol、z = 2、ρ = 7.87 g/cm³。

i = 1 A/m²（= 100 μA/cm²）时：

- 质量损失率 ≈ **25.0038 g/(m²·天)**
- 深度速率 ≈ **1.15964 mm/年**（与工程系数 3.27×10⁻³·i[μA/cm²]·M/(z·ρ) 同量级）

## 本地开发

```bash
npm install
npm test     # node:test，32 个用例：原有守恒/接口用例 + 设备时序积分九条关系
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
  equipment/
    repository.js  # 受监测设备进程内存取（读数随设备存放）
    validation.js  # 设备/读数/查询参数拦截（批量问题一次列全）
    integration.js # 时序积分内核：梯形电量、缺口、越线二次方程、窗口预测
    service.js     # 设备编排（登记/批量入库/状态查询）
  validation.js    # 参数合法性拦截（计算前）
  errors.js        # 带原因的结构化错误
  corrosion-service.js # 核算编排（无 HTTP 依赖）
  app.js           # 薄薄的 Fastify 路由层
  index.js         # 启动入口
test/
  conservation.test.js # 六条守恒关系 + 基准回归
  http.test.js         # 接口、非法参数、错误码
  equipment.test.js    # 设备九条关系（1e-9 相对误差）+ 拦截与并发
```

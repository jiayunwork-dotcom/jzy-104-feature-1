# 均匀腐蚀速率核算服务

基于法拉第电解当量的均匀腐蚀（general corrosion）速率核算 HTTP 服务。
调用方先把金属登记为具名「材料档」（摩尔质量、离子价数、密度），之后点名某档并给出
当时测到的**腐蚀电流密度**，服务即按电化学当量算出去年腐蚀深度（mm/年）与
单位面积每天质量损失（g/(m²·天)）。只提供 HTTP 接口，不含任何页面，也不做采购单/巡检工单。

在此之上还有「受监测设备」：登记设备（材料档、初始壁厚、腐蚀裕量、最长读数间隔）后，
线性极化探头的电流密度读数可以批量、乱序、分次补传进来，服务按时间积分回答
巡检工程师关心的问题——从投用到现在被吃掉了多少壁厚、腐蚀裕量还剩多少、
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

## 时间积分（受监测设备）

设备读数挂在时间轴上积分，全部复用上面同一套当量公式与单位换算：

- 相邻两条读数之间电流密度视为**线性变化**，按梯形求该段通过的电量，
  再换成单位面积失重（g/m²）与壁厚损失（mm）；第一条之前、最后一条之后都不算。
- 相邻两条读数间隔超过设备的**最长读数间隔**（默认 7 天）时，该段视为数据缺失：
  不参与积分，作为缺口（起止时刻与天数）写进结果，并同时给出已覆盖天数与总跨度天数。
- 截止时刻夹在两条读数中间时，该段只积到截止时刻，截止处电流按两端线性插值。
- 裕量耗尽时，壁厚越过报废厚度的时刻在区间内**解二次方程**求得
  （电流线性变化 ⇒ 壁厚损失随时间是二次曲线），不拿端点凑、不按平均速率倒推。
- 剩余寿命 = 剩余裕量 ÷ 窗口（默认 30 天）内平均深度速率；
  窗口速率 = 窗口内壁厚损失 ÷ 窗口内实际覆盖天数（缺口不算进分母）。
  窗口内速率为零或没有可积分区间时，预测字段给空值并附原因。

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
| GET | `/equipment/:name` | 按名取设备登记信息 |
| POST | `/equipment/:name/readings` | 批量提交探头读数 |
| GET | `/equipment/:name/status` | 累计量、缺口、越线时刻/剩余寿命预测 |

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
  "name": "tank-A",
  "materialName": "iron-seawater", // 必须是已登记的材料档，否则 404
  "initialThicknessMm": 12,        // 投用时的初始壁厚，正数
  "corrosionAllowanceMm": 4,       // 腐蚀裕量，正数且小于初始壁厚
  "maxReadingGapDays": 10          // 可选，最长读数间隔（天），默认 7
}
```

报废厚度 = 初始壁厚 − 腐蚀裕量（响应里的 `retirementThicknessMm`）。
字段不合法返回 400 并点名 `field`；设备名重复返回 409。

### 提交读数

```jsonc
POST /equipment/tank-A/readings
{
  "readings": [
    { "timestamp": "2026-01-01T00:00:00Z", "value": 80, "unit": "uA/cm2" },
    { "timestamp": "2026-01-03T00:00:00Z", "value": 0.12, "unit": "A/m2" }
  ]
}
```

- 每条读数必须声明单位，只认 `uA/cm2` 与 `A/m2`（1 μA/cm² = 0.01 A/m²）。
- 读数可以是零（无活性腐蚀）；负数、非数值、解析不了的时间戳都是 400。
- 可批量、可乱序、可分次补传；同一设备同一时间戳再次出现返回 409 并指明冲突时间戳，
  不会悄悄覆盖旧值；批内自撞同样 409。
- 整批原子：任一条目出问题整批不入库，响应把出问题的条目连同批内下标一次列全
  （`errors` / `conflicts`）；有格式非法条目按 400 回，仅时间戳冲突按 409 回。

### 查询设备状态

```
GET /equipment/tank-A/status?asOf=2026-02-01T00:00:00Z&windowDays=30
```

`asOf`（截止时刻）与 `windowDays`（预测窗口，默认 30 天）都可省略，
不带截止时刻就取最后一条读数的时刻。返回：

- `cumulativeWallLossMm` 累计壁厚损失（mm）、`cumulativeMassLossGPerM2` 单位面积累计失重（g/m²）
- `remainingThicknessMm` 剩余壁厚、`remainingAllowanceMm` 剩余裕量
- `coveredDays` 已覆盖天数、`totalSpanDays` 总跨度天数、`gaps` 缺口列表
- 裕量已耗尽：`allowanceExhausted=true` 且 `exhaustedAt` 给出越过报废厚度的准确时刻
- 否则 `prediction` 给出窗口平均速率、剩余天数与预计耗尽时刻；
  无法外推时预测字段为空值并附 `reason`

设备与读数跟材料档一样只放在进程内存里，重启后重新登记即可；运行期间同一设备的
并发写入整批串行落库，不丢读数、不出重复时间戳。

## 预置基准档（回归基准，可手算）

`iron-seawater`：工业纯铁按 Fe²⁺ 溶解，M = 55.845 g/mol、z = 2、ρ = 7.87 g/cm³。

i = 1 A/m²（= 100 μA/cm²）时：

- 质量损失率 ≈ **25.0038 g/(m²·天)**
- 深度速率 ≈ **1.15964 mm/年**（与工程系数 3.27×10⁻³·i[μA/cm²]·M/(z·ρ) 同量级）

## 本地开发

```bash
npm install
npm test     # node:test，38 个用例覆盖全部守恒关系、积分关系与非法参数拦截
npm start    # 默认监听 0.0.0.0:8080
```

## 构建与运行镜像

```bash
docker build -t corrosion-rate-service .
docker run --rm -p 8080:8080 corrosion-rate-service
docker run --rm corrosion-rate-service npm test   # 测试随镜像一起，可就地运行
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
    integration.js # 读数时间积分（梯形/缺口/越线方程），复用 physics 公式链
    repository.js  # 设备与读数的进程内存存取（整批原子落库）
    service.js     # 状态编排：累计量、缺口、越线时刻、剩余寿命预测
  validation.js    # 参数合法性拦截（计算前）
  errors.js        # 带原因的结构化错误
  corrosion-service.js # 核算编排（无 HTTP 依赖）
  app.js           # 薄薄的 Fastify 路由层
  index.js         # 启动入口
test/
  conservation.test.js # 六条守恒关系 + 基准回归
  http.test.js         # 接口、非法参数、错误码
  monitoring.test.js   # 九条设备监测规定关系（相对误差 ≤ 1e-9）
  equipment.test.js    # 设备/读数校验、预测退化情形、并发写入
```

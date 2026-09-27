'use strict';

// 薄薄一层 HTTP：请求进出、校验、调度，核算与存取逻辑都不放在这里。

const Fastify = require('fastify');

const { ValidationError, NotFoundError, ConflictError } = require('./errors');
const {
  validateMaterialInput,
  validateCalculationInput,
  validateEquipmentInput,
  parseReadingsPayload,
  validateStatusQuery,
} = require('./validation');
const { MaterialRepository } = require('./materials/repository');
const { seedDefaultMaterials } = require('./materials/seed');
const { CorrosionService } = require('./corrosion-service');
const { EquipmentRepository } = require('./equipment/repository');
const { EquipmentService } = require('./equipment/service');

function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  const repository = new MaterialRepository();
  const service = new CorrosionService(repository);
  seedDefaultMaterials(repository); // 预置铁-海水基准档

  const equipmentRepository = new EquipmentRepository();
  const equipmentService = new EquipmentService(equipmentRepository, repository);

  // 统一把已知业务错误映射为带原因的错误响应，不抛出裸 500。
  // 批量读数这类错误会附带 details（出问题的条目清单），原样透传；
  // 既有错误不带 details，响应字段与之前完全一致。
  app.setErrorHandler((error, request, reply) => {
    if (
      error instanceof ValidationError ||
      error instanceof NotFoundError ||
      error instanceof ConflictError
    ) {
      return reply.status(error.statusCode).send({
        error: error.name,
        message: error.message,
        field: error.field,
        reason: error.reason,
        ...(error.details !== undefined ? error.details : {}),
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      error: 'InternalServerError',
      message: '服务内部错误',
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // 登记材料档
  app.post('/materials', async (request, reply) => {
    const material = validateMaterialInput(request.body);
    const created = repository.register(material);
    return reply.status(201).send(created);
  });

  // 列出材料档清单
  app.get('/materials', async () => ({
    count: repository.list().length,
    materials: repository.list(),
  }));

  // 按名取档
  app.get('/materials/:name', async (request) => {
    return repository.get(request.params.name);
  });

  // 点名某档并给定腐蚀电流密度，核算速率；可附面积与时长求总量
  app.post('/corrosion/calculate', async (request) => {
    const input = validateCalculationInput(request.body);
    return service.calculate(input);
  });

  // 登记受监测设备：材料档没登记过 → 404，字段不合法 → 400，重名 → 409
  app.post('/equipment', async (request, reply) => {
    const input = validateEquipmentInput(request.body);
    const created = equipmentService.register(input);
    return reply.status(201).send(created);
  });

  // 列出受监测设备清单
  app.get('/equipment', async () => ({
    count: equipmentRepository.list().length,
    equipment: equipmentRepository.list(),
  }));

  // 按名取设备登记信息
  app.get('/equipment/:name', async (request) => {
    return equipmentRepository.get(request.params.name);
  });

  // 批量提交读数：整批校验，任一条目出问题则整批不入库。
  // 条目格式不合法 → 400（并附上同时存在的时间戳冲突）；仅时间戳冲突 → 409。
  app.post('/equipment/:name/readings', async (request, reply) => {
    const name = request.params.name;
    equipmentRepository.getRef(name); // 设备未登记 → 404
    const { entries, errors } = parseReadingsPayload(request.body);
    const conflicts = equipmentRepository.findConflicts(name, entries);
    if (errors.length > 0) {
      const error = new ValidationError(
        'readings',
        `有 ${errors.length} 条读数不合法，整批未入库`
      );
      error.details = { errors };
      if (conflicts.length > 0) error.details.conflicts = conflicts;
      throw error;
    }
    const result = equipmentRepository.addReadings(name, entries); // 冲突 → 409
    return reply.status(201).send({
      equipment: name,
      inserted: result.inserted,
      readingCount: result.readingCount,
    });
  });

  // 设备状态：累计壁厚损失/失重、剩余壁厚与裕量、缺口、越线时刻或剩余寿命预测
  app.get('/equipment/:name/status', async (request) => {
    const { asOfMs, windowDays } = validateStatusQuery(request.query);
    return equipmentService.status(request.params.name, { asOfMs, windowDays });
  });

  return app;
}

module.exports = { buildApp };

'use strict';

// 薄薄一层 HTTP：请求进出、校验、调度，核算与存取逻辑都不放在这里。

const Fastify = require('fastify');

const { ValidationError, NotFoundError, ConflictError } = require('./errors');
const {
  validateMaterialInput,
  validateCalculationInput,
} = require('./validation');
const { MaterialRepository } = require('./materials/repository');
const { seedDefaultMaterials } = require('./materials/seed');
const { CorrosionService } = require('./corrosion-service');

function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  const repository = new MaterialRepository();
  const service = new CorrosionService(repository);
  seedDefaultMaterials(repository); // 预置铁-海水基准档

  // 统一把已知业务错误映射为带原因的错误响应，不抛出裸 500。
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

  return app;
}

module.exports = { buildApp };

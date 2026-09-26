'use strict';

// 带字段与原因的结构化错误，供 HTTP 层映射为 400/404/409。
class ValidationError extends Error {
  constructor(field, reason) {
    super(`${field}: ${reason}`);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.field = field;
    this.reason = reason;
  }
}

class NotFoundError extends Error {
  constructor(field, reason) {
    super(`${field}: ${reason}`);
    this.name = 'NotFoundError';
    this.statusCode = 404;
    this.field = field;
    this.reason = reason;
  }
}

class ConflictError extends Error {
  constructor(field, reason) {
    super(`${field}: ${reason}`);
    this.name = 'ConflictError';
    this.statusCode = 409;
    this.field = field;
    this.reason = reason;
  }
}

module.exports = { ValidationError, NotFoundError, ConflictError };

export class ActiveRunError extends Error {
  readonly statusCode = 409;
  constructor(message = "这个会话还有未完成的一轮，请先回答问卷/处理 Action") {
    super(message);
    this.name = "ActiveRunError";
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

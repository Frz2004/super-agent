import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError, z } from 'zod';
import type { AuditEvent } from '../shared/types.js';
import { Problem, queryInput, Service } from './service.js';
import type { Runner } from './runner.js';

const scalar = (value: unknown) => z.string().parse(value);
export function createApp(service: Service, runner: Runner, staticDir = resolve('dist/client')) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-ID', res.locals.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'",
    );
    if (!['127.0.0.1', 'localhost'].includes(req.hostname))
      return next(new Problem(403, 'INVALID_HOST', '服务仅接受本地访问'));
    const origin = req.headers.origin;
    const permitted = [`http://${req.headers.host}`];
    if (process.env.NODE_ENV !== 'production')
      permitted.push('http://127.0.0.1:5173', 'http://localhost:5173');
    if (origin && !permitted.includes(origin))
      return next(new Problem(403, 'INVALID_ORIGIN', '不允许此请求来源'));
    next();
  });
  app.use('/api', express.json({ limit: '64kb' }));
  const id = (res: Response) => res.locals.requestId as string;
  const key = (req: Request) => req.get('Idempotency-Key');
  app.get('/api/health', (_req, res) =>
    res.json({
      status: 'ok',
      database: 'sqlite',
      running: runner.runningCount,
      concurrency: runner.concurrency,
    }),
  );
  app.get('/api/projects', (_req, res) => res.json(service.projects()));
  app.post('/api/projects', (req, res) =>
    res.status(201).json(service.createProject(req.body, id(res))),
  );
  app.get('/api/projects/:id', (req, res) => res.json(service.project(scalar(req.params.id))));
  app.patch('/api/projects/:id', (req, res) =>
    res.json(service.patchProject(scalar(req.params.id), req.body, id(res))),
  );
  app.get('/api/projects/:id/tasks', (req, res) =>
    res.json(service.tasks(scalar(req.params.id), queryInput.parse(req.query))),
  );
  app.post('/api/projects/:id/tasks', (req, res) =>
    res.status(201).json(service.createTask(scalar(req.params.id), req.body, id(res), key(req))),
  );
  app.get('/api/tasks/:id', (req, res) => res.json(service.detail(scalar(req.params.id))));
  app.patch('/api/tasks/:id', (req, res) =>
    res.json(service.patchTask(scalar(req.params.id), req.body, id(res))),
  );
  app.put('/api/tasks/:id/dependencies', (req, res) =>
    res.json(service.dependencies(scalar(req.params.id), req.body, id(res))),
  );
  app.delete('/api/tasks/:id', (req, res) => {
    service.deleteTask(
      scalar(req.params.id),
      z.coerce.number().int().positive().parse(req.query.version),
      id(res),
    );
    res.status(204).end();
  });
  app.get('/api/runs', (req, res) => {
    const q = z
      .object({ projectId: z.string().uuid().optional(), taskId: z.string().uuid().optional() })
      .strict()
      .parse(req.query);
    res.json(service.runs(q.projectId, q.taskId));
  });
  app.get('/api/runs/:id', (req, res) => res.json(service.run(scalar(req.params.id))));
  app.post('/api/tasks/:id/runs', (req, res) => {
    const run = service.createRun(scalar(req.params.id), req.body, id(res), key(req));
    res.status(201).json(run);
    runner.tick();
  });
  app.post('/api/runs/:id/cancel', (req, res) => {
    const runId = scalar(req.params.id),
      run = service.cancelRun(runId, id(res));
    runner.cancel(runId);
    res.json(run);
  });
  const eventQuery = z
    .object({
      after: z.coerce.number().int().nonnegative().default(0),
      projectId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    })
    .strict();
  app.get('/api/events', (req, res) => {
    const q = eventQuery.parse(req.query);
    res.json(service.store.events(q.after, q.projectId, q.limit));
  });
  app.get('/api/events/stream', (req, res) => {
    const q = eventQuery.parse(req.query);
    const cursor = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(req.get('Last-Event-ID') ?? q.after);
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let last = cursor,
      closed = false;
    const send = (event: AuditEvent) => {
      if (closed || event.id <= last || (q.projectId && event.projectId !== q.projectId)) return;
      if (res.writableLength > 1024 * 1024) {
        cleanup();
        res.end();
        return;
      }
      res.write(`id: ${event.id}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
      last = event.id;
    };
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': heartbeat\n\n');
    }, 15000);
    const cleanup = () => {
      closed = true;
      clearInterval(heartbeat);
      service.store.changes.off('event', send);
    };
    req.on('close', cleanup);
    // The database and EventEmitter run on one JS thread; replay and subscribe have no await gap.
    service.store.changes.on('event', send);
    for (;;) {
      const batch = service.store.events(last, q.projectId, 500);
      for (const event of batch) send(event);
      if (closed || batch.length < 500) break;
    }
  });
  app.use('/api', (_req, _res, next) => next(new Problem(404, 'NOT_FOUND', 'API 不存在')));
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(staticDir, 'index.html')));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof Problem) {
      res.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: id(res),
        },
      });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: '请求参数不合法',
          details: error.issues,
          requestId: id(res),
        },
      });
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      res
        .status(400)
        .json({ error: { code: 'INVALID_JSON', message: 'JSON 格式不合法', requestId: id(res) } });
      return;
    }
    if (
      error &&
      typeof error === 'object' &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      res
        .status(413)
        .json({ error: { code: 'BODY_TOO_LARGE', message: '请求内容过大', requestId: id(res) } });
      return;
    }
    console.error(
      JSON.stringify({
        level: 'error',
        requestId: id(res),
        message: error instanceof Error ? error.message : 'unknown error',
      }),
    );
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用', requestId: id(res) } });
  });
  return app;
}

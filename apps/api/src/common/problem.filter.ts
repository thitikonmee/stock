import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '@stockos/shared';
import { toProblem } from './problem';

/** Every error leaves the API as `application/problem+json`. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = toProblem(exception, request.id);

    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, request_id: request.id, method: request.method, route: request.routeOptions.url },
        'unhandled error',
      );
    }

    void reply
      .status(problem.status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send(problem);
  }
}

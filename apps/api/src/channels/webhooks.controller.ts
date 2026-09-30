import { Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { channels } from '@stockos/core';
import { Public } from '../auth/decorators';
import { getRawBody } from '../common/raw-body';
import { API_BASE_URL } from '../tokens';

/** Marketplace push endpoint — see `channels.WebhookService` for the inbox pattern (docs/06 §21).
 *  `@Public()`: the platform calls this directly, proven only by its own signature, never our auth. */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    @Inject(channels.WebhookService) private readonly webhooks: channels.WebhookService,
    @Inject(API_BASE_URL) private readonly apiBaseUrl: string,
  ) {}

  @Public()
  @Post(':channelCode')
  @HttpCode(200)
  async receive(
    @Param('channelCode') channelCode: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const code = channelCode.toUpperCase() as channels.ChannelCode;
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(request.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    const result = await this.webhooks.handle(code, {
      rawBody: getRawBody(request),
      headers,
      // The platform signs against the fixed URL we registered with it, not whatever this
      // request's Host header happens to say (which a reverse proxy can rewrite) — see docs/06
      // §21's signature note; `apiBaseUrl` is the same origin `ChannelsController` builds the
      // OAuth redirect_uri from.
      url: `${this.apiBaseUrl}/api/v1/webhooks/${channelCode.toLowerCase()}`,
    });
    reply.status(result.httpStatus);
    return { outcome: result.outcome };
  }
}

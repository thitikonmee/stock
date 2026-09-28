import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorType = 'USER' | 'API_KEY' | 'SYSTEM' | 'PLATFORM_ADMIN' | 'POS_DEVICE' | 'CHANNEL';

export interface RequestContext {
  requestId: string;
  traceId?: string;
  tenantId?: string;
  /** For USER actors `id` is the user id; `membershipId` identifies them inside the tenant. */
  actor?: { type: ActorType; id?: string; membershipId?: string };
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

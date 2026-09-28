import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorType = 'USER' | 'API_KEY' | 'SYSTEM' | 'PLATFORM_ADMIN' | 'POS_DEVICE' | 'CHANNEL';

export interface RequestContext {
  requestId: string;
  traceId?: string;
  tenantId?: string;
  actor?: { type: ActorType; id?: string };
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

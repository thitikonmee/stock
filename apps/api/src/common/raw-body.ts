import type { FastifyRequest } from 'fastify';

/**
 * The exact JSON string Fastify received, before `JSON.parse` — a webhook signature is computed
 * over these exact bytes, and re-serializing `request.body` is not guaranteed to reproduce them
 * (key order, whitespace). Stashed by the custom content-type parser in `app.ts`; a WeakMap keyed
 * by request avoids adding an ad hoc property to Fastify's own request type.
 */
const rawBodies = new WeakMap<FastifyRequest, string>();

export function setRawBody(request: FastifyRequest, raw: string): void {
  rawBodies.set(request, raw);
}

export function getRawBody(request: FastifyRequest): string {
  return rawBodies.get(request) ?? '';
}

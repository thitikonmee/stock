/**
 * DI tokens. Always inject with `@Inject(TOKEN)` — never rely on emitDecoratorMetadata type
 * reflection, so the code behaves the same under tsc, esbuild (tests) and swc.
 */
export const DB = Symbol('DB');
export const LOGGER = Symbol('LOGGER');
export const READINESS_CHECK = Symbol('READINESS_CHECK');

/** Resolves when every hard dependency (database, later Redis) is reachable. */
export type ReadinessCheck = () => Promise<void>;

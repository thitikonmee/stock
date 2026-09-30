/**
 * DI tokens. Always inject with `@Inject(TOKEN)` — never rely on emitDecoratorMetadata type
 * reflection, so the code behaves the same under tsc, esbuild (tests) and swc.
 */
export const DB = Symbol('DB');
/** BYPASSRLS role — only for cross-tenant lookups (webhook shop_id -> tenant_id) before a tenantTx
 *  can even be opened. See channels.WebhookService's doc comment. */
export const PLATFORM_DB = Symbol('PLATFORM_DB');
export const LOGGER = Symbol('LOGGER');
export const READINESS_CHECK = Symbol('READINESS_CHECK');

/** Resolves when every hard dependency (database, later Redis) is reachable. */
export type ReadinessCheck = () => Promise<void>;
export const MAILER = Symbol('MAILER');
/** Public URL of the web app, used in e-mailed links. */
export const WEB_BASE_URL = Symbol('WEB_BASE_URL');
/** This API's own public URL — a marketplace's OAuth redirect must land back on it. */
export const API_BASE_URL = Symbol('API_BASE_URL');

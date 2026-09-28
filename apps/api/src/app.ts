import type { IncomingMessage } from 'node:http';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import { auth, billing, iam, notifications, tenancy } from '@stockos/core';
import { PgRateLimiter, type Db } from '@stockos/database';
import { uuidv7, type Logger } from '@stockos/shared';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { DEFAULT_RATE_LIMITS, RateLimitGuard, type RateLimits } from './auth/rate-limit.guard';
import { ProblemDetailsFilter } from './common/problem.filter';
import { RequestContextInterceptor } from './common/request-context.interceptor';
import { HealthController } from './health/health.controller';
import { BillingController, NotificationsController } from './iam/account.controllers';
import { ApiKeysController } from './iam/api-keys.controller';
import { MeController } from './iam/me.controller';
import { PermissionsController, RolesController } from './iam/roles.controller';
import { UsersController } from './iam/users.controller';
import { PosDeviceSessionController, PosDevicesController } from './org/devices.controller';
import { BranchesController, WarehousesController } from './org/org.controllers';
import { DB, LOGGER, MAILER, READINESS_CHECK, WEB_BASE_URL, type ReadinessCheck } from './tokens';

export interface AppDeps {
  db: Db;
  logger: Logger;
  auth: auth.AuthConfig;
  corsOrigins?: string[];
  /** Defaults to `select 1` against `db`. */
  readinessCheck?: ReadinessCheck;
  /** Per-IP limits for public endpoints; defaults to DEFAULT_RATE_LIMITS. */
  rateLimits?: Partial<RateLimits>;
  /** Outbound e-mail; defaults to an in-memory sender (nothing leaves the process). */
  mailer?: notifications.EmailSender;
  /** Public URL of the web app for e-mailed links. */
  webBaseUrl?: string;
  /** proxy-addr list of trusted proxies (default: loopback + private ranges). */
  trustProxy?: string;
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const routesByApp = new WeakMap<NestFastifyApplication, RegisteredRoute[]>();

/** Every HTTP route the app registered — used by tests that must cover all endpoints. */
export function registeredRoutes(app: NestFastifyApplication): readonly RegisteredRoute[] {
  return routesByApp.get(app) ?? [];
}

interface Services {
  authService: auth.AuthService;
  userService: auth.UserService;
  roleService: iam.RoleService;
  orgService: tenancy.OrgService;
  apiKeyService: auth.ApiKeyService;
  deviceService: tenancy.DeviceService;
  notificationService: notifications.NotificationService;
  planService: billing.PlanService;
}

@Module({})
class AppModule {
  static register(deps: AppDeps, services: Services): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        MeController,
        UsersController,
        RolesController,
        PermissionsController,
        BranchesController,
        WarehousesController,
        ApiKeysController,
        PosDevicesController,
        PosDeviceSessionController,
        NotificationsController,
        BillingController,
      ],
      providers: [
        { provide: DB, useValue: deps.db },
        { provide: LOGGER, useValue: deps.logger },
        { provide: MAILER, useValue: deps.mailer ?? new notifications.MemoryEmailSender() },
        { provide: WEB_BASE_URL, useValue: (deps.webBaseUrl ?? 'http://localhost:3100').replace(/\/$/, '') },
        {
          provide: READINESS_CHECK,
          useValue: deps.readinessCheck ?? (async () => void (await sql`select 1`.execute(deps.db))),
        },
        { provide: auth.AuthService, useValue: services.authService },
        { provide: auth.UserService, useValue: services.userService },
        { provide: iam.RoleService, useValue: services.roleService },
        { provide: tenancy.OrgService, useValue: services.orgService },
        { provide: auth.ApiKeyService, useValue: services.apiKeyService },
        { provide: tenancy.DeviceService, useValue: services.deviceService },
        { provide: notifications.NotificationService, useValue: services.notificationService },
        { provide: billing.PlanService, useValue: services.planService },
      ],
    };
  }
}

/** Build the HTTP app (used by main.ts and by tests via `app.inject`). */
export async function createApp(deps: AppDeps): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: 1_048_576,
    requestIdHeader: false,
    // Trust X-Forwarded-For only from our own hops (ALB, web BFF) on private/loopback addresses.
    // Addresses are read right-to-left, so a client cannot spoof its IP by prepending entries.
    trustProxy: deps.trustProxy ?? 'loopback,uniquelocal',
    // Accept a caller's X-Request-Id only if it is well-formed (prevents log injection).
    genReqId: (req: IncomingMessage) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && REQUEST_ID_RE.test(header) ? header : uuidv7();
    },
  });
  // Many clients send `Content-Type: application/json` with an empty body on POSTs like logout.
  // Treat that as "no body" instead of a 400; everything else goes through Fastify's own parser
  // (which keeps its __proto__/constructor poisoning protection).
  const fastify = adapter.getInstance();
  const defaultJsonParser = fastify.getDefaultJsonParser('error', 'error');
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === '' || (typeof body === 'string' && body.trim() === '')) return done(null, undefined);
    defaultJsonParser(request, body as string, done);
  });

  const routes: RegisteredRoute[] = [];
  adapter.getInstance().addHook('onRoute', (route) => {
    for (const method of [route.method].flat())
      if (method !== 'HEAD') routes.push({ method, url: route.url });
  });

  const roleService = new iam.RoleService();
  const authService = new auth.AuthService(deps.db, deps.auth);
  const services: Services = {
    authService,
    roleService,
    userService: new auth.UserService(deps.db, roleService, authService, deps.auth.hasher),
    orgService: new tenancy.OrgService(),
    apiKeyService: new auth.ApiKeyService(deps.db),
    deviceService: new tenancy.DeviceService(deps.db),
    notificationService: new notifications.NotificationService(),
    planService: new billing.PlanService(),
  };

  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(deps, services), adapter, {
    bodyParser: false, // body parsing is configured on the Fastify instance above
    logger: ['error', 'warn'],
  });
  routesByApp.set(app, routes);

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (request, reply) => {
      void reply.header('x-request-id', request.id);
    });

  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready'] });
  app.useGlobalFilters(new ProblemDetailsFilter(deps.logger));
  const reflector = app.get(Reflector);
  const limiter = new PgRateLimiter(deps.db);
  app.useGlobalGuards(
    new RateLimitGuard(reflector, limiter, { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits }),
    new AuthGuard(
      reflector,
      authService,
      services.apiKeyService,
      services.deviceService,
      deps.auth.stepUpMaxAgeSec,
      limiter,
    ),
  );
  app.useGlobalInterceptors(new RequestContextInterceptor());
  if (deps.corsOrigins?.length) app.enableCors({ origin: deps.corsOrigins, credentials: true });

  await app.init();
  return app;
}

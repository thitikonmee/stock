import type { IncomingMessage } from 'node:http';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import {
  auth,
  billing,
  catalog,
  channels,
  customers,
  iam,
  inventory,
  notifications,
  orders,
  pos,
  purchasing,
  tenancy,
} from '@stockos/core';
import { PgRateLimiter, type Db } from '@stockos/database';
import { uuidv7, type Logger } from '@stockos/shared';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { DEFAULT_RATE_LIMITS, RateLimitGuard, type RateLimits } from './auth/rate-limit.guard';
import { BarcodesController } from './catalog/barcodes.controller';
import { ImagesController } from './catalog/images.controller';
import { JobsController } from './catalog/jobs.controller';
import { BrandsController, CategoriesController, UnitsController } from './catalog/master-data.controller';
import { PriceListsController } from './catalog/prices.controller';
import { ProductsController } from './catalog/products.controller';
import { SuppliersController } from './catalog/suppliers.controller';
import { VariantsController } from './catalog/variants.controller';
import { ProblemDetailsFilter } from './common/problem.filter';
import { CustomersController } from './customers/customers.controller';
import { RequestContextInterceptor } from './common/request-context.interceptor';
import { setRawBody } from './common/raw-body';
import {
  ChannelAccountsController,
  ChannelMappingsController,
  ChannelReconciliationController,
  ChannelStockPoliciesController,
  ChannelsController,
} from './channels/channels.controller';
import { WebhooksController } from './channels/webhooks.controller';
import { ChannelAllocationsController } from './channels/allocations.controller';
import { HealthController } from './health/health.controller';
import { BillingController, NotificationsController } from './iam/account.controllers';
import { ApiKeysController } from './iam/api-keys.controller';
import { MeController } from './iam/me.controller';
import { PermissionsController, RolesController } from './iam/roles.controller';
import { UsersController } from './iam/users.controller';
import { AdjustmentsController } from './inventory/adjustments.controller';
import { InventoryQueryController } from './inventory/query.controller';
import { ReceivingController } from './inventory/receiving.controller';
import { ReconciliationController } from './inventory/reconciliation.controller';
import { ReservationsController } from './inventory/reservations.controller';
import { TransfersController } from './inventory/transfers.controller';
import { CountsController } from './inventory/counts.controller';
import { LocationsController } from './inventory/locations.controller';
import { PosDeviceSessionController, PosDevicesController } from './org/devices.controller';
import { BranchesController, WarehousesController } from './org/org.controllers';
import { FulfillmentsController, ReturnsController } from './orders/fulfillments.controller';
import { OrdersController } from './orders/orders.controller';
import { PosSessionsController } from './pos/sessions.controller';
import { ShiftsController } from './pos/shifts.controller';
import { SalesController } from './pos/sales.controller';
import { PurchasesController, SupplierPerformanceController } from './purchasing/purchases.controller';
import {
  API_BASE_URL,
  DB,
  LOGGER,
  MAILER,
  PLATFORM_DB,
  READINESS_CHECK,
  WEB_BASE_URL,
  type ReadinessCheck,
} from './tokens';

export interface AppDeps {
  db: Db;
  /** BYPASSRLS role, for the webhook gateway's shop_id -> tenant_id lookup. Defaults to `db`
   *  (fine for tests/dev where the app role already has the rows visible via RLS-off paths it
   *  doesn't use; real deploys must pass the actual `stockos_platform` connection). */
  platformDb?: Db;
  logger: Logger;
  auth: auth.AuthConfig;
  /** Shopee Open Platform partner credentials; omit to leave the SHOPEE adapter unregistered. */
  shopee?: channels.ShopeeConfig;
  /** Lazada Open Platform app credentials; omit to leave the LAZADA adapter unregistered. */
  lazada?: channels.LazadaConfig;
  /** TikTok Shop Partner Center app credentials; omit to leave the TIKTOK adapter unregistered. */
  tiktok?: channels.TikTokConfig;
  corsOrigins?: string[];
  /** Defaults to `select 1` against `db`. */
  readinessCheck?: ReadinessCheck;
  /** Per-IP limits for public endpoints; defaults to DEFAULT_RATE_LIMITS. */
  rateLimits?: Partial<RateLimits>;
  /** Outbound e-mail; defaults to an in-memory sender (nothing leaves the process). */
  mailer?: notifications.EmailSender;
  /** Public URL of the web app for e-mailed links. */
  webBaseUrl?: string;
  /** This API's own public URL — a marketplace's OAuth redirect must land back on it. */
  apiBaseUrl?: string;
  /** proxy-addr list of trusted proxies (default: loopback + private ranges). */
  trustProxy?: string;
  /** Where product images are stored; defaults to a local `.uploads` directory (no S3 needed). */
  storage?: catalog.StorageConfig;
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
  catalogMasterDataService: catalog.CatalogMasterDataService;
  productService: catalog.ProductService;
  imageService: catalog.ImageService;
  supplierService: catalog.SupplierService;
  priceService: catalog.PriceService;
  importExportService: catalog.ImportExportService;
  inventoryQueryService: inventory.InventoryQueryService;
  reservationService: inventory.ReservationService;
  adjustmentService: inventory.AdjustmentService;
  purchaseService: purchasing.PurchaseService;
  transferService: inventory.TransferService;
  countService: inventory.CountService;
  locationService: inventory.LocationService;
  allocationService: channels.AllocationService;
  receivingService: inventory.ReceivingService;
  reconciliationService: inventory.ReconciliationService;
  posPinService: iam.PosPinService;
  customerService: customers.CustomerService;
  cashierSessionService: pos.CashierSessionService;
  shiftService: pos.ShiftService;
  saleService: pos.SaleService;
  refundService: pos.RefundService;
  orderService: orders.OrderService;
  fulfillmentService: orders.FulfillmentService;
  returnService: orders.ReturnService;
  orderRefundService: orders.RefundService;
  channelAccountService: channels.ChannelAccountService;
  mappingService: channels.MappingService;
  stockSyncService: channels.StockSyncService;
  stockPolicyService: channels.StockPolicyService;
  reconciliationServiceChannels: channels.ReconciliationService;
  webhookService: channels.WebhookService;
  webhookQueryService: channels.WebhookQueryService;
  syncJobService: channels.SyncJobService;
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
        BrandsController,
        CategoriesController,
        UnitsController,
        ProductsController,
        VariantsController,
        BarcodesController,
        ImagesController,
        JobsController,
        SuppliersController,
        PriceListsController,
        InventoryQueryController,
        ReservationsController,
        AdjustmentsController,
        ReceivingController,
        ReconciliationController,
        PurchasesController,
        TransfersController,
        CountsController,
        LocationsController,
        ChannelAllocationsController,
        SupplierPerformanceController,
        CustomersController,
        PosSessionsController,
        ShiftsController,
        SalesController,
        OrdersController,
        FulfillmentsController,
        ReturnsController,
        ChannelsController,
        ChannelAccountsController,
        ChannelMappingsController,
        ChannelStockPoliciesController,
        ChannelReconciliationController,
        WebhooksController,
      ],
      providers: [
        { provide: DB, useValue: deps.db },
        { provide: PLATFORM_DB, useValue: deps.platformDb ?? deps.db },
        { provide: LOGGER, useValue: deps.logger },
        { provide: MAILER, useValue: deps.mailer ?? new notifications.MemoryEmailSender() },
        { provide: WEB_BASE_URL, useValue: (deps.webBaseUrl ?? 'http://localhost:3100').replace(/\/$/, '') },
        { provide: API_BASE_URL, useValue: (deps.apiBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '') },
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
        { provide: catalog.CatalogMasterDataService, useValue: services.catalogMasterDataService },
        { provide: catalog.ProductService, useValue: services.productService },
        { provide: catalog.ImageService, useValue: services.imageService },
        { provide: catalog.SupplierService, useValue: services.supplierService },
        { provide: catalog.PriceService, useValue: services.priceService },
        { provide: catalog.ImportExportService, useValue: services.importExportService },
        { provide: inventory.InventoryQueryService, useValue: services.inventoryQueryService },
        { provide: inventory.ReservationService, useValue: services.reservationService },
        { provide: inventory.AdjustmentService, useValue: services.adjustmentService },
        { provide: purchasing.PurchaseService, useValue: services.purchaseService },
        { provide: inventory.TransferService, useValue: services.transferService },
        { provide: inventory.CountService, useValue: services.countService },
        { provide: inventory.LocationService, useValue: services.locationService },
        { provide: channels.AllocationService, useValue: services.allocationService },
        { provide: inventory.ReceivingService, useValue: services.receivingService },
        { provide: inventory.ReconciliationService, useValue: services.reconciliationService },
        { provide: iam.PosPinService, useValue: services.posPinService },
        { provide: customers.CustomerService, useValue: services.customerService },
        { provide: pos.CashierSessionService, useValue: services.cashierSessionService },
        { provide: pos.ShiftService, useValue: services.shiftService },
        { provide: pos.SaleService, useValue: services.saleService },
        { provide: pos.RefundService, useValue: services.refundService },
        { provide: orders.OrderService, useValue: services.orderService },
        { provide: orders.FulfillmentService, useValue: services.fulfillmentService },
        { provide: orders.ReturnService, useValue: services.returnService },
        { provide: orders.RefundService, useValue: services.orderRefundService },
        { provide: channels.ChannelAccountService, useValue: services.channelAccountService },
        { provide: channels.MappingService, useValue: services.mappingService },
        { provide: channels.StockSyncService, useValue: services.stockSyncService },
        { provide: channels.StockPolicyService, useValue: services.stockPolicyService },
        { provide: channels.ReconciliationService, useValue: services.reconciliationServiceChannels },
        { provide: channels.WebhookService, useValue: services.webhookService },
        { provide: channels.WebhookQueryService, useValue: services.webhookQueryService },
        { provide: channels.SyncJobService, useValue: services.syncJobService },
      ],
    };
  }
}

/** Build the HTTP app (used by main.ts and by tests via `app.inject`). */
export async function createApp(deps: AppDeps): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    // 15MB: covers a base64 product photo (≤5MB decoded) and a multi-thousand-row xlsx import,
    // behind auth + rate limiting. Still bounded — never unlimited.
    bodyLimit: 15_728_640,
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
    // Stashed before parsing: a webhook signature is computed over these exact bytes (see
    // common/raw-body.ts) — re-serializing the parsed object would not reliably reproduce them.
    if (typeof body === 'string') setRawBody(request, body);
    if (body === '' || (typeof body === 'string' && body.trim() === '')) return done(null, undefined);
    defaultJsonParser(request, body as string, done);
  });
  // Raw binary bodies (product catalog xlsx import): no JSON/multipart parsing, just the bytes.
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 15_728_640 },
    (_request, body, done) => done(null, body),
  );

  const routes: RegisteredRoute[] = [];
  adapter.getInstance().addHook('onRoute', (route) => {
    for (const method of [route.method].flat())
      if (method !== 'HEAD') routes.push({ method, url: route.url });
  });

  const roleService = new iam.RoleService();
  const authService = new auth.AuthService(deps.db, deps.auth);
  const productService = new catalog.ProductService();
  const priceService = new catalog.PriceService();
  const imageStorage = catalog.createImageStorage(deps.storage);
  const deviceService = new tenancy.DeviceService(deps.db);
  const posPinService = new iam.PosPinService(deps.db);
  const shiftService = new pos.ShiftService(deviceService);
  const reservationService = new inventory.ReservationService();
  const notificationService = new notifications.NotificationService();
  const inventoryQueryService = new inventory.InventoryQueryService();
  const orderService = new orders.OrderService(productService, priceService, reservationService);
  const fulfillmentService = new orders.FulfillmentService(reservationService);

  const channelRegistry = new channels.AdapterRegistry();
  if (deps.shopee) channelRegistry.register(new channels.ShopeeAdapter(deps.shopee));
  if (deps.lazada) channelRegistry.register(new channels.LazadaAdapter(deps.lazada));
  if (deps.tiktok) channelRegistry.register(new channels.TikTokAdapter(deps.tiktok));
  const channelVault = new channels.CredentialVault(deps.auth.secretBox);
  const channelTokens = new channels.TokenManager(channelRegistry, channelVault);
  const channelPolicies = new channels.StockPolicyService();
  const orderIngestService = new channels.OrderIngestService(
    reservationService,
    orderService,
    fulfillmentService,
    notificationService,
  );

  const services: Services = {
    authService,
    roleService,
    userService: new auth.UserService(deps.db, roleService, authService, deps.auth.hasher),
    orgService: new tenancy.OrgService(),
    apiKeyService: new auth.ApiKeyService(deps.db),
    deviceService,
    notificationService,
    planService: new billing.PlanService(),
    catalogMasterDataService: new catalog.CatalogMasterDataService(),
    productService,
    imageService: new catalog.ImageService(imageStorage),
    supplierService: new catalog.SupplierService(),
    priceService,
    importExportService: new catalog.ImportExportService(productService),
    inventoryQueryService,
    reservationService,
    adjustmentService: new inventory.AdjustmentService(),
    purchaseService: new purchasing.PurchaseService(),
    transferService: new inventory.TransferService(),
    countService: new inventory.CountService(),
    locationService: new inventory.LocationService(),
    allocationService: new channels.AllocationService(),
    receivingService: new inventory.ReceivingService(),
    reconciliationService: new inventory.ReconciliationService(),
    posPinService,
    customerService: new customers.CustomerService(),
    cashierSessionService: new pos.CashierSessionService(posPinService, authService),
    shiftService,
    saleService: new pos.SaleService(
      productService,
      priceService,
      shiftService,
      posPinService,
      deviceService,
    ),
    refundService: new pos.RefundService(posPinService, shiftService),
    orderService,
    fulfillmentService,
    returnService: new orders.ReturnService(),
    orderRefundService: new orders.RefundService(),
    channelAccountService: new channels.ChannelAccountService(
      channelRegistry,
      channelVault,
      deps.auth.secretBox,
    ),
    mappingService: new channels.MappingService(channelRegistry, channelTokens, productService),
    stockSyncService: new channels.StockSyncService(
      channelRegistry,
      channelTokens,
      inventoryQueryService,
      channelPolicies,
    ),
    stockPolicyService: channelPolicies,
    reconciliationServiceChannels: new channels.ReconciliationService(
      channelRegistry,
      channelTokens,
      inventoryQueryService,
      channelPolicies,
    ),
    webhookService: new channels.WebhookService(
      channelRegistry,
      channelTokens,
      orderIngestService,
      deps.db,
      deps.platformDb ?? deps.db,
    ),
    webhookQueryService: new channels.WebhookQueryService(),
    syncJobService: new channels.SyncJobService(channelRegistry, channelTokens, orderIngestService),
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

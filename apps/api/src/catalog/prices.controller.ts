import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { catalog, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const PriceListCreate = z.strictObject({
  code: z.string().trim().toUpperCase().max(20),
  name: z.string().trim().min(1).max(120),
  channelCode: z.string().trim().max(20).nullable().optional(),
  priceIncludesTax: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  isDefault: z.boolean().optional(),
});
const SetPrice = z.strictObject({ variantId: z.string(), price: z.string() });

@Controller('price-lists')
export class PriceListsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(catalog.PriceService) private readonly prices: catalog.PriceService,
  ) {}

  @RequirePermission('price.read')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.prices.listLists(tx, p));
  }

  @RequirePermission('price.manage')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = defined(parse(PriceListCreate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.prices.createList(tx, p, input));
  }

  @RequirePermission('price.read')
  @Get(':id/prices')
  listPrices(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.prices.listPrices(tx, p, id));
  }

  @RequirePermission('price.manage')
  @Put(':id/prices')
  setPrice(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(SetPrice, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.prices.setPrice(tx, p, id, input));
  }
}

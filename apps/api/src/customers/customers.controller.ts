import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { customers, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const CreateBody = z.strictObject({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(320).optional(),
});

/** Minimal customer directory for POS "quick-add" (docs/05-pos.md §15). */
@Controller('customers')
export class CustomersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(customers.CustomerService) private readonly customerService: customers.CustomerService,
  ) {}

  @RequirePermission('customer.manage')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(CreateBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.customerService.create(tx, p, input));
  }

  @RequirePermission('customer.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.customerService.get(tx, p, id));
  }

  @RequirePermission('customer.read')
  @Get()
  search(@CurrentPrincipal() p: iam.Principal, @Query('q') q = '') {
    return tenantTx(this.db, p.tenantId, (tx) => this.customerService.search(tx, p, q));
  }
}

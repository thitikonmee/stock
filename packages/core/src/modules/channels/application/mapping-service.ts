import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { NotFoundError, uuidv7 } from '@stockos/shared';
import { assertCan, systemPrincipal, type Principal } from '../../iam/public-api';
import type { ProductService } from '../../catalog/public-api';
import type { AdapterRegistry } from './adapter-registry';
import type { TokenManager } from './token-manager';
import type { ChannelProductVariantRow, ConfirmMappingInput } from '../domain/types';
import { loadChannelAccount } from './account-repository';

/**
 * Imports a shop's listings and maps each external SKU (Shopee model / Lazada SkuId / ...) to an
 * internal variant — the "★ SKU MAPPING" row in `channel_product_variants` (docs/06 §17 Mapping).
 * Auto-map matches on exact SKU text; anything else needs a human via `confirmMapping`.
 */
export class MappingService {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly tokens: TokenManager,
    private readonly products: ProductService,
  ) {}

  async importProducts(
    tx: Tx,
    principal: Principal,
    channelAccountId: string,
  ): Promise<{ imported: number; autoMapped: number }> {
    assertCan(principal, 'channel.mapping');
    const account = await loadChannelAccount(tx, channelAccountId);
    if (!account) throw new NotFoundError('Channel account not found');
    const adapter = this.registry.get(account.channelCode);
    const accountRef = {
      tenantId: principal.tenantId,
      channelAccountId,
      externalShopId: account.externalShopId,
    };
    const accessToken = await this.tokens.getValidAccessToken(tx, accountRef, account.channelCode);

    let imported = 0;
    let autoMapped = 0;
    let cursor: string | undefined;
    do {
      const page = await adapter.listProducts(accountRef, accessToken, cursor);
      for (const product of page.data) {
        const productId = await this.upsertChannelProduct(tx, principal.tenantId, channelAccountId, product);
        for (const variant of product.variants) {
          const mapped = await this.upsertVariantRow(
            tx,
            principal.tenantId,
            channelAccountId,
            productId,
            variant,
          );
          imported++;
          if (mapped) autoMapped++;
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { imported, autoMapped };
  }

  async list(
    tx: Tx,
    principal: Principal,
    channelAccountId: string,
    filter: { status?: string } = {},
  ): Promise<ChannelProductVariantRow[]> {
    assertCan(principal, 'channel.mapping');
    if (!(await loadChannelAccount(tx, channelAccountId)))
      throw new NotFoundError('Channel account not found');
    const { rows } = await sql<Row>`
      select cpv.id, cpv.channel_account_id, cpv.channel_product_id, cpv.external_item_id, cpv.external_variant_id,
             cpv.external_sku, cp.title as product_title, cpv.variant_id, pv.sku, cpv.quantity_multiplier,
             cpv.mapping_status, cpv.mapping_method, cpv.sync_stock, cpv.last_pushed_qty, cpv.last_pushed_at,
             cpv.last_channel_qty, cpv.updated_at
        from channel_product_variants cpv
        join channel_products cp on cp.id = cpv.channel_product_id
        left join product_variants pv on pv.id = cpv.variant_id
       where cpv.channel_account_id = ${channelAccountId}
         and (${filter.status ?? null}::text is null or cpv.mapping_status = ${filter.status ?? null})
       order by cpv.updated_at desc`.execute(tx);
    return rows.map(toRow);
  }

  async confirmMapping(
    tx: Tx,
    principal: Principal,
    input: ConfirmMappingInput,
  ): Promise<ChannelProductVariantRow> {
    assertCan(principal, 'channel.mapping');
    if (input.variantId) {
      await this.products.getVariant(tx, principal, input.variantId); // 404s if it doesn't belong to this tenant
    }
    const status = input.variantId ? 'CONFIRMED' : 'UNMAPPED';
    const { rows } = await sql<{ id: string }>`
      update channel_product_variants
         set variant_id = ${input.variantId}, mapping_status = ${status}, mapping_method = 'MANUAL',
             updated_by = ${principal.membershipId}, updated_at = now()
       where id = ${input.channelProductVariantId}
       returning id`.execute(tx);
    if (rows.length === 0) throw new NotFoundError('Mapping row not found');
    const { rows: full } = await sql<Row>`
      select cpv.id, cpv.channel_account_id, cpv.channel_product_id, cpv.external_item_id, cpv.external_variant_id,
             cpv.external_sku, cp.title as product_title, cpv.variant_id, pv.sku, cpv.quantity_multiplier,
             cpv.mapping_status, cpv.mapping_method, cpv.sync_stock, cpv.last_pushed_qty, cpv.last_pushed_at,
             cpv.last_channel_qty, cpv.updated_at
        from channel_product_variants cpv
        join channel_products cp on cp.id = cpv.channel_product_id
        left join product_variants pv on pv.id = cpv.variant_id
       where cpv.id = ${input.channelProductVariantId}`.execute(tx);
    return toRow(full[0]!);
  }

  // ---------------------------------------------------------------- helpers

  private async upsertChannelProduct(
    tx: Tx,
    tenantId: string,
    channelAccountId: string,
    product: { externalItemId: string; title: string; status: string; raw: unknown },
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into channel_products (tenant_id, id, channel_account_id, external_item_id, title, status, raw, last_synced_at)
      values (${tenantId}, ${uuidv7()}, ${channelAccountId}, ${product.externalItemId}, ${product.title},
              ${product.status}, ${JSON.stringify(product.raw)}::jsonb, now())
      on conflict (tenant_id, channel_account_id, external_item_id) do update set
        title = excluded.title, status = excluded.status, raw = excluded.raw, last_synced_at = now()
      returning id`.execute(tx);
    return rows[0]!.id;
  }

  private async upsertVariantRow(
    tx: Tx,
    tenantId: string,
    channelAccountId: string,
    channelProductId: string,
    variant: { externalItemId: string; externalVariantId: string; externalSku: string | null; stock: string },
  ): Promise<boolean> {
    let variantId: string | null = null;
    let method: string | null = null;
    if (variant.externalSku) {
      try {
        // Read-only catalog lookup during import, no acting user behind it — see
        // `iam.systemPrincipal`'s doc comment for why this exists.
        const reader = systemPrincipal(tenantId, ['product.read']);
        const found = await this.products.lookup(tx, reader, { sku: variant.externalSku });
        variantId = found.id;
        method = 'SKU_MATCH';
      } catch {
        // no internal SKU matches — stays UNMAPPED for a human to resolve
      }
    }
    const status = variantId ? 'AUTO_MAPPED' : 'UNMAPPED';
    const { rows } = await sql<{ mapping_status: string; variant_id: string | null }>`
      insert into channel_product_variants (tenant_id, id, channel_account_id, channel_product_id, external_item_id,
                                            external_variant_id, external_sku, variant_id, mapping_status,
                                            mapping_method, last_channel_qty, last_channel_read_at)
      values (${tenantId}, ${uuidv7()}, ${channelAccountId}, ${channelProductId}, ${variant.externalItemId},
              ${variant.externalVariantId}, ${variant.externalSku}, ${variantId}, ${status}, ${method},
              ${variant.stock}, now())
      on conflict (tenant_id, channel_account_id, external_item_id, external_variant_id) do update set
        external_sku = excluded.external_sku, last_channel_qty = excluded.last_channel_qty,
        last_channel_read_at = now(),
        -- never clobber a human's CONFIRMED/CONFLICT/BROKEN decision on re-import
        variant_id = case when channel_product_variants.mapping_status in ('UNMAPPED','AUTO_MAPPED')
                          then excluded.variant_id else channel_product_variants.variant_id end,
        mapping_status = case when channel_product_variants.mapping_status in ('UNMAPPED','AUTO_MAPPED')
                              then excluded.mapping_status else channel_product_variants.mapping_status end
      returning mapping_status, variant_id`.execute(tx);
    return rows[0]?.mapping_status === 'AUTO_MAPPED';
  }
}

interface Row {
  id: string;
  channel_account_id: string;
  channel_product_id: string;
  external_item_id: string;
  external_variant_id: string;
  external_sku: string | null;
  product_title: string | null;
  variant_id: string | null;
  sku: string | null;
  quantity_multiplier: string;
  mapping_status: ChannelProductVariantRow['mappingStatus'];
  mapping_method: string | null;
  sync_stock: boolean;
  last_pushed_qty: string | null;
  last_pushed_at: Date | null;
  last_channel_qty: string | null;
  updated_at: Date;
}
function toRow(r: Row): ChannelProductVariantRow {
  return {
    id: r.id,
    channelAccountId: r.channel_account_id,
    channelProductId: r.channel_product_id,
    externalItemId: r.external_item_id,
    externalVariantId: r.external_variant_id,
    externalSku: r.external_sku,
    productTitle: r.product_title,
    variantId: r.variant_id,
    sku: r.sku,
    quantityMultiplier: r.quantity_multiplier,
    mappingStatus: r.mapping_status,
    mappingMethod: r.mapping_method,
    syncStock: r.sync_stock,
    lastPushedQty: r.last_pushed_qty,
    lastPushedAt: r.last_pushed_at?.toISOString() ?? null,
    lastChannelQty: r.last_channel_qty,
    updatedAt: r.updated_at.toISOString(),
  };
}

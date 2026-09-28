import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { NotFoundError, ValidationError, isUuid, uuidv7 } from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import { assertImageUpload, imageKey, type ImageStorage } from '../infrastructure/storage';

export interface ProductImage {
  id: string;
  productId: string;
  variantId: string | null;
  sortOrder: number;
  contentType: string;
  sizeBytes: number;
  altText: string | null;
}

/** Product/variant photos: bytes live in `ImageStorage` (S3 or local disk); this row is the pointer. */
export class ImageService {
  constructor(private readonly storage: ImageStorage) {}

  async list(tx: Tx, principal: Principal, productId: string): Promise<ProductImage[]> {
    assertCan(principal, 'product.read');
    const { rows: productRows } =
      await sql`select 1 from products where id = ${productId} and deleted_at is null`.execute(tx);
    if (productRows.length === 0) throw new NotFoundError('Product not found');
    const { rows } = await sql<ImageRow>`
      select ${cols} from product_images where product_id = ${productId} order by sort_order, created_at`.execute(
      tx,
    );
    return rows.map(toImage);
  }

  async upload(
    tx: Tx,
    principal: Principal,
    productId: string,
    input: { data: Buffer; contentType: string; variantId?: string | null; altText?: string | null },
  ): Promise<ProductImage> {
    assertCan(principal, 'product.update');
    assertImageUpload(input.contentType, input.data.byteLength);
    const { rows: productRows } =
      await sql`select 1 from products where id = ${productId} and deleted_at is null`.execute(tx);
    if (productRows.length === 0) throw new NotFoundError('Product not found');
    if (input.variantId) {
      const { rows } =
        await sql`select 1 from product_variants where id = ${input.variantId} and product_id = ${productId}`.execute(
          tx,
        );
      if (rows.length === 0) throw new ValidationError('Variant does not belong to this product');
    }

    const key = imageKey(principal.tenantId, productId, input.data, input.contentType);
    const stored = await this.storage.put(key, input.data, input.contentType);
    const { rows: maxRow } = await sql<{ n: number }>`
      select coalesce(max(sort_order), -1) + 1 as n from product_images where product_id = ${productId}`.execute(
      tx,
    );
    const id = uuidv7();
    await sql`insert into product_images (tenant_id, id, product_id, variant_id, storage_key, sort_order,
                                          content_type, size_bytes, alt_text, created_by)
              values (${principal.tenantId}, ${id}, ${productId}, ${input.variantId ?? null}, ${stored.key},
                      ${maxRow[0]!.n}, ${stored.contentType}, ${stored.sizeBytes}, ${input.altText ?? null},
                      ${principal.membershipId})`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'product.image.upload',
      resourceType: 'product_image',
      resourceId: id,
      after: { productId, sizeBytes: stored.sizeBytes, contentType: stored.contentType },
    });
    return this.getOrThrow(tx, id);
  }

  async remove(tx: Tx, principal: Principal, id: string): Promise<void> {
    assertCan(principal, 'product.update');
    const { rows } = await sql<{ storage_key: string; product_id: string }>`
      select storage_key, product_id from product_images where id = ${id}`.execute(tx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Image not found');
    await sql`delete from product_images where id = ${id}`.execute(tx);
    await this.storage.delete(row.storage_key);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'product.image.delete',
      resourceType: 'product_image',
      resourceId: id,
      before: { productId: row.product_id },
    });
  }

  /** Streams the raw bytes for a tenant-scoped download endpoint. RLS already limits `id` to the tenant. */
  async read(tx: Tx, principal: Principal, id: string): Promise<{ data: Buffer; contentType: string }> {
    assertCan(principal, 'product.read');
    if (!isUuid(id)) throw new NotFoundError('Image not found');
    const { rows } = await sql<{
      storage_key: string;
    }>`select storage_key from product_images where id = ${id}`.execute(tx);
    const key = rows[0]?.storage_key;
    if (!key) throw new NotFoundError('Image not found');
    return this.storage.get(key);
  }

  private async getOrThrow(tx: Tx, id: string): Promise<ProductImage> {
    const { rows } = await sql<ImageRow>`select ${cols} from product_images where id = ${id}`.execute(tx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Image not found');
    return toImage(row);
  }
}

interface ImageRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  sort_order: number;
  content_type: string;
  size_bytes: string | number;
  alt_text: string | null;
}
const cols = sql`id, product_id, variant_id, sort_order, content_type, size_bytes, alt_text`;
const toImage = (r: ImageRow): ProductImage => ({
  id: r.id,
  productId: r.product_id,
  variantId: r.variant_id,
  sortOrder: r.sort_order,
  contentType: r.content_type,
  sizeBytes: Number(r.size_bytes),
  altText: r.alt_text,
});

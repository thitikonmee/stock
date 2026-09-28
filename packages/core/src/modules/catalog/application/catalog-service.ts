import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, type Tx } from '@stockos/database';
import { ConflictError, NotFoundError, ValidationError, isUuid, uuidv7 } from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';

export interface Brand {
  id: string;
  name: string;
  isActive: boolean;
}
export interface BrandInput {
  name: string;
  isActive?: boolean;
}

export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  sortOrder: number;
}
export interface CategoryInput {
  parentId?: string | null;
  name: string;
  sortOrder?: number;
}

export interface Unit {
  id: string;
  code: string;
  name: string;
  allowDecimal: boolean;
}
export interface UnitInput {
  code: string;
  name: string;
  allowDecimal?: boolean;
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;

/**
 * Catalog master data: brands, the category tree (materialized path) and units.
 * Reads: `product.read`. Writes: `product.create` (new) / `product.update` (edit).
 */
export class CatalogMasterDataService {
  // --- Brands ---------------------------------------------------------------
  async listBrands(tx: Tx, principal: Principal): Promise<Brand[]> {
    assertCan(principal, 'product.read');
    const { rows } = await sql<BrandRow>`select id, name, is_active from brands order by name`.execute(tx);
    return rows.map(toBrand);
  }

  async createBrand(tx: Tx, principal: Principal, input: BrandInput): Promise<Brand> {
    assertCan(principal, 'product.create');
    const name = requireName(input.name);
    const id = uuidv7();
    await unique(`Brand "${name}" already exists`, () =>
      sql`insert into brands (tenant_id, id, name, is_active) values (${principal.tenantId}, ${id}, ${name}, ${input.isActive ?? true})`.execute(
        tx,
      ),
    );
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'brand.create',
      resourceType: 'brand',
      resourceId: id,
      after: { name },
    });
    return this.getBrand(tx, id);
  }

  async updateBrand(tx: Tx, principal: Principal, id: string, input: Partial<BrandInput>): Promise<Brand> {
    assertCan(principal, 'product.update');
    const before = await this.getBrand(tx, id);
    const name = input.name !== undefined ? requireName(input.name) : undefined;
    await unique(`Brand "${name ?? ''}" already exists`, () =>
      sql`update brands set name = coalesce(${name ?? null}, name), is_active = coalesce(${input.isActive ?? null}, is_active)
           where id = ${id}`.execute(tx),
    );
    const after = await this.getBrand(tx, id);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'brand.update',
      resourceType: 'brand',
      resourceId: id,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  async getBrand(tx: Tx, id: string): Promise<Brand> {
    const row = isUuid(id)
      ? (await sql<BrandRow>`select id, name, is_active from brands where id = ${id}`.execute(tx)).rows[0]
      : undefined;
    if (!row) throw new NotFoundError('Brand not found');
    return toBrand(row);
  }

  // --- Categories (materialized path tree) -----------------------------------
  async listCategories(tx: Tx, principal: Principal): Promise<Category[]> {
    assertCan(principal, 'product.read');
    const { rows } = await sql<CategoryRow>`
      select id, parent_id, name, path, sort_order from categories order by path`.execute(tx);
    return rows.map(toCategory);
  }

  async getCategory(tx: Tx, id: string): Promise<Category> {
    const row = isUuid(id)
      ? (
          await sql<CategoryRow>`select id, parent_id, name, path, sort_order from categories where id = ${id}`.execute(
            tx,
          )
        ).rows[0]
      : undefined;
    if (!row) throw new NotFoundError('Category not found');
    return toCategory(row);
  }

  async createCategory(tx: Tx, principal: Principal, input: CategoryInput): Promise<Category> {
    assertCan(principal, 'product.create');
    const name = requireName(input.name);
    const slug = slugify(name);
    let path = `/${slug}/`;
    if (input.parentId) {
      const parent = await this.getCategory(tx, input.parentId);
      path = `${parent.path}${slug}/`;
    }
    const id = uuidv7();
    await unique('A category with this name already exists under the same parent', () =>
      sql`insert into categories (tenant_id, id, parent_id, name, path, sort_order)
          values (${principal.tenantId}, ${id}, ${input.parentId ?? null}, ${name}, ${path}, ${input.sortOrder ?? 0})`.execute(
        tx,
      ),
    );
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'category.create',
      resourceType: 'category',
      resourceId: id,
      after: { name, parentId: input.parentId ?? null, path },
    });
    return this.getCategory(tx, id);
  }

  async updateCategory(
    tx: Tx,
    principal: Principal,
    id: string,
    input: { name?: string; sortOrder?: number },
  ): Promise<Category> {
    assertCan(principal, 'product.update');
    const before = await this.getCategory(tx, id);
    const name = input.name !== undefined ? requireName(input.name) : undefined;
    if (name !== undefined) {
      // Renaming updates this node's path and every descendant's path (both stay consistent).
      const parentPath = before.path.slice(0, before.path.length - (slugify(before.name).length + 1));
      const newSlug = slugify(name);
      const newPath = `${parentPath}${newSlug}/`;
      // `substring(x from n)` with no `for` is POSIX *regex* extraction in Postgres, not a start
      // position, and returns NULL when "n" doesn't match as a pattern. The comma-call form is
      // itself overloaded the same way (a bare, untyped parameter can still resolve to the regex
      // `(text, text)` variant) — an explicit `::int` cast is what actually pins down the
      // position-based `(text, int)` overload.
      await sql`update categories set path = ${newPath} || substring(path, ${before.path.length + 1}::int)
                 where path = ${before.path} or path like ${before.path + '%'}`.execute(tx);
      await sql`update categories set name = ${name}, sort_order = coalesce(${input.sortOrder ?? null}, sort_order)
                 where id = ${id}`.execute(tx);
    } else if (input.sortOrder !== undefined) {
      await sql`update categories set sort_order = ${input.sortOrder} where id = ${id}`.execute(tx);
    }
    const after = await this.getCategory(tx, id);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'category.update',
      resourceType: 'category',
      resourceId: id,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  // --- Units ------------------------------------------------------------------
  async listUnits(tx: Tx, principal: Principal): Promise<Unit[]> {
    assertCan(principal, 'product.read');
    const { rows } =
      await sql<UnitRow>`select id, code, name, allow_decimal from units order by code`.execute(tx);
    return rows.map(toUnit);
  }

  async getUnit(tx: Tx, id: string): Promise<Unit> {
    const row = isUuid(id)
      ? (await sql<UnitRow>`select id, code, name, allow_decimal from units where id = ${id}`.execute(tx))
          .rows[0]
      : undefined;
    if (!row) throw new NotFoundError('Unit not found');
    return toUnit(row);
  }

  async createUnit(tx: Tx, principal: Principal, input: UnitInput): Promise<Unit> {
    assertCan(principal, 'product.create');
    if (!CODE_RE.test(input.code))
      throw new ValidationError('Unit code must be 1-20 chars: A-Z, 0-9, _ or -');
    const name = requireName(input.name);
    const id = uuidv7();
    await unique(`Unit ${input.code} already exists`, () =>
      sql`insert into units (tenant_id, id, code, name, allow_decimal)
          values (${principal.tenantId}, ${id}, ${input.code}, ${name}, ${input.allowDecimal ?? false})`.execute(
        tx,
      ),
    );
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'unit.create',
      resourceType: 'unit',
      resourceId: id,
      after: { code: input.code, name },
    });
    return this.getUnit(tx, id);
  }
}

interface BrandRow {
  id: string;
  name: string;
  is_active: boolean;
}
const toBrand = (r: BrandRow): Brand => ({ id: r.id, name: r.name, isActive: r.is_active });

interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  sort_order: number;
}
const toCategory = (r: CategoryRow): Category => ({
  id: r.id,
  parentId: r.parent_id,
  name: r.name,
  path: r.path,
  sortOrder: r.sort_order,
});

interface UnitRow {
  id: string;
  code: string;
  name: string;
  allow_decimal: boolean;
}
const toUnit = (r: UnitRow): Unit => ({
  id: r.id,
  code: r.code,
  name: r.name,
  allowDecimal: r.allow_decimal,
});

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120) throw new ValidationError('Name must be 1-120 characters');
  return trimmed;
}

/** ASCII-safe path segment; non-ASCII names (e.g. Thai) fall back to a short hash-free slug. */
function slugify(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || `c${Math.abs(hashCode(name))}`;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h | 0;
}

async function unique<T>(message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (pgErrorCode(err) === PgErrorCode.UniqueViolation) throw new ConflictError(message);
    throw err;
  }
}

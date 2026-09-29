import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, type Tx } from '@stockos/database';
import { NotFoundError, ValidationError, isUuid, uuidv7 } from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  totalSpent: string;
  orderCount: number;
}

export interface CustomerInput {
  name: string;
  phone?: string;
  email?: string;
}

const PHONE_RE = /^\+[1-9]\d{7,14}$/; // E.164

/**
 * Minimal customer directory — just enough for POS "quick-add" and lookup at the register
 * (docs/05-pos.md §15). Loyalty tiers, addresses and channel identity merge are later phases.
 */
export class CustomerService {
  /** Creates a new customer, or returns the existing one for that phone number (docs/05-pos.md §16 dedupe rule). */
  async create(tx: Tx, principal: Principal, input: CustomerInput): Promise<Customer> {
    assertCan(principal, 'customer.manage');
    const name = input.name.trim();
    if (!name) throw new ValidationError('Name is required');
    const phone = normalizePhone(input.phone);
    const id = uuidv7();
    try {
      await sql`insert into customers (tenant_id, id, name, phone_e164, email)
                values (${principal.tenantId}, ${id}, ${name}, ${phone}, ${input.email?.trim() || null})`.execute(
        tx,
      );
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation && phone) {
        const existing = await this.findByPhone(tx, phone);
        if (existing) return existing;
      }
      throw err;
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'customer.create',
      resourceType: 'customer',
      resourceId: id,
      after: { name, phone },
    });
    return this.getOrThrow(tx, id);
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<Customer> {
    assertCan(principal, 'customer.read');
    return this.getOrThrow(tx, id);
  }

  /** Prefix match on phone, trigram search on name — the two ways a cashier looks someone up. */
  async search(tx: Tx, principal: Principal, q: string): Promise<Customer[]> {
    assertCan(principal, 'customer.read');
    const term = q.trim();
    if (!term) return [];
    const { rows } = await sql<CustomerRow>`
      select ${cols} from customers
       where merged_into_id is null and deleted_at is null
         and (phone_e164 like ${term + '%'} or name ilike ${'%' + term + '%'})
       order by name limit 20`.execute(tx);
    return rows.map(toCustomer);
  }

  private async findByPhone(tx: Tx, phone: string): Promise<Customer | null> {
    const { rows } = await sql<CustomerRow>`
      select ${cols} from customers
       where phone_e164 = ${phone} and merged_into_id is null and deleted_at is null`.execute(tx);
    return rows[0] ? toCustomer(rows[0]) : null;
  }

  private async getOrThrow(tx: Tx, id: string): Promise<Customer> {
    if (!isUuid(id)) throw new NotFoundError('Customer not found');
    const { rows } = await sql<CustomerRow>`
      select ${cols} from customers where id = ${id} and deleted_at is null`.execute(tx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Customer not found');
    return toCustomer(row);
  }
}

function normalizePhone(phone: string | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!PHONE_RE.test(trimmed)) throw new ValidationError('Phone must be E.164, e.g. +66812345678');
  return trimmed;
}

interface CustomerRow {
  id: string;
  name: string;
  phone_e164: string | null;
  email: string | null;
  total_spent: string;
  order_count: number;
}
const cols = sql`id, name, phone_e164, email, total_spent, order_count`;
const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id,
  name: r.name,
  phone: r.phone_e164,
  email: r.email,
  totalSpent: r.total_spent,
  orderCount: r.order_count,
});

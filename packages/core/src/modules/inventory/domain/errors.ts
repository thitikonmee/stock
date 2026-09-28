import { DomainError } from '@stockos/shared';

export class InsufficientStockError extends DomainError {
  readonly code = 'STOCK_INSUFFICIENT';
  readonly httpStatus = 409;

  constructor(details: {
    warehouseId: string;
    variantId: string;
    operation: string;
    requested: string;
    available?: string;
  }) {
    super(
      `Insufficient stock for ${details.operation}: variant ${details.variantId} at warehouse ${details.warehouseId}`,
      details,
    );
  }
}

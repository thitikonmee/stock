// The only file other modules may import from the pos module (enforced by ESLint boundaries).
export {
  computeCart,
  validatePaymentSplit,
  type CartLineInput,
  type CartLineTotals,
  type CartTotals,
  type ComputeCartInput,
  type PaymentLineInput,
  type PaymentSplitResult,
} from './domain/cart';
export type {
  CashMovement,
  CashMovementType,
  ManagerOverrideInput,
  PaymentMethod,
  Refund,
  RefundInput,
  RefundLineInput,
  Sale,
  SaleInput,
  SaleLine,
  SaleLineInput,
  SalePaymentInput,
  Shift,
  ShiftStatus,
} from './domain/types';
export {
  CashierSessionService,
  type CashierLoginInput,
  type CashierSession,
} from './application/cashier-session-service';
export {
  ShiftService,
  type CashMovementInput,
  type CloseShiftInput,
  type OpenShiftInput,
} from './application/shift-service';
export { SaleService } from './application/sale-service';
export { RefundService } from './application/refund-service';
export { loadPosSettings, type PosSettings } from './application/settings';

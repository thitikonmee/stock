// The only file other modules may import from the orders module (enforced by ESLint boundaries).
export {
  ORDER_EVENTS,
  ORDER_STATUSES,
  canTransition,
  initialStatus,
  transition,
  type OrderEvent,
  type OrderStatus,
} from './domain/order-state-machine';
export {
  computeOrderTotals,
  type OrderLineCalcInput,
  type OrderLineTotals,
  type OrderTotals,
} from './domain/pricing';
export type {
  CreateFulfillmentInput,
  CreateOrderInput,
  CreateOrderLineInput,
  FulfillmentLineInput,
  FulfillmentRowStatus,
  Fulfillment,
  InventoryStatus,
  Order,
  OrderLine,
  OrderListPage,
  OrderListQuery,
  OrderRefund,
  OrderRefundInput,
  OrderReturn,
  PaymentStatus,
  FulfillmentStatus,
  ReceiveReturnInput,
  ReceiveReturnLineInput,
  RequestReturnInput,
  ReturnCondition,
  ReturnLineInput,
  ReturnStatus,
  ShipInput,
} from './domain/types';
export { OrderService } from './application/order-service';
export { FulfillmentService } from './application/fulfillment-service';
export { ReturnService } from './application/return-service';
export { RefundService } from './application/refund-service';

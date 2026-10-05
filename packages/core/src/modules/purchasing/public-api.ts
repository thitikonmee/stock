// The only file other modules may import from the purchasing module (enforced by ESLint boundaries).
export {
  PurchaseService,
  type CreatePurchaseInput,
  type GoodsReceiptSummary,
  type Purchase,
  type PurchaseItem,
  type PurchaseItemInput,
  type PurchaseListQuery,
  type PurchaseStatus,
  type ReceiveInput as PurchaseReceiveInput,
  type ReceiveLineInput as PurchaseReceiveLineInput,
  type SupplierPerformance,
} from './application/purchase-service';

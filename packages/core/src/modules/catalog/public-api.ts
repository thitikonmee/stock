// The only file other modules may import from the catalog module (enforced by ESLint boundaries).
export {
  CatalogMasterDataService,
  type Brand,
  type BrandInput,
  type Category,
  type CategoryInput,
  type Unit,
  type UnitInput,
} from './application/catalog-service';
export {
  ProductService,
  type Product,
  type ProductCreateInput,
  type ProductListPage,
  type ProductListQuery,
  type ProductOption,
  type ProductStatus,
  type ProductType,
  type ProductUpdateInput,
  type TaxClass,
  type UnitConversion,
  type Variant,
  type VariantInput,
  type VariantSaleInfo,
  type VariantStatus,
  type VariantUpdateInput,
} from './application/product-service';
export { ImageService, type ProductImage } from './application/image-service';
export {
  SupplierService,
  type Supplier,
  type SupplierInput,
  type SupplierProduct,
} from './application/supplier-service';
export { PriceService, type Price, type PriceList, type PriceListInput } from './application/price-service';
export {
  ImportExportService,
  DryRunAbort,
  type ImportJob,
  type ImportPreviewRow,
} from './application/import-export-service';
export { renderLabelSheet, type LabelItem } from './application/label-service';
export {
  assertValidBarcode,
  isValidCode128,
  isValidEan13,
  INTERNAL_EAN13_PREFIXES,
  type BarcodeSymbology,
} from './domain/barcode';
export {
  createImageStorage,
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  type ImageStorage,
  type StorageConfig,
} from './infrastructure/storage';

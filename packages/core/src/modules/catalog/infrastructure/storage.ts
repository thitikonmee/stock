import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { ValidationError } from '@stockos/shared';

export interface StoredObject {
  key: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Where product images live. S3-compatible object storage when `STORAGE_S3_BUCKET` is configured
 * (AWS S3, MinIO, Cloudflare R2, ...); a local directory otherwise (dev/no-Docker default).
 */
export interface ImageStorage {
  put(key: string, data: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<{ data: Buffer; contentType: string }>;
  delete(key: string): Promise<void>;
}

export interface StorageConfig {
  /** Local fallback root; defaults to `.uploads` under the process cwd. */
  localDir?: string;
  s3?: {
    bucket: string;
    region?: string;
    endpoint?: string;
    forcePathStyle?: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function assertImageUpload(contentType: string, sizeBytes: number): void {
  if (!ALLOWED_IMAGE_TYPES.has(contentType))
    throw new ValidationError('Only JPEG, PNG or WebP images are accepted');
  if (sizeBytes === 0 || sizeBytes > MAX_IMAGE_BYTES)
    throw new ValidationError(`Image must be 1 byte to ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
}

/** `tenant/product/sha256-prefix.ext` — content-addressed, so re-uploading the same file is free. */
export function imageKey(tenantId: string, productId: string, data: Buffer, contentType: string): string {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 24);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[contentType] ?? 'bin';
  return `${tenantId}/${productId}/${hash}.${ext}`;
}

export function createImageStorage(config: StorageConfig = {}): ImageStorage {
  if (config.s3) return new S3ImageStorage(config.s3);
  return new LocalImageStorage(config.localDir ?? path.resolve(process.cwd(), '.uploads'));
}

class LocalImageStorage implements ImageStorage {
  constructor(private readonly root: string) {}

  async put(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    await writeFile(file + '.meta.json', JSON.stringify({ contentType }));
    return { key, contentType, sizeBytes: data.byteLength };
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string }> {
    const file = this.resolve(key);
    const [data, metaRaw] = await Promise.all([
      readFile(file),
      readFile(file + '.meta.json', 'utf8').catch(() => '{}'),
    ]);
    const meta = JSON.parse(metaRaw) as { contentType?: string };
    return { data, contentType: meta.contentType ?? 'application/octet-stream' };
  }

  async delete(key: string): Promise<void> {
    const file = this.resolve(key);
    await Promise.all([rm(file, { force: true }), rm(file + '.meta.json', { force: true })]);
  }

  private resolve(key: string): string {
    const normalized = path.normalize(key);
    if (normalized.startsWith('..') || path.isAbsolute(normalized))
      throw new ValidationError('Invalid storage key');
    return path.join(this.root, normalized);
  }
}

class S3ImageStorage implements ImageStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: NonNullable<StorageConfig['s3']>) {
    this.bucket = cfg.bucket;
    const clientConfig: S3ClientConfig = { region: cfg.region ?? 'ap-southeast-7' };
    if (cfg.endpoint) clientConfig.endpoint = cfg.endpoint;
    if (cfg.forcePathStyle !== undefined) clientConfig.forcePathStyle = cfg.forcePathStyle;
    if (cfg.accessKeyId && cfg.secretAccessKey) {
      clientConfig.credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
    }
    this.client = new S3Client(clientConfig);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
    );
    return { key, contentType, sizeBytes: data.byteLength };
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string }> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const data = Buffer.from(await res.Body!.transformToByteArray());
    return { data, contentType: res.ContentType ?? 'application/octet-stream' };
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

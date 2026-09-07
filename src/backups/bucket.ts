/**
 * Minimal structural R2-bucket-shaped interface -- ONLY the subset of the
 * real Cloudflare `R2Bucket` API that the backup/retention modules actually
 * use. Defined independently of the ambient Workers-runtime `R2Bucket` type
 * so `src/backups/service.ts` and `src/backups/retention.ts` never import
 * anything Workers-runtime-specific, and so DB-less unit tests can pass a
 * trivial in-memory fake implementing exactly this shape.
 */
export interface BackupBucketObject {
	key: string;
	size: number;
	uploaded: Date;
	customMetadata?: Record<string, string> | undefined;
}

export interface BackupBucketObjectBody extends BackupBucketObject {
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BackupBucketListResult {
	objects: BackupBucketObject[];
	truncated: boolean;
	cursor?: string | undefined;
}

export interface BackupBucket {
	put(
		key: string,
		value: Uint8Array,
		options?: { customMetadata?: Record<string, string> | undefined },
	): Promise<void>;
	get(key: string): Promise<BackupBucketObjectBody | null>;
	head(key: string): Promise<BackupBucketObject | null>;
	delete(key: string): Promise<void>;
	list(options?: {
		prefix?: string | undefined;
		cursor?: string | undefined;
	}): Promise<BackupBucketListResult>;
}

/**
 * Adapts the real ambient Cloudflare `R2Bucket` binding to the minimal
 * `BackupBucket` interface. This is the ONLY place in the backup domain
 * that touches the Workers-runtime `R2Bucket` type -- kept out of
 * service.ts/retention.ts/export.ts/crypto.ts/manifest.ts so those stay
 * framework-agnostic and independently unit-testable.
 */
export function toBackupBucket(bucket: R2Bucket): BackupBucket {
	return {
		async put(key, value, options) {
			if (options?.customMetadata) {
				await bucket.put(key, value, {
					customMetadata: options.customMetadata,
				});
			} else {
				await bucket.put(key, value);
			}
		},
		async get(key) {
			const obj = await bucket.get(key);
			if (!obj) return null;
			return {
				key: obj.key,
				size: obj.size,
				uploaded: obj.uploaded,
				customMetadata: obj.customMetadata,
				arrayBuffer: () => obj.arrayBuffer(),
			};
		},
		async head(key) {
			const obj = await bucket.head(key);
			if (!obj) return null;
			return {
				key: obj.key,
				size: obj.size,
				uploaded: obj.uploaded,
				customMetadata: obj.customMetadata,
			};
		},
		async delete(key) {
			await bucket.delete(key);
		},
		async list(options) {
			const listOptions: { prefix?: string; cursor?: string } = {};
			if (options?.prefix !== undefined) listOptions.prefix = options.prefix;
			if (options?.cursor !== undefined) listOptions.cursor = options.cursor;
			const result = await bucket.list(listOptions);
			return {
				objects: result.objects.map((o) => ({
					key: o.key,
					size: o.size,
					uploaded: o.uploaded,
					customMetadata: o.customMetadata,
				})),
				truncated: result.truncated,
				cursor: result.truncated ? result.cursor : undefined,
			};
		},
	};
}

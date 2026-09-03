import { CanonicalTransactionError } from "./errors";

const MAX_CANONICAL_JSON_DEPTH = 20;
const MAX_CANONICAL_JSON_BYTES = 65536;

/**
 * Recursively validates and normalizes an arbitrary value according to the canonical JSON contract.
 *
 * Rules:
 * - Allowed: null, string, boolean, safe integer number (Number.isSafeInteger)
 * - Prohibited: floating-point numbers (must be strings e.g. "123.45"), NaN, Infinity, undefined,
 *   functions, symbols, BigInt, Date, Map, Set, non-plain object class instances.
 * - Enforces max depth of 20 and rejects circular references.
 * - Lexicographically sorts all object keys.
 */
function validateAndCanonicalizeValue(
	value: unknown,
	depth: number,
	seen: Set<object>,
): unknown {
	if (depth > MAX_CANONICAL_JSON_DEPTH) {
		throw new CanonicalTransactionError(
			"TRANSACTION_PAYLOAD_INVALID",
			`Canonical JSON depth exceeded maximum allowed depth of ${MAX_CANONICAL_JSON_DEPTH}`,
		);
	}

	if (value === null) {
		return null;
	}

	if (typeof value === "string") {
		return value;
	}

	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "number") {
		if (Number.isNaN(value) || !Number.isFinite(value)) {
			throw new CanonicalTransactionError(
				"TRANSACTION_PAYLOAD_INVALID",
				`Invalid number in payload: ${String(value)}. NaN and Infinity are prohibited.`,
			);
		}

		if (!Number.isSafeInteger(value)) {
			throw new CanonicalTransactionError(
				"TRANSACTION_PAYLOAD_INVALID",
				`Floating-point and unsafe integer numbers are prohibited in canonical payload: ${value}. Financial decimals must be represented as strings (e.g. "123.45").`,
			);
		}

		return value;
	}

	if (
		typeof value === "undefined" ||
		typeof value === "function" ||
		typeof value === "symbol" ||
		typeof value === "bigint"
	) {
		throw new CanonicalTransactionError(
			"TRANSACTION_PAYLOAD_INVALID",
			`Prohibited payload value type: ${typeof value}`,
		);
	}

	if (typeof value === "object") {
		if (seen.has(value)) {
			throw new CanonicalTransactionError(
				"TRANSACTION_PAYLOAD_INVALID",
				"Circular reference detected in canonical payload",
			);
		}

		seen.add(value);

		try {
			if (Array.isArray(value)) {
				return value.map((item) =>
					validateAndCanonicalizeValue(item, depth + 1, seen),
				);
			}

			// Reject non-plain objects (e.g. Date, RegExp, Map, Set, custom classes)
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) {
				const className = value.constructor?.name ?? "CustomObject";
				throw new CanonicalTransactionError(
					"TRANSACTION_PAYLOAD_INVALID",
					`Non-plain object instances are prohibited in canonical payload: ${className}`,
				);
			}

			const rawRecord = value as Record<string, unknown>;
			const sortedKeys = Object.keys(rawRecord).sort();
			const canonicalObj: Record<string, unknown> = {};

			for (const key of sortedKeys) {
				const val = rawRecord[key];
				if (val === undefined) {
					throw new CanonicalTransactionError(
						"TRANSACTION_PAYLOAD_INVALID",
						`Undefined object property values are prohibited (key: "${key}")`,
					);
				}
				canonicalObj[key] = validateAndCanonicalizeValue(val, depth + 1, seen);
			}

			return canonicalObj;
		} finally {
			seen.delete(value);
		}
	}

	throw new CanonicalTransactionError(
		"TRANSACTION_PAYLOAD_INVALID",
		`Unsupported value encountered in canonical payload: ${String(value)}`,
	);
}

/**
 * Serializes a canonical payload into a deterministic canonical JSON string.
 * Enforces lexicographical key sorting, floating-point number rejection,
 * depth bounds, and UTF-8 byte limits (64 KiB).
 */
export function stringifyCanonicalJson(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CanonicalTransactionError(
			"TRANSACTION_PAYLOAD_INVALID",
			"Canonical transaction payload must be a non-null plain JSON object",
		);
	}

	const canonicalTree = validateAndCanonicalizeValue(value, 1, new Set());
	const serialized = JSON.stringify(canonicalTree);

	const encoded = new TextEncoder().encode(serialized);
	if (encoded.length > MAX_CANONICAL_JSON_BYTES) {
		throw new CanonicalTransactionError(
			"TRANSACTION_PAYLOAD_INVALID",
			`Canonical payload size (${encoded.length} bytes) exceeds maximum limit of ${MAX_CANONICAL_JSON_BYTES} bytes`,
		);
	}

	return serialized;
}

/**
 * Validates, canonicalizes, and parses a transaction payload.
 * Returns both the normalized plain object tree and its deterministic canonical string representation.
 */
export function canonicalizePayload(value: unknown): {
	canonicalObject: Record<string, unknown>;
	canonicalJson: string;
} {
	const canonicalJson = stringifyCanonicalJson(value);
	const canonicalObject = JSON.parse(canonicalJson) as Record<string, unknown>;

	return {
		canonicalObject,
		canonicalJson,
	};
}

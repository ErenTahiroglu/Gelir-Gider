import { MidasError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates and canonicalizes an externally supplied UUID string to lowercase.
 * Throws MIDAS_INVALID_INPUT if value is not a valid UUID.
 */
export function normalizeCanonicalUuid(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			`${fieldName} must be a valid UUID string`,
		);
	}

	const trimmed = value.trim();
	if (trimmed === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", `${fieldName} cannot be empty`);
	}

	if (!UUID_PATTERN.test(trimmed)) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			`${fieldName} must be a valid canonical UUID: "${trimmed}"`,
		);
	}

	return trimmed.toLowerCase();
}

import { PeopleError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates that a value is a well-formed canonical UUID before it ever reaches
 * the database, so a malformed identifier fails as PEOPLE_INVALID_INPUT instead
 * of surfacing a raw Postgres 22P02 "invalid input syntax for uuid" error.
 */
export function validateCanonicalUuid(value: string, field: string): string {
	const trimmed = value?.trim();
	if (!trimmed || !UUID_PATTERN.test(trimmed)) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`${field} must be a valid UUID`,
		);
	}
	return trimmed.toLowerCase();
}

/**
 * Validates an optional canonical UUID filter/field. Returns undefined only
 * when the value itself is undefined; any other invalid value (including an
 * empty string) throws PEOPLE_INVALID_INPUT.
 */
export function validateOptionalCanonicalUuid(
	value: string | undefined,
	field: string,
): string | undefined {
	if (value === undefined) return undefined;
	return validateCanonicalUuid(value, field);
}

/**
 * Validates an optional enum-constrained filter/field. Returns undefined only
 * when the value itself is undefined; any other value not in `allowed`
 * (including an empty string) throws PEOPLE_INVALID_INPUT.
 */
export function validateOptionalEnum<T extends string>(
	value: T | undefined,
	allowed: readonly T[],
	field: string,
): T | undefined {
	if (value === undefined) return undefined;
	if (!allowed.includes(value)) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`${field} must be one of ${allowed.join(", ")}`,
		);
	}
	return value;
}

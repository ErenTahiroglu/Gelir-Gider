import { isUuid, parseCanonicalInstant } from "../http/transport";
import { PeopleError } from "./errors";

export interface PersonCursor {
	createdAt: string; // ISO instant string
	id: string; // UUID
}

export interface ObligationCursor {
	createdAt: string; // ISO instant string
	id: string; // UUID
}

export interface SettlementCursor {
	createdAt: string; // ISO instant string
	id: string; // UUID
}

export interface PersonCursorScope {
	userId?: string | undefined;
}

export interface ObligationCursorScope {
	userId?: string | undefined;
	personId?: string | undefined;
}

export interface SettlementCursorScope {
	userId?: string | undefined;
	obligationId?: string | undefined;
}

export function encodePersonCursor(
	cursor: PersonCursor,
	scope?: PersonCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodePersonCursor(
	raw: string,
	expectedScope?: PersonCursorScope,
): PersonCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.createdAt !== "string" ||
			!parseCanonicalInstant(parsed.createdAt) ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid person cursor payload");
		}
		if (expectedScope?.userId !== undefined) {
			if (
				typeof parsed.userId !== "string" ||
				parsed.userId.toLowerCase() !== expectedScope.userId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		return {
			createdAt: parsed.createdAt,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"Invalid people pagination cursor",
		);
	}
}

export function encodeObligationCursor(
	cursor: ObligationCursor,
	scope?: ObligationCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodeObligationCursor(
	raw: string,
	expectedScope?: ObligationCursorScope,
): ObligationCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.createdAt !== "string" ||
			!parseCanonicalInstant(parsed.createdAt) ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid obligation cursor payload");
		}
		if (expectedScope?.userId !== undefined) {
			if (
				typeof parsed.userId !== "string" ||
				parsed.userId.toLowerCase() !== expectedScope.userId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		if (expectedScope?.personId !== undefined) {
			if (
				typeof parsed.personId !== "string" ||
				parsed.personId.toLowerCase() !== expectedScope.personId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		return {
			createdAt: parsed.createdAt,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"Invalid obligation pagination cursor",
		);
	}
}

export function encodeSettlementCursor(
	cursor: SettlementCursor,
	scope?: SettlementCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodeSettlementCursor(
	raw: string,
	expectedScope?: SettlementCursorScope,
): SettlementCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.createdAt !== "string" ||
			!parseCanonicalInstant(parsed.createdAt) ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid settlement cursor payload");
		}
		if (expectedScope?.userId !== undefined) {
			if (
				typeof parsed.userId !== "string" ||
				parsed.userId.toLowerCase() !== expectedScope.userId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		if (expectedScope?.obligationId !== undefined) {
			if (
				typeof parsed.obligationId !== "string" ||
				parsed.obligationId.toLowerCase() !==
					expectedScope.obligationId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		return {
			createdAt: parsed.createdAt,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"Invalid settlement pagination cursor",
		);
	}
}

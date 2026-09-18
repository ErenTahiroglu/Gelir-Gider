import { isUuid, parseCanonicalInstant } from "../http/transport";
import { validateGregorianDateString } from "./calendar";
import { CreditCardError } from "./errors";

export interface CardCursor {
	createdAt: string; // ISO instant string
	id: string; // UUID
}

export interface StatementCursor {
	cycleYear: number;
	cycleMonth: number;
	id: string; // UUID
}

export interface PurchaseCursor {
	purchaseDate: string; // YYYY-MM-DD
	occurredAt: string; // ISO instant string
	eventId: string; // UUID
}

export interface CardCursorScope {
	userId?: string | undefined;
}

export interface StatementCursorScope {
	userId?: string | undefined;
	cardId?: string | undefined;
}

export interface PurchaseCursorScope {
	userId?: string | undefined;
	cardId?: string | undefined;
}

export function encodeCardCursor(
	cursor: CardCursor,
	scope?: CardCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodeCardCursor(
	raw: string,
	expectedScope?: CardCursorScope,
): CardCursor {
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
			throw new Error("Invalid card cursor payload");
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
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Invalid credit card pagination cursor",
		);
	}
}

export function encodeStatementCursor(
	cursor: StatementCursor,
	scope?: StatementCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodeStatementCursor(
	raw: string,
	expectedScope?: StatementCursorScope,
): StatementCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.cycleYear !== "number" ||
			!Number.isInteger(parsed.cycleYear) ||
			typeof parsed.cycleMonth !== "number" ||
			!Number.isInteger(parsed.cycleMonth) ||
			parsed.cycleMonth < 1 ||
			parsed.cycleMonth > 12 ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid statement cursor payload");
		}
		if (expectedScope?.userId !== undefined) {
			if (
				typeof parsed.userId !== "string" ||
				parsed.userId.toLowerCase() !== expectedScope.userId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		if (expectedScope?.cardId !== undefined) {
			if (
				typeof parsed.cardId !== "string" ||
				parsed.cardId.toLowerCase() !== expectedScope.cardId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		return {
			cycleYear: parsed.cycleYear,
			cycleMonth: parsed.cycleMonth,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Invalid credit card statement pagination cursor",
		);
	}
}

export function encodePurchaseCursor(
	cursor: PurchaseCursor,
	scope?: PurchaseCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodePurchaseCursor(
	raw: string,
	expectedScope?: PurchaseCursorScope,
): PurchaseCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.purchaseDate !== "string" ||
			typeof parsed.occurredAt !== "string" ||
			!parseCanonicalInstant(parsed.occurredAt) ||
			typeof parsed.eventId !== "string" ||
			!isUuid(parsed.eventId)
		) {
			throw new Error("Invalid purchase cursor payload");
		}
		validateGregorianDateString(parsed.purchaseDate, "purchaseDate");
		if (expectedScope?.userId !== undefined) {
			if (
				typeof parsed.userId !== "string" ||
				parsed.userId.toLowerCase() !== expectedScope.userId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		if (expectedScope?.cardId !== undefined) {
			if (
				typeof parsed.cardId !== "string" ||
				parsed.cardId.toLowerCase() !== expectedScope.cardId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		return {
			purchaseDate: parsed.purchaseDate,
			occurredAt: parsed.occurredAt,
			eventId: parsed.eventId.toLowerCase(),
		};
	} catch {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Invalid credit card purchase pagination cursor",
		);
	}
}

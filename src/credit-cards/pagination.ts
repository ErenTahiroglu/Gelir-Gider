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

export function encodeCardCursor(cursor: CardCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCardCursor(raw: string): CardCursor {
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

export function encodeStatementCursor(cursor: StatementCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeStatementCursor(raw: string): StatementCursor {
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

export function encodePurchaseCursor(cursor: PurchaseCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodePurchaseCursor(raw: string): PurchaseCursor {
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

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

export function encodePersonCursor(cursor: PersonCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodePersonCursor(raw: string): PersonCursor {
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

export function encodeObligationCursor(cursor: ObligationCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeObligationCursor(raw: string): ObligationCursor {
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

export function encodeSettlementCursor(cursor: SettlementCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeSettlementCursor(raw: string): SettlementCursor {
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

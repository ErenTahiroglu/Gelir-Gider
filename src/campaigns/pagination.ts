import { isUuid, parseCanonicalInstant } from "../http/transport";
import { CampaignError } from "./errors";

export interface CampaignPeriodCursor {
	createdAt: string; // ISO instant string
	id: string; // UUID
}

export interface CampaignReviewCandidateCursor {
	createdAt: string; // ISO instant string
	id: string; // UUID
}

export interface CampaignProgressPurchaseCursor {
	purchaseDate: string | null;
	id: string; // UUID
}

export interface CampaignOverrideCursor {
	id: string; // purchaseEventId UUID
}

export function encodeCampaignPeriodCursor(
	cursor: CampaignPeriodCursor,
): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCampaignPeriodCursor(raw: string): CampaignPeriodCursor {
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
			throw new Error("Invalid campaign period cursor payload");
		}
		return {
			createdAt: parsed.createdAt,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"Invalid campaign period pagination cursor",
		);
	}
}

export function encodeCampaignReviewCandidateCursor(
	cursor: CampaignReviewCandidateCursor,
): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCampaignReviewCandidateCursor(
	raw: string,
): CampaignReviewCandidateCursor {
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
			throw new Error("Invalid campaign review candidate cursor payload");
		}
		return {
			createdAt: parsed.createdAt,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"Invalid campaign review candidate pagination cursor",
		);
	}
}

export function encodeCampaignProgressPurchaseCursor(
	cursor: CampaignProgressPurchaseCursor,
): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCampaignProgressPurchaseCursor(
	raw: string,
): CampaignProgressPurchaseCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed.purchaseDate !== null &&
				typeof parsed.purchaseDate !== "string") ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid campaign progress purchase cursor payload");
		}
		return {
			purchaseDate: parsed.purchaseDate,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"Invalid campaign progress purchase pagination cursor",
		);
	}
}

export function encodeCampaignOverrideCursor(
	cursor: CampaignOverrideCursor,
): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCampaignOverrideCursor(
	raw: string,
): CampaignOverrideCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid campaign override cursor payload");
		}
		return {
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"Invalid campaign override pagination cursor",
		);
	}
}

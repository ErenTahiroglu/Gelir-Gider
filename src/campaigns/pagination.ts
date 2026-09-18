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

export interface CampaignPeriodCursorScope {
	userId?: string | undefined;
}

export interface CampaignReviewCandidateCursorScope {
	userId?: string | undefined;
	campaignPeriodId?: string | undefined;
}

export interface CampaignProgressPurchaseCursorScope {
	userId?: string | undefined;
	cardId?: string | undefined;
}

export interface CampaignOverrideCursorScope {
	userId?: string | undefined;
	campaignPeriodId?: string | undefined;
}

export function encodeCampaignPeriodCursor(
	cursor: CampaignPeriodCursor,
	scope?: CampaignPeriodCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodeCampaignPeriodCursor(
	raw: string,
	expectedScope?: CampaignPeriodCursorScope,
): CampaignPeriodCursor {
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
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"Invalid campaign period pagination cursor",
		);
	}
}

export function encodeCampaignReviewCandidateCursor(
	cursor: CampaignReviewCandidateCursor,
	scope?: CampaignReviewCandidateCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodeCampaignReviewCandidateCursor(
	raw: string,
	expectedScope?: CampaignReviewCandidateCursorScope,
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
		if (expectedScope?.userId !== undefined) {
			if (
				typeof parsed.userId !== "string" ||
				parsed.userId.toLowerCase() !== expectedScope.userId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		if (expectedScope?.campaignPeriodId !== undefined) {
			if (
				typeof parsed.campaignPeriodId !== "string" ||
				parsed.campaignPeriodId.toLowerCase() !==
					expectedScope.campaignPeriodId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
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
	scope?: CampaignProgressPurchaseCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodeCampaignProgressPurchaseCursor(
	raw: string,
	expectedScope?: CampaignProgressPurchaseCursorScope,
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
	scope?: CampaignOverrideCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodeCampaignOverrideCursor(
	raw: string,
	expectedScope?: CampaignOverrideCursorScope,
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
		if (expectedScope?.userId !== undefined) {
			if (
				typeof parsed.userId !== "string" ||
				parsed.userId.toLowerCase() !== expectedScope.userId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		if (expectedScope?.campaignPeriodId !== undefined) {
			if (
				typeof parsed.campaignPeriodId !== "string" ||
				parsed.campaignPeriodId.toLowerCase() !==
					expectedScope.campaignPeriodId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
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

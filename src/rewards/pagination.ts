import { isUuid, parseCanonicalInstant } from "../http/transport";
import { RewardError } from "./errors";

export interface RewardAccountCursor {
	createdAt: string; // ISO instant string
	id: string; // UUID
}

export interface RewardEventCursor {
	createdAt: string; // ISO instant string
	id: string; // UUID
}

export interface RewardAccountCursorScope {
	userId?: string | undefined;
}

export interface RewardEventCursorScope {
	userId?: string | undefined;
	rewardAccountId?: string | undefined;
}

export function encodeRewardAccountCursor(
	cursor: RewardAccountCursor,
	scope?: RewardAccountCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodeRewardAccountCursor(
	raw: string,
	expectedScope?: RewardAccountCursorScope,
): RewardAccountCursor {
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
			throw new Error("Invalid reward account cursor payload");
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
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			"Invalid reward account pagination cursor",
		);
	}
}

export function encodeRewardEventCursor(
	cursor: RewardEventCursor,
	scope?: RewardEventCursorScope,
): string {
	return Buffer.from(
		JSON.stringify({ ...cursor, ...(scope ?? {}) }),
		"utf8",
	).toString("base64url");
}

export function decodeRewardEventCursor(
	raw: string,
	expectedScope?: RewardEventCursorScope,
): RewardEventCursor {
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
			throw new Error("Invalid reward event cursor payload");
		}
		if (expectedScope?.userId !== undefined) {
			if (
				typeof parsed.userId !== "string" ||
				parsed.userId.toLowerCase() !== expectedScope.userId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		if (expectedScope?.rewardAccountId !== undefined) {
			if (
				typeof parsed.rewardAccountId !== "string" ||
				parsed.rewardAccountId.toLowerCase() !==
					expectedScope.rewardAccountId.toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}
		return {
			createdAt: parsed.createdAt,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			"Invalid reward event pagination cursor",
		);
	}
}

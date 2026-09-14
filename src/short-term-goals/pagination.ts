import type { ShortTermGoalStatus } from "../db/schema/short-term-goals";
import { isUuid, parseCanonicalInstant } from "../http/transport";
import { ShortTermGoalError } from "./errors";

export interface ShortTermGoalCursor {
	v: 1;
	userId: string;
	midasAccountId: string;
	status: ShortTermGoalStatus | "ALL";
	priority: number | null;
	createdAt: string; // ISO 8601 UTC string
	id: string; // UUID
}

export interface ShortTermGoalCursorScope {
	userId: string;
	midasAccountId: string;
	status?: ShortTermGoalStatus | undefined;
}

export function encodeShortTermGoalCursor(cursor: ShortTermGoalCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeShortTermGoalCursor(
	raw: string,
	expectedScope?: ShortTermGoalCursorScope,
): ShortTermGoalCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			parsed.v !== 1 ||
			typeof parsed.userId !== "string" ||
			!isUuid(parsed.userId) ||
			typeof parsed.midasAccountId !== "string" ||
			!isUuid(parsed.midasAccountId) ||
			typeof parsed.status !== "string" ||
			!["ACTIVE", "COMPLETED", "CANCELLED", "ALL"].includes(parsed.status) ||
			(parsed.priority !== null && typeof parsed.priority !== "number") ||
			typeof parsed.createdAt !== "string" ||
			!parseCanonicalInstant(parsed.createdAt) ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid cursor format");
		}

		if (expectedScope) {
			if (
				parsed.userId.toLowerCase() !== expectedScope.userId.toLowerCase() ||
				parsed.midasAccountId.toLowerCase() !==
					expectedScope.midasAccountId.toLowerCase() ||
				parsed.status !== (expectedScope.status ?? "ALL")
			) {
				throw new Error("Cursor scope mismatch");
			}
		}

		return {
			v: 1,
			userId: parsed.userId.toLowerCase(),
			midasAccountId: parsed.midasAccountId.toLowerCase(),
			status: parsed.status,
			priority: parsed.priority,
			createdAt: parsed.createdAt,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			"Invalid short-term goal pagination cursor",
		);
	}
}

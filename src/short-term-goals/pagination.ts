import { isUuid } from "../http/transport";
import { ShortTermGoalError } from "./errors";

export interface ShortTermGoalCursor {
	priority: number | null;
	createdAt: string; // ISO 8601 UTC string
	id: string; // UUID
}

export function encodeShortTermGoalCursor(cursor: ShortTermGoalCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeShortTermGoalCursor(raw: string): ShortTermGoalCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed.priority !== null && typeof parsed.priority !== "number") ||
			typeof parsed.createdAt !== "string" ||
			Number.isNaN(new Date(parsed.createdAt).getTime()) ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid cursor format");
		}
		return {
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

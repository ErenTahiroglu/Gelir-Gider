import { isUuid } from "../http/transport";
import { LongTermError } from "./errors";

export interface LongTermTaskCursor {
	createdAt: string; // ISO 8601 UTC string
	id: string; // UUID
}

export function encodeLongTermTaskCursor(cursor: LongTermTaskCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeLongTermTaskCursor(raw: string): LongTermTaskCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.createdAt !== "string" ||
			Number.isNaN(new Date(parsed.createdAt).getTime()) ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid cursor format");
		}
		return {
			createdAt: parsed.createdAt,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			"Invalid long-term task pagination cursor",
		);
	}
}

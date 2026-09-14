import { isUuid, parseCanonicalInstant } from "../http/transport";
import { LongTermError } from "./errors";
import type { LongTermTaskStatus } from "./service";

export interface LongTermTaskCursor {
	v: 1;
	userId: string;
	midasAccountId: string | "ALL";
	status: LongTermTaskStatus | "ALL";
	createdAt: string; // ISO 8601 UTC string
	id: string; // UUID
}

export interface LongTermTaskCursorScope {
	userId: string;
	midasAccountId?: string | undefined;
	status?: LongTermTaskStatus | undefined;
}

export function encodeLongTermTaskCursor(cursor: LongTermTaskCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeLongTermTaskCursor(
	raw: string,
	expectedScope?: LongTermTaskCursorScope,
): LongTermTaskCursor {
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
			(parsed.midasAccountId !== "ALL" && !isUuid(parsed.midasAccountId)) ||
			typeof parsed.status !== "string" ||
			!["PENDING", "SENT", "CANCELLED", "ALL"].includes(parsed.status) ||
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
					(
						expectedScope.midasAccountId?.toLowerCase() ?? "ALL"
					).toLowerCase() ||
				parsed.status !== (expectedScope.status ?? "ALL")
			) {
				throw new Error("Cursor scope mismatch");
			}
		}

		return {
			v: 1,
			userId: parsed.userId.toLowerCase(),
			midasAccountId:
				parsed.midasAccountId === "ALL"
					? "ALL"
					: parsed.midasAccountId.toLowerCase(),
			status: parsed.status,
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

import { isUuid, parseCanonicalInstant } from "../http/transport";
import { MidasError } from "./errors";

export interface MidasTransferCursor {
	v: 1;
	userId: string;
	midasAccountId: string;
	bucketId: string | "ALL";
	occurredAt: string; // ISO 8601 UTC string
	id: string; // UUID
}

export interface MidasTransferCursorScope {
	userId: string;
	midasAccountId: string;
	bucketId?: string | undefined;
}

export function encodeMidasTransferCursor(cursor: MidasTransferCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeMidasTransferCursor(
	raw: string,
	expectedScope?: MidasTransferCursorScope,
): MidasTransferCursor {
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
			typeof parsed.bucketId !== "string" ||
			(parsed.bucketId !== "ALL" && !isUuid(parsed.bucketId)) ||
			typeof parsed.occurredAt !== "string" ||
			!parseCanonicalInstant(parsed.occurredAt) ||
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
				parsed.bucketId.toLowerCase() !==
					(expectedScope.bucketId?.toLowerCase() ?? "ALL").toLowerCase()
			) {
				throw new Error("Cursor scope mismatch");
			}
		}

		return {
			v: 1,
			userId: parsed.userId.toLowerCase(),
			midasAccountId: parsed.midasAccountId.toLowerCase(),
			bucketId:
				parsed.bucketId === "ALL" ? "ALL" : parsed.bucketId.toLowerCase(),
			occurredAt: parsed.occurredAt,
			id: parsed.id.toLowerCase(),
		};
	} catch {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			"Invalid Midas transfer pagination cursor",
		);
	}
}

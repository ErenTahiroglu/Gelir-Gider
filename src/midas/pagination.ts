import { isUuid } from "../http/transport";
import { MidasError } from "./errors";

export interface MidasTransferCursor {
	occurredAt: string; // ISO 8601 UTC string
	id: string; // UUID
}

export function encodeMidasTransferCursor(cursor: MidasTransferCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeMidasTransferCursor(raw: string): MidasTransferCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.occurredAt !== "string" ||
			Number.isNaN(new Date(parsed.occurredAt).getTime()) ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid cursor format");
		}
		return {
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

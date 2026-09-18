import { isUuid } from "../http/transport";
import { LedgerError } from "./errors";

export interface LedgerAccountCursor {
	v: 1;
	userId: string;
	includeArchived: boolean;
	asOf: string | null;
	code: string;
	id: string;
}

export interface LedgerAccountCursorScope {
	userId: string;
	includeArchived: boolean;
	asOf?: string | null | undefined;
}

export function encodeLedgerAccountCursor(cursor: LedgerAccountCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeLedgerAccountCursor(
	raw: string,
	expectedScope?: LedgerAccountCursorScope,
): LedgerAccountCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			parsed.v !== 1 ||
			typeof parsed.userId !== "string" ||
			!isUuid(parsed.userId) ||
			typeof parsed.includeArchived !== "boolean" ||
			(parsed.asOf !== null && typeof parsed.asOf !== "string") ||
			typeof parsed.code !== "string" ||
			typeof parsed.id !== "string" ||
			!isUuid(parsed.id)
		) {
			throw new Error("Invalid cursor format");
		}

		if (expectedScope) {
			if (
				parsed.userId !== expectedScope.userId ||
				parsed.includeArchived !== expectedScope.includeArchived ||
				(expectedScope.asOf !== undefined &&
					parsed.asOf !== (expectedScope.asOf ?? null))
			) {
				throw new Error("Cursor scope mismatch");
			}
		}

		return {
			v: 1,
			userId: parsed.userId,
			includeArchived: parsed.includeArchived,
			asOf: parsed.asOf,
			code: parsed.code,
			id: parsed.id,
		};
	} catch (err) {
		if (
			err instanceof Error &&
			(err.message === "Cursor scope mismatch" ||
				err.message === "Invalid cursor format")
		) {
			throw new LedgerError(
				"LEDGER_INVALID_ENTRY",
				`Invalid cursor: ${err.message}`,
			);
		}
		throw new LedgerError("LEDGER_INVALID_ENTRY", "Invalid pagination cursor");
	}
}

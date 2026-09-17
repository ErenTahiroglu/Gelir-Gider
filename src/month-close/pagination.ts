import { isUuid } from "../http/transport";
import {
	validateMonthCloseCanonicalUuid,
	validateMonthClosePeriodMonth,
} from "./calendar";
import { MonthCloseError } from "./errors";

export interface MonthCloseCursor {
	v: 1;
	userId: string;
	periodMonthFrom: string | null;
	periodMonthUntil: string | null;
	periodMonth: string;
}

export interface MonthCloseCursorScope {
	userId: string;
	periodMonthFrom?: string | undefined;
	periodMonthUntil?: string | undefined;
}

export function encodeMonthCloseCursor(cursor: MonthCloseCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeMonthCloseCursor(
	raw: string,
	expectedScope?: MonthCloseCursorScope,
): MonthCloseCursor {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			parsed.v !== 1 ||
			typeof parsed.userId !== "string" ||
			!isUuid(parsed.userId) ||
			(parsed.periodMonthFrom !== null &&
				typeof parsed.periodMonthFrom !== "string") ||
			(parsed.periodMonthUntil !== null &&
				typeof parsed.periodMonthUntil !== "string") ||
			typeof parsed.periodMonth !== "string"
		) {
			throw new Error("Invalid cursor format");
		}

		const validUserId = validateMonthCloseCanonicalUuid(
			parsed.userId,
			"userId",
		);
		const validPeriodMonth = validateMonthClosePeriodMonth(parsed.periodMonth);
		const validPeriodMonthFrom =
			parsed.periodMonthFrom !== null
				? validateMonthClosePeriodMonth(parsed.periodMonthFrom)
				: null;
		const validPeriodMonthUntil =
			parsed.periodMonthUntil !== null
				? validateMonthClosePeriodMonth(parsed.periodMonthUntil)
				: null;

		if (expectedScope) {
			const expectedScopeUserId = validateMonthCloseCanonicalUuid(
				expectedScope.userId,
				"userId",
			);
			const expectedScopePeriodMonthFrom =
				expectedScope.periodMonthFrom !== undefined
					? validateMonthClosePeriodMonth(expectedScope.periodMonthFrom)
					: null;
			const expectedScopePeriodMonthUntil =
				expectedScope.periodMonthUntil !== undefined
					? validateMonthClosePeriodMonth(expectedScope.periodMonthUntil)
					: null;

			if (
				validUserId !== expectedScopeUserId ||
				validPeriodMonthFrom !== expectedScopePeriodMonthFrom ||
				validPeriodMonthUntil !== expectedScopePeriodMonthUntil
			) {
				throw new Error("Cursor scope mismatch");
			}
		}

		return {
			v: 1,
			userId: validUserId,
			periodMonthFrom: validPeriodMonthFrom,
			periodMonthUntil: validPeriodMonthUntil,
			periodMonth: validPeriodMonth,
		};
	} catch {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			"Invalid month-close pagination cursor",
		);
	}
}

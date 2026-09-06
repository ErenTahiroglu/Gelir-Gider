import { ImportError } from "./errors";
import type { RawImportRowInput } from "./normalize";

function getField(
	obj: Record<string, string>,
	...keys: string[]
): string | undefined {
	for (const k of keys) {
		const val = obj[k];
		if (val !== undefined && val !== "") {
			return val;
		}
	}
	return undefined;
}

/**
 * Pure, safe parser for GENERIC_CSV_V1 format.
 * Expects CSV text with header row.
 */
export function parseGenericCsvV1(csvContent: string): RawImportRowInput[] {
	if (typeof csvContent !== "string") {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"CSV content must be a string",
		);
	}

	const lines = csvContent
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	if (lines.length < 2) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"CSV content must contain a header row and at least one data row",
		);
	}

	const headerLine = lines[0];
	if (!headerLine) {
		throw new ImportError("IMPORT_INVALID_INPUT", "CSV header row is empty");
	}

	const headers = headerLine.split(",").map((h) =>
		h
			.trim()
			.toLowerCase()
			.replace(/^["']|["']$/g, ""),
	);

	const rows: RawImportRowInput[] = [];

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;

		// Basic comma splitting respecting simple quoted fields
		const values: string[] = [];
		let current = "";
		let inQuotes = false;

		for (let c = 0; c < line.length; c++) {
			const char = line[c];
			if (char === '"') {
				inQuotes = !inQuotes;
			} else if (char === "," && !inQuotes) {
				values.push(current.trim().replace(/^["']|["']$/g, ""));
				current = "";
			} else {
				current += char;
			}
		}
		values.push(current.trim().replace(/^["']|["']$/g, ""));

		const rowObj: Record<string, string> = {};
		for (let h = 0; h < headers.length; h++) {
			const head = headers[h];
			if (head) {
				rowObj[head] = values[h] ?? "";
			}
		}

		const rawRecordType = (
			getField(rowObj, "recordtype", "record_type", "type") ?? ""
		).toUpperCase();

		const rawDate =
			getField(
				rowObj,
				"date",
				"occurredat",
				"occurred_at",
				"receivedat",
				"received_at",
			) ?? "";

		const rawAmount = getField(rowObj, "amount") ?? "0";
		const rawExtId = getField(
			rowObj,
			"externalid",
			"external_id",
			"transactionid",
			"transaction_id",
		);

		if (
			rawRecordType === "CREDIT_CARD_PURCHASE" ||
			rawRecordType === "CARD_PURCHASE" ||
			rawRecordType === "PURCHASE"
		) {
			const instStr = getField(
				rowObj,
				"installmentcount",
				"installment_count",
				"installments",
			);
			rows.push({
				recordType: "CREDIT_CARD_PURCHASE",
				cardId: getField(rowObj, "cardid", "card_id"),
				occurredAt: rawDate,
				amount: rawAmount,
				purchaseCategory: getField(
					rowObj,
					"purchasecategory",
					"purchase_category",
					"category",
				),
				shortTermGoalId: getField(
					rowObj,
					"shorttermgoalid",
					"short_term_goal_id",
				),
				merchant: getField(rowObj, "merchant"),
				description: getField(rowObj, "description", "desc"),
				installmentCount: instStr ? Number(instStr) : undefined,
				externalTransactionId: rawExtId,
				rawRecord: rowObj,
			});
		} else if (
			rawRecordType === "INCOME_RECEIPT" ||
			rawRecordType === "INCOME" ||
			rawRecordType === "RECEIPT"
		) {
			rows.push({
				recordType: "INCOME_RECEIPT",
				incomeSourceId: getField(
					rowObj,
					"incomesourceid",
					"income_source_id",
					"sourceid",
					"source_id",
				),
				destinationAccountId: getField(
					rowObj,
					"destinationaccountid",
					"destination_account_id",
					"destaccountid",
				),
				receivedAt: rawDate,
				amount: rawAmount,
				note: getField(rowObj, "note"),
				externalTransactionId: rawExtId,
				rawRecord: rowObj,
			});
		} else {
			rows.push({
				recordType: "UNSUPPORTED",
				rawRecord: rowObj,
				reason: `Unsupported record type: ${rawRecordType || "UNKNOWN"}`,
				externalTransactionId: rawExtId,
			});
		}
	}

	return rows;
}

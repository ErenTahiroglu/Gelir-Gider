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
 * Pure RFC 4180 compliant CSV tokenizer/parser.
 * Correctly handles commas inside quotes, escaped double quotes (""),
 * CRLF/LF line breaks, and multi-line quoted fields.
 */
export function parseCsvRecords(csvContent: string): string[][] {
	if (typeof csvContent !== "string") {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"CSV content must be a string",
		);
	}

	const records: string[][] = [];
	let currentRecord: string[] = [];
	let currentField = "";
	let inQuotes = false;
	let i = 0;
	const len = csvContent.length;

	while (i < len) {
		const char = csvContent[i];

		if (inQuotes) {
			if (char === '"') {
				// Look ahead for escaped quote ("")
				if (i + 1 < len && csvContent[i + 1] === '"') {
					currentField += '"';
					i += 2;
					continue;
				}
				// End of quoted field
				inQuotes = false;
				i++;
				continue;
			}
			currentField += char;
			i++;
		} else {
			if (char === '"') {
				if (currentField.length === 0) {
					inQuotes = true;
					i++;
					continue;
				}
				// Quote inside unquoted field
				currentField += char;
				i++;
			} else if (char === ",") {
				currentRecord.push(currentField);
				currentField = "";
				i++;
			} else if (char === "\r") {
				if (i + 1 < len && csvContent[i + 1] === "\n") {
					i++; // skip \r, next is \n
				}
				currentRecord.push(currentField);
				currentField = "";
				records.push(currentRecord);
				currentRecord = [];
				i++;
			} else if (char === "\n") {
				currentRecord.push(currentField);
				currentField = "";
				records.push(currentRecord);
				currentRecord = [];
				i++;
			} else {
				currentField += char;
				i++;
			}
		}
	}

	if (inQuotes) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"Unterminated quoted string in CSV content",
		);
	}

	// Push trailing field/record if any content exists
	if (currentField.length > 0 || currentRecord.length > 0) {
		currentRecord.push(currentField);
		records.push(currentRecord);
	}

	// Filter out trailing completely empty records
	while (
		records.length > 0 &&
		records[records.length - 1]?.length === 1 &&
		records[records.length - 1]?.[0] === ""
	) {
		records.pop();
	}

	return records;
}

/**
 * Pure, safe parser for GENERIC_CSV_V1 format.
 * Expects CSV text with header row.
 */
export function parseGenericCsvV1(csvContent: string): RawImportRowInput[] {
	const records = parseCsvRecords(csvContent);

	if (records.length < 2) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"CSV content must contain a header row and at least one data row",
		);
	}

	const headerRow = records[0];
	if (
		!headerRow ||
		headerRow.length === 0 ||
		headerRow.every((h) => !h.trim())
	) {
		throw new ImportError("IMPORT_INVALID_INPUT", "CSV header row is empty");
	}

	const headers = headerRow.map((h) => h.trim().toLowerCase());
	const rows: RawImportRowInput[] = [];

	for (let i = 1; i < records.length; i++) {
		const record = records[i];
		if (!record || (record.length === 1 && record[0] === "")) continue;

		const rowObj: Record<string, string> = {};
		for (let h = 0; h < headers.length; h++) {
			const head = headers[h];
			if (head) {
				rowObj[head] = record[h] ?? "";
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

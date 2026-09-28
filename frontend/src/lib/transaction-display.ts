/**
 * Safe Runtime Presentation Helper for Heterogeneous Transaction Payloads
 *
 * Adheres strictly to Section 9, 10, 11, 12:
 *   - /transactions returns all canonical transaction domains.
 *   - payload is intentionally Record<string, unknown>.
 *   - NEVER assume universal payload fields.
 *   - MANUAL_EXPENSE:
 *       title: merchant -> description -> "Nakit / Banka Harcaması"
 *       amount: -₺... (negative visual tone)
 *       typeLabel: "Nakit / Banka"
 *   - Unknown or other kinds (e.g. CREDIT_CARD_PURCHASE):
 *       safe human-readable typeLabel
 *       safe title from verified string fields
 *       safe amount tone (neutral unless explicitly proven)
 *       unknown kinds: "Diğer İşlem"
 */

import { formatMoneyToTry } from "./money";

export interface TransactionDisplayModel {
	title: string;
	subtitle?: string | undefined;
	amountFormatted?: string | undefined;
	amountTone: "expense" | "income" | "neutral" | "unknown";
	typeLabel: string;
	isVoided: boolean;
	sourceAccountId?: string | undefined;
	spendingCategoryId?: string | undefined;
	budgetCategory?: string | undefined;
}

const KNOWN_KIND_LABELS: Record<string, string> = {
	MANUAL_EXPENSE: "Nakit / Banka",
	CREDIT_CARD_PURCHASE: "Kredi Kartı Harcaması",
	CREDIT_CARD_STATEMENT_PAYMENT: "Ekstre Ödemesi",
	CREDIT_CARD_PURCHASE_SPLIT: "Harcama Bölüşümü",
	CREDIT_CARD_REFUND: "İade",
	BANK_TRANSFER: "Banka Transferi",
	SALARY_INCOME: "Maaş Geliri",
};

export function getTransactionDisplayModel(transaction: {
	kind: string;
	status: "ACTIVE" | "VOIDED";
	payload?: Record<string, unknown> | null;
}): TransactionDisplayModel {
	const isVoided = transaction.status === "VOIDED";
	const payload = transaction.payload ?? {};

	// 1. Known kind label
	const typeLabel = KNOWN_KIND_LABELS[transaction.kind] ?? "Diğer İşlem";

	// 2. Safe string extractor helper
	const getString = (key: string): string | undefined => {
		const val = payload[key];
		return typeof val === "string" && val.trim().length > 0
			? val.trim()
			: undefined;
	};

	// 3. MANUAL_EXPENSE handling
	if (transaction.kind === "MANUAL_EXPENSE") {
		const merchant = getString("merchant");
		const description = getString("description");
		const sourceAssetAccountId = getString("sourceAssetAccountId");
		const spendingCategoryId = getString("spendingCategoryId");
		const budgetCategory = getString("budgetCategory");

		const title = merchant ?? description ?? "Nakit / Banka Harcaması";
		const subtitle =
			merchant && description && merchant !== description
				? description
				: undefined;

		let amountFormatted: string | undefined;
		const rawAmount = getString("amount");
		if (rawAmount && /^\d+(\.\d{2})?$/.test(rawAmount)) {
			// MANUAL_EXPENSE is always an expense: display as -₺...
			const formatted = formatMoneyToTry(
				rawAmount.includes(".") ? rawAmount : `${rawAmount}.00`,
			);
			amountFormatted = `-${formatted}`;
		}

		return {
			title,
			subtitle,
			amountFormatted,
			amountTone: "expense",
			typeLabel,
			isVoided,
			sourceAccountId: sourceAssetAccountId,
			spendingCategoryId,
			budgetCategory,
		};
	}

	// 4. Other or Unknown Transaction Kinds
	const title =
		getString("merchant") ??
		getString("description") ??
		getString("title") ??
		typeLabel;

	const subtitle =
		getString("note") ??
		getString("memo") ??
		(title !== getString("description") ? getString("description") : undefined);

	let amountFormatted: string | undefined;
	const rawAmount = getString("amount");
	if (rawAmount && /^\d+(\.\d{2})?$/.test(rawAmount)) {
		amountFormatted = formatMoneyToTry(
			rawAmount.includes(".") ? rawAmount : `${rawAmount}.00`,
		);
	}

	// For CREDIT_CARD_PURCHASE: expense tone
	let amountTone: "expense" | "income" | "neutral" | "unknown" = "neutral";
	if (transaction.kind === "CREDIT_CARD_PURCHASE") {
		amountTone = "expense";
		if (amountFormatted && !amountFormatted.startsWith("-")) {
			amountFormatted = `-${amountFormatted}`;
		}
	} else if (transaction.kind === "SALARY_INCOME") {
		amountTone = "income";
		if (amountFormatted && !amountFormatted.startsWith("+")) {
			amountFormatted = `+${amountFormatted}`;
		}
	}

	return {
		title,
		subtitle,
		amountFormatted,
		amountTone,
		typeLabel,
		isVoided,
		spendingCategoryId: getString("spendingCategoryId"),
		budgetCategory: getString("budgetCategory"),
	};
}

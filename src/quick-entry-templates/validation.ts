import {
	QUICK_ENTRY_TEMPLATE_TYPES,
	type QuickEntryTemplateType,
} from "../db/schema/quick-entry-templates";
import { QuickEntryTemplateError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const VALID_BUDGET_OVERRIDES = new Set([
	"MANDATORY_EXPENSE",
	"DISCRETIONARY_SPEND",
	"SHORT_TERM_PURCHASE",
]);

function validateOptionalUuid(
	value: unknown,
	fieldName: string,
): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			`${fieldName} must be a valid UUID`,
		);
	}
	return value.trim().toLowerCase();
}

function validateOptionalString(
	value: unknown,
	fieldName: string,
	maxLength = 255,
): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed.length > maxLength) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			`${fieldName} must not exceed ${maxLength} characters`,
		);
	}
	return trimmed;
}

function validateOptionalMoney(
	value: unknown,
	fieldName: string,
): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !MONEY_PATTERN.test(value.trim())) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			`${fieldName} must be a valid non-negative money string (e.g. "120.00")`,
		);
	}
	return value.trim();
}

function validateOptionalDate(
	value: unknown,
	fieldName: string,
): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !DATE_PATTERN.test(value.trim())) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			`${fieldName} must be a valid date in YYYY-MM-DD format`,
		);
	}
	return value.trim();
}

export function validateTemplateType(type: unknown): QuickEntryTemplateType {
	if (
		typeof type !== "string" ||
		!(QUICK_ENTRY_TEMPLATE_TYPES as readonly string[]).includes(type)
	) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			`Invalid templateType: "${String(type)}"`,
		);
	}
	return type as QuickEntryTemplateType;
}

export function validateTemplateConfig(
	templateType: QuickEntryTemplateType,
	rawConfig: unknown,
): Record<string, unknown> {
	if (
		typeof rawConfig !== "object" ||
		rawConfig === null ||
		Array.isArray(rawConfig)
	) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			"config must be an object",
		);
	}

	const c = rawConfig as Record<string, unknown>;
	const validated: Record<string, unknown> = {};

	switch (templateType) {
		case "CREDIT_CARD_EXPENSE": {
			const allowedKeys = new Set([
				"cardId",
				"spendingCategoryId",
				"budgetCategoryOverride",
				"merchant",
				"description",
				"shortTermGoalId",
				"defaultAmount",
			]);
			for (const key of Object.keys(c)) {
				if (!allowedKeys.has(key)) {
					throw new QuickEntryTemplateError(
						"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
						`Unknown config key for CREDIT_CARD_EXPENSE: "${key}"`,
					);
				}
			}

			if (c.cardId !== undefined) {
				validated.cardId = validateOptionalUuid(c.cardId, "cardId");
			}
			if (c.spendingCategoryId !== undefined) {
				validated.spendingCategoryId = validateOptionalUuid(
					c.spendingCategoryId,
					"spendingCategoryId",
				);
			}
			if (c.budgetCategoryOverride !== undefined) {
				if (
					typeof c.budgetCategoryOverride !== "string" ||
					!VALID_BUDGET_OVERRIDES.has(c.budgetCategoryOverride)
				) {
					throw new QuickEntryTemplateError(
						"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
						"budgetCategoryOverride must be MANDATORY_EXPENSE, DISCRETIONARY_SPEND, or SHORT_TERM_PURCHASE",
					);
				}
				validated.budgetCategoryOverride = c.budgetCategoryOverride;
			}
			if (c.merchant !== undefined) {
				validated.merchant = validateOptionalString(
					c.merchant,
					"merchant",
					100,
				);
			}
			if (c.description !== undefined) {
				validated.description = validateOptionalString(
					c.description,
					"description",
					255,
				);
			}
			if (c.shortTermGoalId !== undefined) {
				validated.shortTermGoalId = validateOptionalUuid(
					c.shortTermGoalId,
					"shortTermGoalId",
				);
			}
			if (c.defaultAmount !== undefined) {
				validated.defaultAmount = validateOptionalMoney(
					c.defaultAmount,
					"defaultAmount",
				);
			}
			break;
		}

		case "MANUAL_EXPENSE": {
			const allowedKeys = new Set([
				"sourceAssetAccountId",
				"spendingCategoryId",
				"budgetCategoryOverride",
				"merchant",
				"description",
				"defaultAmount",
			]);
			for (const key of Object.keys(c)) {
				if (!allowedKeys.has(key)) {
					throw new QuickEntryTemplateError(
						"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
						`Unknown config key for MANUAL_EXPENSE: "${key}"`,
					);
				}
			}

			if (c.sourceAssetAccountId !== undefined) {
				validated.sourceAssetAccountId = validateOptionalUuid(
					c.sourceAssetAccountId,
					"sourceAssetAccountId",
				);
			}
			if (c.spendingCategoryId !== undefined) {
				validated.spendingCategoryId = validateOptionalUuid(
					c.spendingCategoryId,
					"spendingCategoryId",
				);
			}
			if (c.budgetCategoryOverride !== undefined) {
				if (
					typeof c.budgetCategoryOverride !== "string" ||
					!VALID_BUDGET_OVERRIDES.has(c.budgetCategoryOverride)
				) {
					throw new QuickEntryTemplateError(
						"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
						"budgetCategoryOverride must be MANDATORY_EXPENSE, DISCRETIONARY_SPEND, or SHORT_TERM_PURCHASE",
					);
				}
				validated.budgetCategoryOverride = c.budgetCategoryOverride;
			}
			if (c.merchant !== undefined) {
				validated.merchant = validateOptionalString(
					c.merchant,
					"merchant",
					100,
				);
			}
			if (c.description !== undefined) {
				validated.description = validateOptionalString(
					c.description,
					"description",
					255,
				);
			}
			if (c.defaultAmount !== undefined) {
				validated.defaultAmount = validateOptionalMoney(
					c.defaultAmount,
					"defaultAmount",
				);
			}
			break;
		}

		case "INCOME": {
			const allowedKeys = new Set([
				"incomeSourceId",
				"description",
				"defaultAmount",
			]);
			for (const key of Object.keys(c)) {
				if (!allowedKeys.has(key)) {
					throw new QuickEntryTemplateError(
						"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
						`Unknown config key for INCOME: "${key}"`,
					);
				}
			}

			if (c.incomeSourceId !== undefined) {
				validated.incomeSourceId = validateOptionalUuid(
					c.incomeSourceId,
					"incomeSourceId",
				);
			}
			if (c.description !== undefined) {
				validated.description = validateOptionalString(
					c.description,
					"description",
					255,
				);
			}
			if (c.defaultAmount !== undefined) {
				validated.defaultAmount = validateOptionalMoney(
					c.defaultAmount,
					"defaultAmount",
				);
			}
			break;
		}

		case "RECEIVABLE":
		case "PAYABLE": {
			const allowedKeys = new Set([
				"personId",
				"description",
				"defaultAmount",
				"dueDate",
			]);
			for (const key of Object.keys(c)) {
				if (!allowedKeys.has(key)) {
					throw new QuickEntryTemplateError(
						"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
						`Unknown config key for ${templateType}: "${key}"`,
					);
				}
			}

			if (c.personId !== undefined) {
				validated.personId = validateOptionalUuid(c.personId, "personId");
			}
			if (c.description !== undefined) {
				validated.description = validateOptionalString(
					c.description,
					"description",
					255,
				);
			}
			if (c.defaultAmount !== undefined) {
				validated.defaultAmount = validateOptionalMoney(
					c.defaultAmount,
					"defaultAmount",
				);
			}
			if (c.dueDate !== undefined) {
				validated.dueDate = validateOptionalDate(c.dueDate, "dueDate");
			}
			break;
		}
	}

	return validated;
}

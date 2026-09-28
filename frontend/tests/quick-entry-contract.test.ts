import { describe, expect, it } from "vitest";
import type {
	CreditCardExpenseTemplateConfig,
	ManualExpenseTemplateConfig,
	QuickEntryTemplateItem,
	QuickEntryTemplatesResponse,
} from "../src/api/quick-entry-types";

describe("F4 Quick Entry Template Contract Invariants (Section 4, 5, 6, 60, 61)", () => {
	it("proves frontend template contract uses templateType, status, and defaultAmount", () => {
		const template: QuickEntryTemplateItem = {
			id: "tpl-canonical-1",
			userId: "usr-1",
			name: "Market Alışverişi",
			templateType: "MANUAL_EXPENSE",
			status: "ACTIVE",
			config: {
				sourceAssetAccountId: "acc-1",
				spendingCategoryId: "cat-1",
				budgetCategoryOverride: "MANDATORY_EXPENSE",
				merchant: "Migros",
				description: "Haftalık Market",
				defaultAmount: "350.00",
			},
			sortOrder: 1,
			createdAt: "2026-09-28T12:00:00.000Z",
			updatedAt: "2026-09-28T12:00:00.000Z",
		};

		// 1. Authoritative field name is templateType, NOT type
		expect(template.templateType).toBe("MANUAL_EXPENSE");
		expect(
			(template as unknown as Record<string, unknown>).type,
		).toBeUndefined();

		// 2. Authoritative field name is status, NOT isArchived
		expect(template.status).toBe("ACTIVE");
		expect(
			(template as unknown as Record<string, unknown>).isArchived,
		).toBeUndefined();

		// 3. Authoritative money field in config is defaultAmount, NOT amount
		const cfg = template.config as ManualExpenseTemplateConfig;
		expect(cfg.defaultAmount).toBe("350.00");
		expect((template.config as Record<string, unknown>).amount).toBeUndefined();
	});

	it("proves CREDIT_CARD_EXPENSE uses exact templateType and config keys", () => {
		const ccTemplate: QuickEntryTemplateItem = {
			id: "tpl-cc-1",
			userId: "usr-1",
			name: "Kahve",
			templateType: "CREDIT_CARD_EXPENSE",
			status: "ACTIVE",
			config: {
				cardId: "card-1",
				spendingCategoryId: "cat-2",
				budgetCategoryOverride: "DISCRETIONARY_SPEND",
				merchant: "Starbucks",
				description: "Latte",
				shortTermGoalId: "goal-1",
				defaultAmount: "120.00",
			},
			sortOrder: 2,
			createdAt: "2026-09-28T12:00:00.000Z",
			updatedAt: "2026-09-28T12:00:00.000Z",
		};

		expect(ccTemplate.templateType).toBe("CREDIT_CARD_EXPENSE");
		expect(
			(ccTemplate as unknown as Record<string, unknown>).purchaseCategory,
		).toBeUndefined();

		const cfg = ccTemplate.config as CreditCardExpenseTemplateConfig;
		expect(cfg.cardId).toBe("card-1");
		expect(cfg.defaultAmount).toBe("120.00");
		expect(cfg.shortTermGoalId).toBe("goal-1");
		expect((cfg as Record<string, unknown>).amount).toBeUndefined();
	});

	it("filters templates: only ACTIVE MANUAL_EXPENSE and CREDIT_CARD_EXPENSE are executable in F4", () => {
		const rawTemplates: QuickEntryTemplateItem[] = [
			{
				id: "t1",
				userId: "u1",
				name: "Aktif Nakit",
				templateType: "MANUAL_EXPENSE",
				status: "ACTIVE",
				config: { defaultAmount: "50.00" },
				sortOrder: 1,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
			{
				id: "t2",
				userId: "u1",
				name: "Arşivlenmiş Nakit",
				templateType: "MANUAL_EXPENSE",
				status: "ARCHIVED",
				config: { defaultAmount: "60.00" },
				sortOrder: 2,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
			{
				id: "t3",
				userId: "u1",
				name: "Aktif Kart",
				templateType: "CREDIT_CARD_EXPENSE",
				status: "ACTIVE",
				config: { defaultAmount: "100.00" },
				sortOrder: 3,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
			{
				id: "t4",
				userId: "u1",
				name: "Aktif Gelir",
				templateType: "INCOME",
				status: "ACTIVE",
				config: { defaultAmount: "5000.00" },
				sortOrder: 4,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		];

		const response: QuickEntryTemplatesResponse = { templates: rawTemplates };

		// Execution surfaces filter:
		const executable = response.templates.filter(
			(t) =>
				t.status === "ACTIVE" &&
				(t.templateType === "MANUAL_EXPENSE" ||
					t.templateType === "CREDIT_CARD_EXPENSE"),
		);

		expect(executable).toHaveLength(2);
		expect(executable.map((e) => e.id)).toEqual(["t1", "t3"]);
		expect(executable.find((e) => e.id === "t2")).toBeUndefined(); // ARCHIVED excluded
		expect(executable.find((e) => e.id === "t4")).toBeUndefined(); // INCOME excluded from F4 execution
	});
});

import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	type SpendingCategoryDefaultBudgetCategory,
	spendingCategories,
} from "../db/schema/spending-categories";
import { SpendingCategoryError } from "./errors";

export interface StarterCategoryDefinition {
	name: string;
	defaultBudgetCategory: SpendingCategoryDefaultBudgetCategory;
}

export const STARTER_SPENDING_CATEGORIES: StarterCategoryDefinition[] = [
	{ name: "Market", defaultBudgetCategory: "MANDATORY_EXPENSE" },
	{ name: "Dışarıda Yemek", defaultBudgetCategory: "ASK" },
	{ name: "Ulaşım", defaultBudgetCategory: "MANDATORY_EXPENSE" },
	{ name: "Akaryakıt", defaultBudgetCategory: "MANDATORY_EXPENSE" },
	{ name: "Sağlık", defaultBudgetCategory: "MANDATORY_EXPENSE" },
	{ name: "Giyim", defaultBudgetCategory: "ASK" },
	{ name: "Eğlence", defaultBudgetCategory: "DISCRETIONARY_SPEND" },
	{ name: "Abonelikler", defaultBudgetCategory: "ASK" },
	{ name: "Eğitim", defaultBudgetCategory: "ASK" },
	{ name: "Seyahat", defaultBudgetCategory: "ASK" },
	{ name: "Ev", defaultBudgetCategory: "MANDATORY_EXPENSE" },
	{ name: "Yurt Ücreti", defaultBudgetCategory: "MANDATORY_EXPENSE" },
	{ name: "Hediye", defaultBudgetCategory: "DISCRETIONARY_SPEND" },
	{ name: "Diğer", defaultBudgetCategory: "ASK" },
];

export const VALID_DEFAULT_BUDGET_CATEGORIES = new Set<string>([
	"MANDATORY_EXPENSE",
	"DISCRETIONARY_SPEND",
	"SHORT_TERM_PURCHASE",
	"ASK",
]);

export function validateCategoryName(name: unknown): string {
	if (typeof name !== "string") {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"Category name must be a string",
		);
	}
	const trimmed = name.trim();
	if (trimmed.length < 1 || trimmed.length > 100) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"Category name must be between 1 and 100 characters",
		);
	}
	return trimmed;
}

export function validateDefaultBudgetCategory(
	val: unknown,
): SpendingCategoryDefaultBudgetCategory {
	if (typeof val !== "string" || !VALID_DEFAULT_BUDGET_CATEGORIES.has(val)) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"Invalid defaultBudgetCategory. Must be MANDATORY_EXPENSE, DISCRETIONARY_SPEND, SHORT_TERM_PURCHASE, or ASK",
		);
	}
	return val as SpendingCategoryDefaultBudgetCategory;
}

export function validateSortOrder(val: unknown): number {
	if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"sortOrder must be a non-negative integer",
		);
	}
	return val;
}

export async function seedStarterCategoriesIfNeeded(
	db: Database,
	userId: string,
): Promise<{ seeded: boolean; count: number }> {
	const countRows = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(spendingCategories)
		.where(eq(spendingCategories.userId, userId));

	const total = countRows[0]?.total ?? 0;

	if (total > 0) {
		return { seeded: false, count: 0 };
	}

	const toInsert = STARTER_SPENDING_CATEGORIES.map((cat, idx) => ({
		userId,
		name: cat.name,
		defaultBudgetCategory: cat.defaultBudgetCategory,
		status: "ACTIVE" as const,
		sortOrder: idx,
	}));

	await db.insert(spendingCategories).values(toInsert);
	return { seeded: true, count: toInsert.length };
}

export async function listSpendingCategories(
	db: Database,
	userId: string,
): Promise<(typeof spendingCategories.$inferSelect)[]> {
	await seedStarterCategoriesIfNeeded(db, userId);

	return db
		.select()
		.from(spendingCategories)
		.where(eq(spendingCategories.userId, userId))
		.orderBy(
			asc(spendingCategories.sortOrder),
			asc(spendingCategories.name),
			asc(spendingCategories.id),
		);
}

export async function getSpendingCategory(
	db: Database,
	userId: string,
	categoryId: string,
): Promise<typeof spendingCategories.$inferSelect> {
	const [category] = await db
		.select()
		.from(spendingCategories)
		.where(
			and(
				eq(spendingCategories.userId, userId),
				eq(spendingCategories.id, categoryId),
			),
		);

	if (!category) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_NOT_FOUND",
			`Spending category not found: ${categoryId}`,
		);
	}

	return category;
}

export async function createSpendingCategory(
	db: Database,
	userId: string,
	params: {
		name: string;
		defaultBudgetCategory: string;
		sortOrder?: number | undefined;
	},
): Promise<typeof spendingCategories.$inferSelect> {
	const name = validateCategoryName(params.name);
	const defaultBudgetCategory = validateDefaultBudgetCategory(
		params.defaultBudgetCategory,
	);
	const sortOrder =
		params.sortOrder !== undefined ? validateSortOrder(params.sortOrder) : 0;

	const [created] = await db
		.insert(spendingCategories)
		.values({
			userId,
			name,
			defaultBudgetCategory,
			sortOrder,
			status: "ACTIVE",
		})
		.returning();

	if (!created) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"Failed to create spending category",
		);
	}

	return created;
}

export async function updateSpendingCategory(
	db: Database,
	userId: string,
	categoryId: string,
	params: {
		name?: string | undefined;
		defaultBudgetCategory?: string | undefined;
		sortOrder?: number | undefined;
	},
): Promise<typeof spendingCategories.$inferSelect> {
	await getSpendingCategory(db, userId, categoryId);

	const updatePayload: Partial<typeof spendingCategories.$inferInsert> = {
		updatedAt: new Date(),
	};

	if (params.name !== undefined) {
		updatePayload.name = validateCategoryName(params.name);
	}
	if (params.defaultBudgetCategory !== undefined) {
		updatePayload.defaultBudgetCategory = validateDefaultBudgetCategory(
			params.defaultBudgetCategory,
		);
	}
	if (params.sortOrder !== undefined) {
		updatePayload.sortOrder = validateSortOrder(params.sortOrder);
	}

	const [updated] = await db
		.update(spendingCategories)
		.set(updatePayload)
		.where(
			and(
				eq(spendingCategories.userId, userId),
				eq(spendingCategories.id, categoryId),
			),
		)
		.returning();

	if (!updated) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_NOT_FOUND",
			"Spending category not found",
		);
	}

	return updated;
}

export async function archiveSpendingCategory(
	db: Database,
	userId: string,
	categoryId: string,
): Promise<typeof spendingCategories.$inferSelect> {
	await getSpendingCategory(db, userId, categoryId);

	const [archived] = await db
		.update(spendingCategories)
		.set({
			status: "ARCHIVED",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(spendingCategories.userId, userId),
				eq(spendingCategories.id, categoryId),
			),
		)
		.returning();

	if (!archived) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_NOT_FOUND",
			"Spending category not found",
		);
	}

	return archived;
}

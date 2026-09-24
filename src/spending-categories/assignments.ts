import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	type SpendingCategorySubjectType,
	spendingCategories,
	spendingCategoryAssignments,
} from "../db/schema/spending-categories";
import { SpendingCategoryError } from "./errors";

export const VALID_SUBJECT_TYPES = new Set<string>([
	"CREDIT_CARD_PURCHASE",
	"MANUAL_EXPENSE",
]);

export function validateSubjectType(
	type: unknown,
): SpendingCategorySubjectType {
	if (typeof type !== "string" || !VALID_SUBJECT_TYPES.has(type)) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"Invalid subjectType. Must be CREDIT_CARD_PURCHASE or MANUAL_EXPENSE",
		);
	}
	return type as SpendingCategorySubjectType;
}

export async function upsertAssignment(
	db: Database,
	userId: string,
	params: {
		subjectType: string;
		subjectId: string;
		categoryId: string;
	},
): Promise<typeof spendingCategoryAssignments.$inferSelect> {
	const subjectType = validateSubjectType(params.subjectType);
	const subjectId = params.subjectId;
	const categoryId = params.categoryId;

	if (!subjectId || typeof subjectId !== "string") {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"subjectId must be a valid string",
		);
	}

	if (!categoryId || typeof categoryId !== "string") {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"categoryId must be a valid string",
		);
	}

	// Verify category exists and belongs to user
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
			`Category ${categoryId} not found for user`,
		);
	}

	const [upserted] = await db
		.insert(spendingCategoryAssignments)
		.values({
			userId,
			subjectType,
			subjectId,
			categoryId,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [
				spendingCategoryAssignments.userId,
				spendingCategoryAssignments.subjectType,
				spendingCategoryAssignments.subjectId,
			],
			set: {
				categoryId,
				updatedAt: new Date(),
			},
		})
		.returning();

	if (!upserted) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"Failed to upsert assignment",
		);
	}

	return upserted;
}

export async function bulkResolveAssignments(
	db: Database,
	userId: string,
	subjectType: string,
	subjectIds: string[],
): Promise<Record<string, string>> {
	const validatedType = validateSubjectType(subjectType);

	if (!Array.isArray(subjectIds)) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"subjectIds must be an array",
		);
	}

	if (subjectIds.length > 100) {
		throw new SpendingCategoryError(
			"SPENDING_CATEGORY_INVALID_INPUT",
			"Max 100 subject IDs allowed in bulk resolve",
		);
	}

	if (subjectIds.length === 0) {
		return {};
	}

	const rows = await db
		.select({
			subjectId: spendingCategoryAssignments.subjectId,
			categoryId: spendingCategoryAssignments.categoryId,
		})
		.from(spendingCategoryAssignments)
		.where(
			and(
				eq(spendingCategoryAssignments.userId, userId),
				eq(spendingCategoryAssignments.subjectType, validatedType),
				inArray(spendingCategoryAssignments.subjectId, subjectIds),
			),
		);

	const result: Record<string, string> = {};
	for (const row of rows) {
		result[row.subjectId] = row.categoryId;
	}

	return result;
}

export async function getAssignment(
	db: Database,
	userId: string,
	subjectType: string,
	subjectId: string,
): Promise<typeof spendingCategoryAssignments.$inferSelect | null> {
	const validatedType = validateSubjectType(subjectType);

	const [row] = await db
		.select()
		.from(spendingCategoryAssignments)
		.where(
			and(
				eq(spendingCategoryAssignments.userId, userId),
				eq(spendingCategoryAssignments.subjectType, validatedType),
				eq(spendingCategoryAssignments.subjectId, subjectId),
			),
		);

	return row ?? null;
}

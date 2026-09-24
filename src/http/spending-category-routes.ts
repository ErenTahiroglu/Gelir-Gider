import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import { getSpendingSummary } from "../spending-categories/analytics";
import {
	bulkResolveAssignments,
	getAssignment,
	upsertAssignment,
} from "../spending-categories/assignments";
import { SpendingCategoryError } from "../spending-categories/errors";
import {
	archiveSpendingCategory,
	createSpendingCategory,
	getSpendingCategory,
	listSpendingCategories,
	updateSpendingCategory,
} from "../spending-categories/service";
import {
	type AuthVariables,
	requireAuthenticatedSession,
} from "./auth-middleware";
import { errorEnvelope, sameOriginMutationGuard } from "./transport";

type SpendingCategoryEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables;
};

export const spendingCategoryRouter = new Hono<SpendingCategoryEnv>();

const BODY_LIMIT_BYTES = 32 * 1024;

function fail(c: Context<SpendingCategoryEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapSpendingCategoryError(
	c: Context<SpendingCategoryEnv>,
	err: unknown,
) {
	if (err instanceof SpendingCategoryError) {
		return fail(c, err.code, err.status);
	}
	return fail(c, "INTERNAL_ERROR", 500);
}

spendingCategoryRouter.use("*", sameOriginMutationGuard());
spendingCategoryRouter.use("*", requireAuthenticatedSession);
spendingCategoryRouter.post(
	"*",
	bodyLimit({
		maxSize: BODY_LIMIT_BYTES,
		onError: (c) => fail(c, "SPENDING_CATEGORY_INVALID_INPUT", 400),
	}),
);

/**
 * GET /spending/categories
 * Lists spending categories, seeding defaults if user has none.
 */
spendingCategoryRouter.get("/categories", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const categories = await listSpendingCategories(db, auth.userId);
		return c.json({ categories }, 200);
	} catch (err) {
		return mapSpendingCategoryError(c, err);
	}
});

/**
 * POST /spending/categories
 * Creates a new spending category.
 */
spendingCategoryRouter.post("/categories", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return fail(c, "SPENDING_CATEGORY_INVALID_INPUT", 400);
	}

	if (
		typeof body !== "object" ||
		body === null ||
		typeof body.name !== "string" ||
		typeof body.defaultBudgetCategory !== "string"
	) {
		return fail(c, "SPENDING_CATEGORY_INVALID_INPUT", 400);
	}

	try {
		const category = await createSpendingCategory(db, auth.userId, {
			name: body.name,
			defaultBudgetCategory: body.defaultBudgetCategory,
			sortOrder:
				typeof body.sortOrder === "number" ? body.sortOrder : undefined,
		});
		return c.json({ category }, 201);
	} catch (err) {
		return mapSpendingCategoryError(c, err);
	}
});

/**
 * POST /spending/categories/:id
 * Updates an existing category.
 */
spendingCategoryRouter.post("/categories/:id", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));
	const categoryId = c.req.param("id");

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return fail(c, "SPENDING_CATEGORY_INVALID_INPUT", 400);
	}

	if (typeof body !== "object" || body === null) {
		return fail(c, "SPENDING_CATEGORY_INVALID_INPUT", 400);
	}

	try {
		const category = await updateSpendingCategory(db, auth.userId, categoryId, {
			name: typeof body.name === "string" ? body.name : undefined,
			defaultBudgetCategory:
				typeof body.defaultBudgetCategory === "string"
					? body.defaultBudgetCategory
					: undefined,
			sortOrder:
				typeof body.sortOrder === "number" ? body.sortOrder : undefined,
		});
		return c.json({ category }, 200);
	} catch (err) {
		return mapSpendingCategoryError(c, err);
	}
});

/**
 * POST /spending/categories/:id/archive
 * Archives a spending category.
 */
spendingCategoryRouter.post("/categories/:id/archive", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));
	const categoryId = c.req.param("id");

	try {
		const category = await archiveSpendingCategory(db, auth.userId, categoryId);
		return c.json({ category }, 200);
	} catch (err) {
		return mapSpendingCategoryError(c, err);
	}
});

/**
 * GET /spending/category-assignments
 * Bulk resolves assignments or gets a single assignment.
 * Query params: subjectType, subjectIds (comma-separated or multiple) or subjectId
 */
spendingCategoryRouter.get("/category-assignments", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	const subjectType = c.req.query("subjectType");
	if (!subjectType) {
		return fail(c, "SPENDING_CATEGORY_INVALID_INPUT", 400);
	}

	const subjectId = c.req.query("subjectId");
	const subjectIdsQuery = c.req.query("subjectIds");

	let subjectIds: string[] = [];
	if (subjectIdsQuery) {
		subjectIds = subjectIdsQuery
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	} else if (subjectId) {
		subjectIds = [subjectId.trim()];
	}

	try {
		const assignments = await bulkResolveAssignments(
			db,
			auth.userId,
			subjectType,
			subjectIds,
		);
		return c.json({ assignments }, 200);
	} catch (err) {
		return mapSpendingCategoryError(c, err);
	}
});

/**
 * POST /spending/category-assignments
 * Upserts a spending category assignment.
 */
spendingCategoryRouter.post("/category-assignments", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return fail(c, "SPENDING_CATEGORY_INVALID_INPUT", 400);
	}

	if (
		typeof body !== "object" ||
		body === null ||
		typeof body.subjectType !== "string" ||
		typeof body.subjectId !== "string" ||
		typeof body.categoryId !== "string"
	) {
		return fail(c, "SPENDING_CATEGORY_INVALID_INPUT", 400);
	}

	try {
		const assignment = await upsertAssignment(db, auth.userId, {
			subjectType: body.subjectType,
			subjectId: body.subjectId,
			categoryId: body.categoryId,
		});
		return c.json({ assignment }, 200);
	} catch (err) {
		return mapSpendingCategoryError(c, err);
	}
});

/**
 * GET /spending/summary
 * Returns spending summary by category for a periodMonth (YYYY-MM).
 */
spendingCategoryRouter.get("/summary", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	const periodMonth = c.req.query("periodMonth");
	if (!periodMonth) {
		return fail(c, "SPENDING_CATEGORY_INVALID_INPUT", 400);
	}

	try {
		const summary = await getSpendingSummary(db, auth.userId, periodMonth);
		return c.json(summary, 200);
	} catch (err) {
		return mapSpendingCategoryError(c, err);
	}
});

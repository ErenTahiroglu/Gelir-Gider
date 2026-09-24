import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import { QuickEntryTemplateError } from "../quick-entry-templates/errors";
import {
	archiveTemplate,
	createTemplate,
	getTemplate,
	listTemplates,
	updateTemplate,
} from "../quick-entry-templates/service";
import {
	type AuthVariables,
	requireAuthenticatedSession,
} from "./auth-middleware";
import { errorEnvelope, sameOriginMutationGuard } from "./transport";

type QuickEntryTemplateEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables;
};

export const quickEntryTemplateRouter = new Hono<QuickEntryTemplateEnv>();

const BODY_LIMIT_BYTES = 32 * 1024;

function fail(c: Context<QuickEntryTemplateEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapTemplateError(c: Context<QuickEntryTemplateEnv>, err: unknown) {
	if (err instanceof QuickEntryTemplateError) {
		return fail(c, err.code, err.status);
	}
	return fail(c, "INTERNAL_ERROR", 500);
}

quickEntryTemplateRouter.use("*", sameOriginMutationGuard());
quickEntryTemplateRouter.use("*", requireAuthenticatedSession);
quickEntryTemplateRouter.post(
	"*",
	bodyLimit({
		maxSize: BODY_LIMIT_BYTES,
		onError: (c) => fail(c, "QUICK_ENTRY_TEMPLATE_INVALID_INPUT", 400),
	}),
);

/**
 * GET /quick-entry/templates
 * Lists all templates for the authenticated user.
 */
quickEntryTemplateRouter.get("/templates", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const templates = await listTemplates(db, auth.userId);
		return c.json({ templates }, 200);
	} catch (err) {
		return mapTemplateError(c, err);
	}
});

/**
 * GET /quick-entry/templates/:id
 * Gets a single template.
 */
quickEntryTemplateRouter.get("/templates/:id", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));
	const templateId = c.req.param("id");

	try {
		const template = await getTemplate(db, auth.userId, templateId);
		return c.json({ template }, 200);
	} catch (err) {
		return mapTemplateError(c, err);
	}
});

/**
 * POST /quick-entry/templates
 * Creates a new template.
 */
quickEntryTemplateRouter.post("/templates", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return fail(c, "QUICK_ENTRY_TEMPLATE_INVALID_INPUT", 400);
	}

	if (
		typeof body !== "object" ||
		body === null ||
		typeof body.name !== "string" ||
		typeof body.templateType !== "string"
	) {
		return fail(c, "QUICK_ENTRY_TEMPLATE_INVALID_INPUT", 400);
	}

	try {
		const template = await createTemplate(db, auth.userId, {
			name: body.name,
			templateType: body.templateType,
			config: body.config,
			sortOrder:
				typeof body.sortOrder === "number" ? body.sortOrder : undefined,
		});
		return c.json({ template }, 201);
	} catch (err) {
		return mapTemplateError(c, err);
	}
});

/**
 * POST /quick-entry/templates/:id
 * Updates an existing template.
 */
quickEntryTemplateRouter.post("/templates/:id", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));
	const templateId = c.req.param("id");

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return fail(c, "QUICK_ENTRY_TEMPLATE_INVALID_INPUT", 400);
	}

	if (typeof body !== "object" || body === null) {
		return fail(c, "QUICK_ENTRY_TEMPLATE_INVALID_INPUT", 400);
	}

	try {
		const template = await updateTemplate(db, auth.userId, templateId, {
			name: typeof body.name === "string" ? body.name : undefined,
			config: body.config !== undefined ? body.config : undefined,
			sortOrder:
				typeof body.sortOrder === "number" ? body.sortOrder : undefined,
		});
		return c.json({ template }, 200);
	} catch (err) {
		return mapTemplateError(c, err);
	}
});

/**
 * POST /quick-entry/templates/:id/archive
 * Archives a template.
 */
quickEntryTemplateRouter.post("/templates/:id/archive", async (c) => {
	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));
	const templateId = c.req.param("id");

	try {
		const template = await archiveTemplate(db, auth.userId, templateId);
		return c.json({ template }, 200);
	} catch (err) {
		return mapTemplateError(c, err);
	}
});

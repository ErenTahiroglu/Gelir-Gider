import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	type QuickEntryTemplateType,
	quickEntryTemplates,
} from "../db/schema/quick-entry-templates";
import { QuickEntryTemplateError } from "./errors";
import { validateTemplateConfig, validateTemplateType } from "./validation";

export function validateTemplateName(name: unknown): string {
	if (typeof name !== "string") {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			"Template name must be a string",
		);
	}
	const trimmed = name.trim();
	if (trimmed.length < 1 || trimmed.length > 100) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			"Template name must be between 1 and 100 characters",
		);
	}
	return trimmed;
}

export function validateSortOrder(val: unknown): number {
	if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			"sortOrder must be a non-negative integer",
		);
	}
	return val;
}

export async function listTemplates(
	db: Database,
	userId: string,
): Promise<(typeof quickEntryTemplates.$inferSelect)[]> {
	return db
		.select()
		.from(quickEntryTemplates)
		.where(eq(quickEntryTemplates.userId, userId))
		.orderBy(
			asc(quickEntryTemplates.sortOrder),
			asc(quickEntryTemplates.name),
			asc(quickEntryTemplates.id),
		);
}

export async function getTemplate(
	db: Database,
	userId: string,
	templateId: string,
): Promise<typeof quickEntryTemplates.$inferSelect> {
	const [template] = await db
		.select()
		.from(quickEntryTemplates)
		.where(
			and(
				eq(quickEntryTemplates.userId, userId),
				eq(quickEntryTemplates.id, templateId),
			),
		);

	if (!template) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_NOT_FOUND",
			`Template not found: ${templateId}`,
		);
	}

	return template;
}

export async function createTemplate(
	db: Database,
	userId: string,
	params: {
		name: string;
		templateType: string;
		config: unknown;
		sortOrder?: number | undefined;
	},
): Promise<typeof quickEntryTemplates.$inferSelect> {
	const name = validateTemplateName(params.name);
	const templateType = validateTemplateType(params.templateType);
	const config = validateTemplateConfig(templateType, params.config);
	const sortOrder =
		params.sortOrder !== undefined ? validateSortOrder(params.sortOrder) : 0;

	const [created] = await db
		.insert(quickEntryTemplates)
		.values({
			userId,
			name,
			templateType,
			config,
			sortOrder,
			status: "ACTIVE",
		})
		.returning();

	if (!created) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
			"Failed to create template",
		);
	}

	return created;
}

export async function updateTemplate(
	db: Database,
	userId: string,
	templateId: string,
	params: {
		name?: string | undefined;
		config?: unknown | undefined;
		sortOrder?: number | undefined;
	},
): Promise<typeof quickEntryTemplates.$inferSelect> {
	const current = await getTemplate(db, userId, templateId);

	const updatePayload: Partial<typeof quickEntryTemplates.$inferInsert> = {
		updatedAt: new Date(),
	};

	if (params.name !== undefined) {
		updatePayload.name = validateTemplateName(params.name);
	}
	if (params.config !== undefined) {
		updatePayload.config = validateTemplateConfig(
			current.templateType as QuickEntryTemplateType,
			params.config,
		);
	}
	if (params.sortOrder !== undefined) {
		updatePayload.sortOrder = validateSortOrder(params.sortOrder);
	}

	const [updated] = await db
		.update(quickEntryTemplates)
		.set(updatePayload)
		.where(
			and(
				eq(quickEntryTemplates.userId, userId),
				eq(quickEntryTemplates.id, templateId),
			),
		)
		.returning();

	if (!updated) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_NOT_FOUND",
			"Template not found",
		);
	}

	return updated;
}

export async function archiveTemplate(
	db: Database,
	userId: string,
	templateId: string,
): Promise<typeof quickEntryTemplates.$inferSelect> {
	await getTemplate(db, userId, templateId);

	const [archived] = await db
		.update(quickEntryTemplates)
		.set({
			status: "ARCHIVED",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(quickEntryTemplates.userId, userId),
				eq(quickEntryTemplates.id, templateId),
			),
		)
		.returning();

	if (!archived) {
		throw new QuickEntryTemplateError(
			"QUICK_ENTRY_TEMPLATE_NOT_FOUND",
			"Template not found",
		);
	}

	return archived;
}

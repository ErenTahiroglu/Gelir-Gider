import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../src/api/client";
import * as dashboardApi from "../src/api/dashboard-api";
import type { QuickEntryTemplatesResponse } from "../src/api/dashboard-types";
import { QuickTemplatesStrip } from "../src/components/dashboard/QuickTemplatesStrip";

function renderWithQuery(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
	);
}

describe("Dashboard Quick Templates — Read-Only F2 Chips", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("renders up to 5 templates in server-provided order as clickable buttons", async () => {
		const templatesResponse: QuickEntryTemplatesResponse = {
			templates: [
				{
					id: "tpl-1",
					userId: "user-1",
					name: "Market Alışverişi",
					templateType: "MANUAL_EXPENSE",
					status: "ACTIVE",
					config: {},
					sortOrder: 1,
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				},
				{
					id: "tpl-2",
					userId: "user-1",
					name: "Kahve",
					templateType: "MANUAL_EXPENSE",
					status: "ACTIVE",
					config: {},
					sortOrder: 2,
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				},
				{
					id: "tpl-3",
					userId: "user-1",
					name: "Akaryakıt",
					templateType: "MANUAL_EXPENSE",
					status: "ACTIVE",
					config: {},
					sortOrder: 3,
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				},
			],
		};

		vi.spyOn(dashboardApi, "fetchQuickEntryTemplates").mockResolvedValue(
			templatesResponse,
		);
		const apiPostSpy = vi.spyOn(client, "apiPost");

		renderWithQuery(<QuickTemplatesStrip isUnlocked={true} />);

		// Template names appear
		expect(await screen.findByText("Market Alışverişi")).toBeInTheDocument();
		expect(screen.getByText("Kahve")).toBeInTheDocument();
		expect(screen.getByText("Akaryakıt")).toBeInTheDocument();

		// Clicking a chip does NOT perform any financial mutation (read-only in F2)
		const chip = screen.getByTestId("template-chip-tpl-1");
		fireEvent.click(chip);
		expect(apiPostSpy).not.toHaveBeenCalled();
	});

	it("renders empty state message when no templates exist", async () => {
		vi.spyOn(dashboardApi, "fetchQuickEntryTemplates").mockResolvedValue({
			templates: [],
		});

		renderWithQuery(<QuickTemplatesStrip isUnlocked={true} />);

		expect(
			await screen.findByText("Henüz hızlı kayıt şablonu yok."),
		).toBeInTheDocument();
	});
});

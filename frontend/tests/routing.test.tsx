import fs from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ApiError } from "../src/api/errors";
import * as authApi from "../src/auth/auth-api";

describe("Routing & SPA Fallback Configuration", () => {
	it("wrangler.jsonc configures SPA fallback and worker routing precedence", () => {
		const wranglerPath = path.resolve(__dirname, "../../wrangler.jsonc");
		const content = fs.readFileSync(wranglerPath, "utf-8");
		// Strip comments to parse JSON
		const stripped = content.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "");
		const config = JSON.parse(stripped);

		expect(config.assets).toBeDefined();
		expect(config.assets.directory).toBe("./dist");
		expect(config.assets.binding).toBe("ASSETS");
		expect(config.assets.not_found_handling).toBe("single-page-application");
		expect(Array.isArray(config.assets.run_worker_first)).toBe(true);

		const runWorkerFirst = config.assets.run_worker_first as string[];
		expect(runWorkerFirst).toContain("/health");
		expect(runWorkerFirst).toContain("/ready");
		expect(runWorkerFirst).toContain("/auth/*");
		expect(runWorkerFirst).toContain("/budget-v2/*");
		expect(runWorkerFirst).toContain("/transactions/*");
		expect(runWorkerFirst).toContain("/credit-cards/*");
	});

	it("renders /unlock surface via router", async () => {
		vi.spyOn(authApi, "fetchAuthStatus").mockResolvedValue({
			state: "INITIALIZED",
		});
		vi.spyOn(authApi, "fetchAuthSession").mockRejectedValue(
			new ApiError({
				code: "UNAUTHENTICATED",
				message: "Authentication required",
				status: 401,
			}),
		);

		window.history.pushState({}, "Unlock", "/unlock");
		render(<App />);

		expect(
			await screen.findByRole("button", { name: /Passkey ile Kilidi Aç/i }),
		).toBeInTheDocument();
	});
});

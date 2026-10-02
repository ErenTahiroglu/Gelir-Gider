import fs from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PushSettings } from "../src/components/notifications/PushSettings";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to, ...props }: any) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
	useNavigate: () => vi.fn(),
	useParams: () => ({}),
	useSearch: () => ({}),
}));

describe("Workstream A — Product UI/UX and Push Configuration (RED Phase)", () => {
	it("proves missing frontend/src/styles/product-pages.css stylesheet", () => {
		const productPagesCssPath = path.resolve(
			__dirname,
			"../src/styles/product-pages.css",
		);
		// Before fix: product-pages.css does not exist
		expect(fs.existsSync(productPagesCssPath)).toBe(true);
	});

	it("proves main.tsx imports product-pages.css", () => {
		const mainTsxPath = path.resolve(__dirname, "../src/main.tsx");
		const content = fs.readFileSync(mainTsxPath, "utf8");
		expect(content).toContain("./styles/product-pages.css");
	});

	it("proves PushSettings renders 'Push bildirimleri bu ortamda yapılandırılmamış.' when VAPID key is absent", async () => {
		const webPush = await import("../src/lib/web-push");
		vi.spyOn(webPush, "isPushSupported").mockReturnValue(true);
		(globalThis as any).Notification = { permission: "default" };

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={queryClient}>
				<PushSettings />
			</QueryClientProvider>,
		);

		// Without VITE_WEB_PUSH_VAPID_PUBLIC_KEY set in test environment, it reproduces exact defect
		expect(
			screen.getByText("Push bildirimleri bu ortamda yapılandırılmamış."),
		).toBeInTheDocument();
	});
});

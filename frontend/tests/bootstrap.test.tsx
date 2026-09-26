import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../src/App";

describe("Frontend Bootstrap Shell", () => {
	it("renders the root application shell and title without crashing", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url === "/auth/status") {
				return Promise.resolve(
					new Response(JSON.stringify({ state: "INITIALIZED" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/session") {
				return Promise.resolve(
					new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);

		const mainElement = await screen.findByRole("main");
		expect(mainElement).toBeInTheDocument();

		const heading = screen.getByRole("heading", {
			level: 1,
			name: /gelir-gider/i,
		});
		expect(heading).toBeInTheDocument();
	});
});

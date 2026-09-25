import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../src/App";

describe("F0 Zero Authority / No Product Requests", () => {
	it("renders without triggering fetch or network requests", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		render(<App />);

		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});

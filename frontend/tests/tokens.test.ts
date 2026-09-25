import { describe, expect, it } from "vitest";

describe("Design Tokens & Theme Foundation", () => {
	it("supports data-theme attributes for theme switching", () => {
		document.documentElement.setAttribute("data-theme", "dark");
		expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

		document.documentElement.setAttribute("data-theme", "light");
		expect(document.documentElement.getAttribute("data-theme")).toBe("light");

		document.documentElement.removeAttribute("data-theme");
		expect(document.documentElement.getAttribute("data-theme")).toBeNull();
	});
});

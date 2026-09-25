import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";

describe("Frontend F0 Bootstrap", () => {
	it("renders the root application shell and title without crashing", () => {
		render(<App />);

		const mainElement = screen.getByRole("main");
		expect(mainElement).toBeInTheDocument();

		const heading = screen.getByRole("heading", {
			level: 1,
			name: /gelir-gider/i,
		});
		expect(heading).toBeInTheDocument();

		expect(screen.getByText(/foundation ready/i)).toBeInTheDocument();
	});
});

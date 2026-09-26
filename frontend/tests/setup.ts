import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Polyfill window.scrollTo for jsdom / router scroll restoration
if (typeof window !== "undefined") {
	window.scrollTo = vi.fn();

	// Mock PublicKeyCredential on window so browserSupportsWebAuthn() returns true in tests
	if (typeof window.PublicKeyCredential === "undefined") {
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		(window as any).PublicKeyCredential = class PublicKeyCredential {};
	}
}

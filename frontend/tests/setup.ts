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

	// Polyfill localStorage if missing
	if (typeof window.localStorage === "undefined" || !window.localStorage) {
		const storage = new Map<string, string>();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		(window as any).localStorage = {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, String(value)),
			removeItem: (key: string) => storage.delete(key),
			clear: () => storage.clear(),
		};
	}
	// Polyfill Blob.prototype.text / File.prototype.text if missing in jsdom
	if (typeof Blob !== "undefined" && !Blob.prototype.text) {
		Blob.prototype.text = function () {
			return new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result as string);
				reader.onerror = () => reject(reader.error);
				reader.readAsText(this);
			});
		};
	}
	if (typeof File !== "undefined" && !File.prototype.text) {
		File.prototype.text = function () {
			return new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result as string);
				reader.onerror = () => reject(reader.error);
				reader.readAsText(this);
			});
		};
	}
}

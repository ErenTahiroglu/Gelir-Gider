import { describe, expect, it } from "vitest";
import {
	generateRecoveryCode,
	hashRecoveryCode,
	normalizeRecoveryCode,
} from "../src/auth/recovery";

describe("Recovery Code Crypto & Formatting", () => {
	it("generates 32 base64url characters canonical code with 192 bits of entropy and 8x4 dot-separated display code", () => {
		const { canonical, display } = generateRecoveryCode();

		expect(canonical.length).toBe(32);
		expect(/^[A-Za-z0-9_-]{32}$/.test(canonical)).toBe(true);

		// Display format: 8 groups of 4 characters separated by '.'
		const parts = display.split(".");
		expect(parts.length).toBe(8);
		for (const part of parts) {
			expect(part.length).toBe(4);
		}
		expect(display.replace(/\./g, "")).toBe(canonical);
	});

	it("normalizes recovery code correctly by trimming and stripping dots without changing case", () => {
		const input = "  Abc1.234_.xyz8.9012.3456.7890.1234.567-  ";

		expect(normalizeRecoveryCode(input)).toBe(
			"Abc1234_xyz89012345678901234567-",
		);
	});

	it("rejects malformed recovery codes during normalization", () => {
		expect(() => normalizeRecoveryCode("")).toThrow("cannot be empty");
		expect(() => normalizeRecoveryCode("   ")).toThrow("cannot be empty");
		expect(() => normalizeRecoveryCode("short.code")).toThrow(
			"Invalid recovery code format",
		);
		expect(() =>
			normalizeRecoveryCode("invalid!char.1234.5678.9012.3456.7890.1234.5678"),
		).toThrow("Invalid recovery code format");
	});

	it("hashes recovery code to deterministic 64 lowercase hex characters", async () => {
		const code = "Abc1234_xyz89012345678901234567-";
		const hash1 = await hashRecoveryCode(code);
		const hash2 = await hashRecoveryCode(code);

		expect(hash1).toBe(hash2);
		expect(hash1.length).toBe(64);
		expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
		expect(hash1).not.toBe(code);
	});

	it("produces distinct hashes for different recovery codes", async () => {
		const code1 = generateRecoveryCode().canonical;
		const code2 = generateRecoveryCode().canonical;

		const hash1 = await hashRecoveryCode(code1);
		const hash2 = await hashRecoveryCode(code2);

		expect(hash1).not.toBe(hash2);
	});
});

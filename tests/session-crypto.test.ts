import { describe, expect, it } from "vitest";
import { generateSessionToken, hashSessionToken } from "../src/auth/sessions";

describe("Session Crypto Helper", () => {
	it("generates opaque session token with exact 43 base64url characters without padding", () => {
		const token = generateSessionToken();

		expect(typeof token).toBe("string");
		expect(token.length).toBe(43);
		expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
		expect(token.includes("=")).toBe(false);
		expect(token.includes("+")).toBe(false);
		expect(token.includes("/")).toBe(false);
	});

	it("generates 100 unique session tokens without collision", () => {
		const tokens = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const token = generateSessionToken();
			expect(tokens.has(token)).toBe(false);
			tokens.add(token);
		}
		expect(tokens.size).toBe(100);
	});

	it("hashes session token to deterministic 64 lowercase hex characters", async () => {
		const token = "Abc-123_xyz456TestTokenForHashingPurpose123";
		const hash1 = await hashSessionToken(token);
		const hash2 = await hashSessionToken(token);

		expect(hash1).toBe(hash2);
		expect(hash1.length).toBe(64);
		expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
		expect(hash1).not.toBe(token);
	});

	it("produces distinct hashes for different tokens", async () => {
		const token1 = generateSessionToken();
		const token2 = generateSessionToken();

		const hash1 = await hashSessionToken(token1);
		const hash2 = await hashSessionToken(token2);

		expect(hash1).not.toBe(hash2);
	});

	it("rejects empty or whitespace tokens", async () => {
		await expect(hashSessionToken("")).rejects.toThrow(
			"Session token cannot be empty",
		);
		await expect(hashSessionToken("   ")).rejects.toThrow(
			"Session token cannot be empty",
		);
	});
});

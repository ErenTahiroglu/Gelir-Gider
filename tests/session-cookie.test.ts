import { describe, expect, it } from "vitest";
import {
	buildClearSessionCookie,
	buildSessionCookie,
} from "../src/auth/session-cookie";
import {
	SESSION_ABSOLUTE_TTL_SECONDS,
	SESSION_COOKIE_NAME,
} from "../src/auth/sessions";

describe("Session Cookie Contract", () => {
	it("builds production session cookie with strict security flags and no domain attribute", () => {
		const token = "Abc-123_xyz456TestTokenForHashingPurpose123";
		const cookie = buildSessionCookie(token);

		expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${token}`);
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain(`Max-Age=${SESSION_ABSOLUTE_TTL_SECONDS}`);
		expect(cookie).not.toContain("Domain=");
		expect(cookie).not.toContain("SameSite=None");
		expect(cookie).not.toContain("SameSite=Lax");
	});

	it("builds clear session cookie with Max-Age=0 and strict security flags", () => {
		const clearCookie = buildClearSessionCookie();

		expect(clearCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
		expect(clearCookie).toContain("Path=/");
		expect(clearCookie).toContain("Secure");
		expect(clearCookie).toContain("HttpOnly");
		expect(clearCookie).toContain("SameSite=Strict");
		expect(clearCookie).toContain("Max-Age=0");
		expect(clearCookie).not.toContain("Domain=");
	});

	it("rejects empty token or invalid characters in token", () => {
		expect(() => buildSessionCookie("")).toThrow(
			"Session token cannot be empty",
		);
		expect(() => buildSessionCookie("token with spaces")).toThrow(
			"Invalid characters in session token",
		);
		expect(() => buildSessionCookie("token;with;semicolon")).toThrow(
			"Invalid characters in session token",
		);
	});
});

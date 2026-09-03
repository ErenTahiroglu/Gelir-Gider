import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/client";

describe("Database Client Factory", () => {
	it("throws an error when databaseUrl is an empty string", () => {
		expect(() => createDatabase("")).toThrow("DATABASE_URL is required");
	});

	it("throws an error when databaseUrl is whitespace-only", () => {
		expect(() => createDatabase("   ")).toThrow("DATABASE_URL is required");
	});

	it("constructs a Drizzle Neon Serverless client with transaction support without network queries", () => {
		const dummyUrl = "postgresql://user:password@example.invalid/db";
		const db = createDatabase(dummyUrl);

		expect(db).toBeDefined();
		expect(typeof db.transaction).toBe("function");
		expect(typeof db.select).toBe("function");
	});
});

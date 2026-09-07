import { describe, expect, it } from "vitest";
import {
	checkSchemaCompatibility,
	computeRestoreOrderFromSchema,
	denormalizeRowForInsert,
	isTargetEmpty,
	parseCliArgs,
	topologicalSortTables,
} from "../scripts/restore-backup";

describe("isTargetEmpty (empty-target guard)", () => {
	it("returns true when every table has zero rows", () => {
		expect(isTargetEmpty({ users: 0, canonical_transactions: 0 })).toBe(true);
	});

	it("returns false when any table has a non-zero row count", () => {
		expect(isTargetEmpty({ users: 1, canonical_transactions: 0 })).toBe(false);
	});

	it("returns true for an empty registry (vacuously true)", () => {
		expect(isTargetEmpty({})).toBe(true);
	});
});

describe("checkSchemaCompatibility", () => {
	it("reports compatible when every expected table/column exists in the target", () => {
		const result = checkSchemaCompatibility(
			[{ tableName: "users", columns: ["id", "display_name"] }],
			[{ tableName: "users", columns: ["id", "display_name", "extra_col"] }],
		);
		expect(result.compatible).toBe(true);
		expect(result.missingTables).toEqual([]);
	});

	it("reports a missing table", () => {
		const result = checkSchemaCompatibility(
			[
				{ tableName: "users", columns: ["id"] },
				{ tableName: "campaigns", columns: ["id"] },
			],
			[{ tableName: "users", columns: ["id"] }],
		);
		expect(result.compatible).toBe(false);
		expect(result.missingTables).toEqual(["campaigns"]);
	});

	it("reports missing columns for an existing table", () => {
		const result = checkSchemaCompatibility(
			[{ tableName: "users", columns: ["id", "display_name", "timezone"] }],
			[{ tableName: "users", columns: ["id"] }],
		);
		expect(result.compatible).toBe(false);
		expect(result.missingColumns.users).toEqual(["display_name", "timezone"]);
	});
});

describe("denormalizeRowForInsert (reverses export-time normalization)", () => {
	it("converts an ISO timestamp string back to a Date for a PgTimestamp column", () => {
		const columnMap = new Map([["createdAt", { columnType: "PgTimestamp" }]]);
		const result = denormalizeRowForInsert(
			{ createdAt: "2026-01-15T10:30:00.000Z" },
			columnMap,
		);
		expect(result.createdAt).toBeInstanceOf(Date);
		expect((result.createdAt as Date).toISOString()).toBe(
			"2026-01-15T10:30:00.000Z",
		);
	});

	it("converts a base64 string back to raw bytes for a PgCustomColumn (bytea)", () => {
		const columnMap = new Map([
			["publicKey", { columnType: "PgCustomColumn" }],
		]);
		const original = new Uint8Array([1, 2, 3, 255, 0]);
		const base64 = Buffer.from(original).toString("base64");
		const result = denormalizeRowForInsert({ publicKey: base64 }, columnMap);
		expect(result.publicKey).toBeInstanceOf(Uint8Array);
		expect(Array.from(result.publicKey as Uint8Array)).toEqual(
			Array.from(original),
		);
	});

	it("passes through null values unchanged regardless of column type", () => {
		const columnMap = new Map([["createdAt", { columnType: "PgTimestamp" }]]);
		const result = denormalizeRowForInsert({ createdAt: null }, columnMap);
		expect(result.createdAt).toBeNull();
	});

	it("passes through values for columns not in the map (e.g. text/uuid/numeric) unchanged", () => {
		const columnMap = new Map<string, { columnType: string }>();
		const result = denormalizeRowForInsert(
			{ id: "abc-123", amount: "42.50" },
			columnMap,
		);
		expect(result).toEqual({ id: "abc-123", amount: "42.50" });
	});
});

describe("topologicalSortTables (pure dependency ordering)", () => {
	it("orders a referenced table before its dependent", () => {
		const order = topologicalSortTables(["b", "a"], { b: ["a"] });
		expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
	});

	it("is deterministic (ties broken by name) across repeated calls", () => {
		const order1 = topologicalSortTables(["c", "a", "b"], {});
		const order2 = topologicalSortTables(["c", "a", "b"], {});
		expect(order1).toEqual(order2);
		expect(order1).toEqual(["a", "b", "c"]);
	});

	it("handles a multi-level dependency chain correctly", () => {
		const order = topologicalSortTables(["grandchild", "child", "parent"], {
			child: ["parent"],
			grandchild: ["child"],
		});
		expect(order).toEqual(["parent", "child", "grandchild"]);
	});

	it("throws on a cyclic dependency graph", () => {
		expect(() =>
			topologicalSortTables(["a", "b"], { a: ["b"], b: ["a"] }),
		).toThrow();
	});
});

describe("computeRestoreOrderFromSchema (derived from the real FK graph)", () => {
	it("orders users before backup_runs (an actual FK in this schema)", () => {
		const order = computeRestoreOrderFromSchema();
		expect(order.indexOf("users")).toBeLessThan(order.indexOf("backup_runs"));
	});

	it("orders backup_runs before backup_run_attempts", () => {
		const order = computeRestoreOrderFromSchema();
		expect(order.indexOf("backup_runs")).toBeLessThan(
			order.indexOf("backup_run_attempts"),
		);
	});

	it("includes every table exactly once", () => {
		const order = computeRestoreOrderFromSchema();
		expect(new Set(order).size).toBe(order.length);
		expect(order.length).toBeGreaterThan(10);
	});
});

describe("parseCliArgs", () => {
	it("parses --file and --confirm-empty-target", () => {
		const args = parseCliArgs([
			"--file",
			"backup.ggbak",
			"--confirm-empty-target",
		]);
		expect(args.filePath).toBe("backup.ggbak");
		expect(args.confirmEmptyTarget).toBe(true);
	});

	it("defaults confirmEmptyTarget to false when omitted", () => {
		const args = parseCliArgs(["--file", "backup.ggbak"]);
		expect(args.confirmEmptyTarget).toBe(false);
	});

	it("throws when --file is missing", () => {
		expect(() => parseCliArgs(["--confirm-empty-target"])).toThrow();
	});

	it("parses an optional --expect-key-id", () => {
		const args = parseCliArgs(["--file", "b.ggbak", "--expect-key-id", "v2"]);
		expect(args.expectedKeyId).toBe("v2");
	});
});

import { describe, expect, it } from "vitest";
import {
	canonicalizePayload,
	stringifyCanonicalJson,
} from "../src/transactions/canonical-json";
import { CanonicalTransactionError } from "../src/transactions/errors";

describe("Canonical JSON Serialization (Phase 5A)", () => {
	it("lexicographically sorts object keys deterministically regardless of insertion order", () => {
		const objA = {
			z: "last",
			a: "first",
			m: {
				b: 2,
				a: 1,
			},
		};

		const objB = {
			a: "first",
			m: {
				a: 1,
				b: 2,
			},
			z: "last",
		};

		const jsonA = stringifyCanonicalJson(objA);
		const jsonB = stringifyCanonicalJson(objB);

		expect(jsonA).toBe(jsonB);
		expect(jsonA).toBe('{"a":"first","m":{"a":1,"b":2},"z":"last"}');
	});

	it("preserves array element ordering while sorting nested objects inside arrays", () => {
		const payload = {
			items: [
				{ name: "Item 2", amount: "50.00", code: "B" },
				{ name: "Item 1", amount: "100.00", code: "A" },
			],
		};

		const json = stringifyCanonicalJson(payload);
		expect(json).toBe(
			'{"items":[{"amount":"50.00","code":"B","name":"Item 2"},{"amount":"100.00","code":"A","name":"Item 1"}]}',
		);
	});

	it("accepts valid primitives: null, string, boolean, and safe integers", () => {
		const payload = {
			text: "test",
			empty: null,
			flagTrue: true,
			flagFalse: false,
			count: 42,
			negativeCount: -5,
			zero: 0,
			maxSafe: Number.MAX_SAFE_INTEGER,
			minSafe: Number.MIN_SAFE_INTEGER,
		};

		const { canonicalObject } = canonicalizePayload(payload);
		expect(canonicalObject).toEqual(payload);
	});

	it("strictly rejects floating-point numbers in payload (requires money strings)", () => {
		expect(() =>
			stringifyCanonicalJson({
				amount: 123.45,
			}),
		).toThrow(CanonicalTransactionError);

		expect(() =>
			stringifyCanonicalJson({
				smallFloat: 0.1,
			}),
		).toThrow(/Floating-point and unsafe integer numbers are prohibited/);
	});

	it("rejects NaN, Infinity, -Infinity", () => {
		expect(() =>
			stringifyCanonicalJson({
				val: Number.NaN,
			}),
		).toThrow(/NaN and Infinity are prohibited/);

		expect(() =>
			stringifyCanonicalJson({
				val: Number.POSITIVE_INFINITY,
			}),
		).toThrow(/NaN and Infinity are prohibited/);
	});

	it("rejects non-serializable and non-plain types: Date, BigInt, undefined, Function, Symbol, RegExp, Map, Set", () => {
		expect(() => stringifyCanonicalJson({ date: new Date() })).toThrow(
			/Non-plain object instances are prohibited/,
		);
		expect(() => stringifyCanonicalJson({ big: 100n })).toThrow(
			/Prohibited payload value type/,
		);
		expect(() => stringifyCanonicalJson({ undef: undefined })).toThrow(
			/Undefined object property values are prohibited/,
		);
		expect(() => stringifyCanonicalJson({ fn: () => {} })).toThrow(
			/Prohibited payload value type/,
		);
		expect(() => stringifyCanonicalJson({ map: new Map() })).toThrow(
			/Non-plain object instances are prohibited/,
		);
		expect(() => stringifyCanonicalJson({ set: new Set() })).toThrow(
			/Non-plain object instances are prohibited/,
		);
	});

	it("rejects circular references", () => {
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;

		expect(() => stringifyCanonicalJson(circular)).toThrow(
			/Circular reference detected/,
		);
	});

	it("rejects depth exceeding 20 levels", () => {
		let current: Record<string, unknown> = { leaf: true };
		for (let i = 0; i < 25; i++) {
			current = { nested: current };
		}

		expect(() => stringifyCanonicalJson(current)).toThrow(
			/depth exceeded maximum allowed depth of 20/,
		);
	});

	it("rejects payloads exceeding 64 KiB (65536 bytes)", () => {
		const largeString = "a".repeat(70000);
		expect(() =>
			stringifyCanonicalJson({
				data: largeString,
			}),
		).toThrow(/exceeds maximum limit of 65536 bytes/);
	});

	it("rejects non-object root values (must be non-null plain object)", () => {
		expect(() => stringifyCanonicalJson(null)).toThrow(
			/must be a non-null plain JSON object/,
		);
		expect(() => stringifyCanonicalJson("string")).toThrow(
			/must be a non-null plain JSON object/,
		);
		expect(() => stringifyCanonicalJson([1, 2, 3])).toThrow(
			/must be a non-null plain JSON object/,
		);
	});
});

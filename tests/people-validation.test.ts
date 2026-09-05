import { describe, expect, it } from "vitest";
import { PeopleError } from "../src/people/errors";
import {
	validateCanonicalUuid,
	validateOptionalCanonicalUuid,
	validateOptionalEnum,
} from "../src/people/validation";

const VALID_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("validateCanonicalUuid", () => {
	it("accepts a well-formed UUID and normalizes to lowercase", () => {
		expect(validateCanonicalUuid(VALID_UUID.toUpperCase(), "id")).toBe(
			VALID_UUID,
		);
	});

	it("rejects an empty or whitespace string", () => {
		expect(() => validateCanonicalUuid("", "id")).toThrow(PeopleError);
		expect(() => validateCanonicalUuid("   ", "id")).toThrow(PeopleError);
	});

	it("rejects a non-UUID string with PEOPLE_INVALID_INPUT (no raw 22P02)", () => {
		try {
			validateCanonicalUuid("not-a-uuid", "personId");
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(PeopleError);
			expect((e as PeopleError).code).toBe("PEOPLE_INVALID_INPUT");
			expect((e as PeopleError).message).toContain("personId");
		}
	});

	it("rejects a UUID-shaped-but-invalid string (wrong segment lengths)", () => {
		expect(() => validateCanonicalUuid("aaaa-bbbb-cccc-dddd", "id")).toThrow(
			PeopleError,
		);
	});
});

describe("validateOptionalCanonicalUuid", () => {
	it("returns undefined only when the value itself is undefined", () => {
		expect(validateOptionalCanonicalUuid(undefined, "id")).toBeUndefined();
	});

	it("throws PEOPLE_INVALID_INPUT for an empty string filter (not silently omitted)", () => {
		expect(() => validateOptionalCanonicalUuid("", "id")).toThrow(PeopleError);
	});

	it("validates a provided UUID", () => {
		expect(validateOptionalCanonicalUuid(VALID_UUID, "id")).toBe(VALID_UUID);
	});
});

describe("validateOptionalEnum", () => {
	const ALLOWED = ["OPEN", "SETTLED", "VOID"] as const;

	it("returns undefined only when the value itself is undefined", () => {
		expect(validateOptionalEnum(undefined, ALLOWED, "status")).toBeUndefined();
	});

	it("accepts an allowed value", () => {
		expect(validateOptionalEnum("OPEN", ALLOWED, "status")).toBe("OPEN");
	});

	it("throws PEOPLE_INVALID_INPUT for an empty string filter (not an empty result set)", () => {
		expect(() =>
			validateOptionalEnum("" as unknown as "OPEN", ALLOWED, "status"),
		).toThrow(PeopleError);
	});

	it("throws PEOPLE_INVALID_INPUT for an unknown enum value", () => {
		try {
			validateOptionalEnum("BOGUS" as unknown as "OPEN", ALLOWED, "status");
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(PeopleError);
			expect((e as PeopleError).code).toBe("PEOPLE_INVALID_INPUT");
		}
	});
});

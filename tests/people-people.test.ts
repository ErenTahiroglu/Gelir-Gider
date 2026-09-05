import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/client";
import { PeopleError } from "../src/people/errors";
import {
	archivePerson,
	createPerson,
	updatePerson,
} from "../src/people/people";

const untouchedDb = {} as Database;
const OCCURRED_AT = new Date("2026-09-05T10:00:00.000Z");

describe("createPerson input validation", () => {
	it("rejects missing userId", async () => {
		await expect(
			createPerson({
				db: untouchedDb,
				userId: "",
				displayName: "Ayşe",
				relationship: "FRIEND",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError && e.code === "PEOPLE_INVALID_INPUT",
		);
	});

	it("rejects displayName over 120 characters", async () => {
		await expect(
			createPerson({
				db: untouchedDb,
				userId: "user-1",
				displayName: "a".repeat(121),
				relationship: "FRIEND",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects empty displayName", async () => {
		await expect(
			createPerson({
				db: untouchedDb,
				userId: "user-1",
				displayName: "   ",
				relationship: "FRIEND",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects an invalid relationship", async () => {
		await expect(
			createPerson({
				db: untouchedDb,
				userId: "user-1",
				displayName: "Ayşe",
				relationship: "COWORKER" as never,
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects a note over 500 characters", async () => {
		await expect(
			createPerson({
				db: untouchedDb,
				userId: "user-1",
				displayName: "Ayşe",
				relationship: "FRIEND",
				note: "a".repeat(501),
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects an invalid occurredAt", async () => {
		await expect(
			createPerson({
				db: untouchedDb,
				userId: "user-1",
				displayName: "Ayşe",
				relationship: "FRIEND",
				occurredAt: new Date("invalid"),
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects a missing idempotencyKey", async () => {
		await expect(
			createPerson({
				db: untouchedDb,
				userId: "user-1",
				displayName: "Ayşe",
				relationship: "FRIEND",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "",
			}),
		).rejects.toThrow(PeopleError);
	});
});

describe("updatePerson input validation", () => {
	it("rejects a missing personId", async () => {
		await expect(
			updatePerson({
				db: untouchedDb,
				userId: "user-1",
				personId: "",
				expectedRevisionNo: 1,
				displayName: "Ayşe",
				relationship: "FRIEND",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError && e.code === "PEOPLE_INVALID_INPUT",
		);
	});
});

describe("archivePerson input validation", () => {
	it("rejects a missing idempotencyKey", async () => {
		await expect(
			archivePerson({
				db: untouchedDb,
				userId: "user-1",
				personId: "person-1",
				expectedRevisionNo: 1,
				occurredAt: OCCURRED_AT,
				idempotencyKey: "",
			}),
		).rejects.toThrow(PeopleError);
	});
});

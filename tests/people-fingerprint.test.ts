import { describe, expect, it } from "vitest";
import {
	calculateObligationCreateFingerprint,
	calculateObligationUpdateFingerprint,
	calculateObligationVoidFingerprint,
	calculatePersonArchiveFingerprint,
	calculatePersonCreateFingerprint,
	calculatePersonUpdateFingerprint,
	calculateSettlementCreateFingerprint,
	calculateSettlementVoidFingerprint,
} from "../src/people/fingerprint";

const BASE_DATE = new Date("2026-09-05T10:00:00.000Z");
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PERSON_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OBLIGATION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SETTLEMENT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const ACCOUNT_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

describe("Person revision fingerprints", () => {
	it("CREATE returns 64-hex string and is deterministic", async () => {
		const params = {
			userId: USER_ID,
			displayName: "Ayşe",
			relationship: "FRIEND",
			note: null,
			occurredAt: BASE_DATE,
		};
		const fp1 = await calculatePersonCreateFingerprint(params);
		const fp2 = await calculatePersonCreateFingerprint(params);
		expect(fp1).toMatch(/^[0-9a-f]{64}$/);
		expect(fp1).toBe(fp2);
	});

	it("CREATE changes when displayName changes", async () => {
		const base = {
			userId: USER_ID,
			displayName: "Ayşe",
			relationship: "FRIEND" as const,
			note: null,
			occurredAt: BASE_DATE,
		};
		const fp1 = await calculatePersonCreateFingerprint(base);
		const fp2 = await calculatePersonCreateFingerprint({
			...base,
			displayName: "Fatma",
		});
		expect(fp1).not.toBe(fp2);
	});

	it("UPDATE is scoped to personId and expectedRevisionNo", async () => {
		const base = {
			userId: USER_ID,
			personId: PERSON_ID,
			expectedRevisionNo: 1,
			displayName: "Ayşe",
			relationship: "FRIEND" as const,
			note: null,
			occurredAt: BASE_DATE,
		};
		const fp1 = await calculatePersonUpdateFingerprint(base);
		const fp2 = await calculatePersonUpdateFingerprint({
			...base,
			expectedRevisionNo: 2,
		});
		expect(fp1).not.toBe(fp2);
	});

	it("ARCHIVE returns 64-hex string", async () => {
		const fp = await calculatePersonArchiveFingerprint({
			userId: USER_ID,
			personId: PERSON_ID,
			expectedRevisionNo: 2,
			occurredAt: BASE_DATE,
		});
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("Person obligation revision fingerprints", () => {
	it("CREATE differs between RECEIVABLE and PAYABLE for otherwise identical inputs", async () => {
		const base = {
			userId: USER_ID,
			personId: PERSON_ID,
			amount: "1000.00",
			fundingAssetAccountId: null,
			budgetCategory: null,
			dueDate: null,
			description: null,
			occurredAt: BASE_DATE,
		};
		const receivable = await calculateObligationCreateFingerprint({
			...base,
			direction: "RECEIVABLE",
			fundingAssetAccountId: ACCOUNT_ID,
		});
		const payable = await calculateObligationCreateFingerprint({
			...base,
			direction: "PAYABLE",
			budgetCategory: "UNCLASSIFIED",
		});
		expect(receivable).not.toBe(payable);
	});

	it("CREATE is deterministic for identical inputs", async () => {
		const params = {
			userId: USER_ID,
			personId: PERSON_ID,
			direction: "RECEIVABLE" as const,
			amount: "2745.00",
			fundingAssetAccountId: ACCOUNT_ID,
			budgetCategory: null,
			dueDate: null,
			description: null,
			occurredAt: BASE_DATE,
		};
		const fp1 = await calculateObligationCreateFingerprint(params);
		const fp2 = await calculateObligationCreateFingerprint(params);
		expect(fp1).toBe(fp2);
	});

	it("UPDATE changes when amount changes", async () => {
		const base = {
			userId: USER_ID,
			obligationId: OBLIGATION_ID,
			expectedRevisionNo: 1,
			amount: "1000.00",
			fundingAssetAccountId: ACCOUNT_ID,
			budgetCategory: null,
			dueDate: null,
			description: null,
			occurredAt: BASE_DATE,
		};
		const fp1 = await calculateObligationUpdateFingerprint(base);
		const fp2 = await calculateObligationUpdateFingerprint({
			...base,
			amount: "1200.00",
		});
		expect(fp1).not.toBe(fp2);
	});

	it("VOID returns 64-hex string", async () => {
		const fp = await calculateObligationVoidFingerprint({
			userId: USER_ID,
			obligationId: OBLIGATION_ID,
			expectedRevisionNo: 2,
		});
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("Person settlement revision fingerprints", () => {
	it("CREATE is deterministic and changes with cashAmount", async () => {
		const base = {
			userId: USER_ID,
			obligationId: OBLIGATION_ID,
			direction: "RECEIVABLE" as const,
			assetAccountId: ACCOUNT_ID,
			cashAmount: "3000.00",
			occurredAt: BASE_DATE,
			note: null,
		};
		const fp1 = await calculateSettlementCreateFingerprint(base);
		const fp2 = await calculateSettlementCreateFingerprint(base);
		expect(fp1).toBe(fp2);

		const fp3 = await calculateSettlementCreateFingerprint({
			...base,
			cashAmount: "2745.00",
		});
		expect(fp1).not.toBe(fp3);
	});

	it("VOID returns 64-hex string", async () => {
		const fp = await calculateSettlementVoidFingerprint({
			userId: USER_ID,
			settlementId: SETTLEMENT_ID,
			expectedRevisionNo: 1,
		});
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});

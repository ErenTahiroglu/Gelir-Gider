import { describe, expect, it } from "vitest";
import migration0061Sql from "../migrations/0061_add_budget_policy_v2_foundation.sql?raw";
import { BudgetError } from "../src/budget/errors";
import {
	BUDGET_V2_PAYLOAD_INPUT_KEYS,
	BUDGET_V2_PAYLOAD_OUTPUT_KEYS,
	BUDGET_V2_PAYLOAD_TOP_KEYS,
	buildBudgetV2CanonicalPayload,
	validateBudgetV2ResolvedSnapshot,
} from "../src/budget/payload-v2";
import { allocatePersonalBudgetV2 } from "../src/budget/policy-v2";

const INPUTS = {
	realizedIncome: "12000.00",
	currentObligations: "1500.00",
	basicLivingFunding: "2000.00",
	dateBoundNecessaryPurchaseFunding: "500.00",
	coreEmergencyFundBalance: "8000.00",
	mobilityBalance: "37500.00",
};

const EVIDENCE = {
	resolver: "test-fixture",
	notes: ["controlled snapshot"],
	nested: { version: 1, flag: true },
};

function buildFromInputs(
	inputs: Record<string, string> = INPUTS,
	evidence: Record<string, unknown> = EVIDENCE,
) {
	const policyResult = allocatePersonalBudgetV2(
		inputs as unknown as typeof INPUTS,
	);
	return buildBudgetV2CanonicalPayload({
		periodMonth: "2026-09-01",
		currency: "TRY",
		policyResult,
		evidenceSnapshot: evidence,
	});
}

describe("PERSONAL_BUDGET_V2 canonical payload producer (contract)", () => {
	it("A: emits exactly the 6 top-level keys", () => {
		const payload = buildFromInputs();
		expect(Object.keys(payload).sort()).toEqual(
			[...BUDGET_V2_PAYLOAD_TOP_KEYS].sort(),
		);
		expect(payload.policyVersion).toBe("PERSONAL_BUDGET_V2");
		expect(payload.periodMonth).toBe("2026-09-01");
		expect(payload.currency).toBe("TRY");
	});

	it("A: inputs has exactly the 6 input keys, all canonical money strings", () => {
		const payload = buildFromInputs();
		const inputs = payload.inputs as Record<string, unknown>;
		expect(Object.keys(inputs).sort()).toEqual(
			[...BUDGET_V2_PAYLOAD_INPUT_KEYS].sort(),
		);
		for (const v of Object.values(inputs)) {
			expect(typeof v).toBe("string");
			expect(v as string).toMatch(/^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/);
		}
	});

	it("A: outputs has exactly the 6 output keys, all canonical money strings", () => {
		const payload = buildFromInputs();
		const outputs = payload.outputs as Record<string, unknown>;
		expect(Object.keys(outputs).sort()).toEqual(
			[...BUDGET_V2_PAYLOAD_OUTPUT_KEYS].sort(),
		);
		for (const v of Object.values(outputs)) {
			expect(typeof v).toBe("string");
			expect(v as string).toMatch(/^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/);
		}
	});

	it("A: passes the evidence object through byte-for-byte and injects nothing else", () => {
		const payload = buildFromInputs();
		expect(payload.evidenceSnapshot).toEqual(EVIDENCE);
		// No recommendation / behavior / family text anywhere in the payload.
		const json = JSON.stringify(payload);
		for (const forbidden of [
			"recommendation",
			"behavior",
			"family",
			"cents",
			"BigInt",
		]) {
			expect(json.toLowerCase()).not.toContain(forbidden.toLowerCase());
		}
	});

	it("A: never serializes the BigInt `.cents` values (JSON.stringify would throw if they leaked)", () => {
		const payload = buildFromInputs();
		expect(() => JSON.stringify(payload)).not.toThrow();
		expect(JSON.stringify(payload)).not.toContain("n,"); // no bigint literal residue
	});

	it("A: payload matches the exact policy amounts (strings), not recomputed", () => {
		const policyResult = allocatePersonalBudgetV2(INPUTS);
		const payload = buildBudgetV2CanonicalPayload({
			periodMonth: "2026-09-01",
			currency: "TRY",
			policyResult,
			evidenceSnapshot: EVIDENCE,
		});
		const outputs = payload.outputs as Record<string, string>;
		expect(outputs.trueSurplus).toBe(policyResult.outputs.trueSurplus.amount);
		expect(outputs.mobilityAllocation).toBe(
			policyResult.outputs.mobilityAllocation.amount,
		);
		expect(outputs.longTermInvestment).toBe(
			policyResult.outputs.longTermInvestment.amount,
		);
		expect(outputs.discretionaryAllocation).toBe(
			policyResult.outputs.discretionaryAllocation.amount,
		);
	});
});

describe("Producer <-> migration 0061 contract drift guard", () => {
	function keysAfter(marker: string): string[] {
		// Collect every  <marker> ? 'key'  reference in the 0061 guard.
		const re = new RegExp(`${marker}\\s*\\?\\s*'([a-zA-Z]+)'`, "g");
		const found = new Set<string>();
		for (const m of migration0061Sql.matchAll(re)) {
			if (m[1]) found.add(m[1]);
		}
		return [...found].sort();
	}

	it("0061 top-level payload key set == producer top-level key set", () => {
		expect(keysAfter("v_payload")).toEqual(
			[...BUDGET_V2_PAYLOAD_TOP_KEYS].sort(),
		);
	});

	it("0061 inputs key set == producer inputs key set", () => {
		expect(keysAfter("v_inputs")).toEqual(
			[...BUDGET_V2_PAYLOAD_INPUT_KEYS].sort(),
		);
	});

	it("0061 outputs key set == producer outputs key set", () => {
		expect(keysAfter("v_outputs")).toEqual(
			[...BUDGET_V2_PAYLOAD_OUTPUT_KEYS].sort(),
		);
	});

	it("0061 enforces exactly 6 keys at each level", () => {
		expect(migration0061Sql).toContain(
			"V2 payload must have exactly 6 top-level keys",
		);
		expect(migration0061Sql).toContain(
			"canonical payload inputs must have exactly 6 keys",
		);
		expect(migration0061Sql).toContain(
			"canonical payload outputs must have exactly 6 keys",
		);
	});

	it("the built payload's runtime key sets satisfy the 0061 count + membership checks", () => {
		const payload = buildFromInputs();
		expect(Object.keys(payload)).toHaveLength(6);
		expect(Object.keys(payload.inputs as object)).toHaveLength(6);
		expect(Object.keys(payload.outputs as object)).toHaveLength(6);
	});
});

describe("validateBudgetV2ResolvedSnapshot", () => {
	it("accepts a well-formed snapshot and returns normalized inputs + policy result", () => {
		const v = validateBudgetV2ResolvedSnapshot({
			inputs: INPUTS,
			evidenceSnapshot: EVIDENCE,
		});
		expect(v.inputs.realizedIncome).toBe("12000.00");
		expect(v.policyResult.policyVersion).toBe("PERSONAL_BUDGET_V2");
		expect(v.evidenceSnapshot).toEqual(EVIDENCE);
	});

	it("normalizes short money strings to canonical form", () => {
		const v = validateBudgetV2ResolvedSnapshot({
			inputs: { ...INPUTS, realizedIncome: "12000" },
			evidenceSnapshot: {},
		});
		expect(v.inputs.realizedIncome).toBe("12000.00");
	});

	it("rejects a missing/extra input key", () => {
		expect(() =>
			validateBudgetV2ResolvedSnapshot({
				inputs: { realizedIncome: "1.00" },
				evidenceSnapshot: {},
			}),
		).toThrow(BudgetError);
		expect(() =>
			validateBudgetV2ResolvedSnapshot({
				inputs: { ...INPUTS, extra: "1.00" },
				evidenceSnapshot: {},
			}),
		).toThrow(BudgetError);
	});

	it("rejects malformed / negative money in inputs with BUDGET_INVALID_INPUT", () => {
		for (const bad of ["-1.00", "abc", "1.234", "1,0", "NaN"]) {
			try {
				validateBudgetV2ResolvedSnapshot({
					inputs: { ...INPUTS, mobilityBalance: bad },
					evidenceSnapshot: {},
				});
				throw new Error(`expected throw for ${bad}`);
			} catch (e) {
				expect(e).toBeInstanceOf(BudgetError);
				expect((e as BudgetError).code).toBe("BUDGET_INVALID_INPUT");
			}
		}
	});

	it("rejects a non-object / array / null evidenceSnapshot", () => {
		for (const bad of [null, [], "x", 3, true]) {
			expect(() =>
				validateBudgetV2ResolvedSnapshot({
					inputs: INPUTS,
					evidenceSnapshot: bad as unknown as Record<string, unknown>,
				}),
			).toThrow(BudgetError);
		}
	});

	it("rejects non-JSON-safe evidence (BigInt / undefined / Date / NaN / function) as BUDGET_INVALID_INPUT", () => {
		const badEvidences: Array<Record<string, unknown>> = [
			{ x: 1n },
			{ x: undefined },
			{ x: new Date() },
			{ x: Number.NaN },
			{ x: () => 1 },
			{ x: 1.5 }, // floating point number must be a string
		];
		for (const ev of badEvidences) {
			try {
				validateBudgetV2ResolvedSnapshot({
					inputs: INPUTS,
					evidenceSnapshot: ev,
				});
				throw new Error(
					`expected throw for ${JSON.stringify(Object.keys(ev))}`,
				);
			} catch (e) {
				expect(e).toBeInstanceOf(BudgetError);
				expect((e as BudgetError).code).toBe("BUDGET_INVALID_INPUT");
			}
		}
	});
});

describe("Resolved snapshot exact top-level shape (fail-closed boundary)", () => {
	// A
	it("A: exactly { inputs, evidenceSnapshot } is accepted", () => {
		const v = validateBudgetV2ResolvedSnapshot({
			inputs: INPUTS,
			evidenceSnapshot: EVIDENCE,
		});
		expect(v.policyResult.policyVersion).toBe("PERSONAL_BUDGET_V2");
	});

	// B
	it("B: an unknown extra top-level key is rejected with BUDGET_INVALID_INPUT", () => {
		for (const extra of [
			{ inputs: INPUTS, evidenceSnapshot: {}, currentObligations: "1.00" },
			{ inputs: INPUTS, evidenceSnapshot: {}, provenance: { type: "X" } },
			{ inputs: INPUTS, evidenceSnapshot: {}, outputs: {} },
		]) {
			try {
				validateBudgetV2ResolvedSnapshot(extra);
				throw new Error("expected throw");
			} catch (e) {
				expect(e).toBeInstanceOf(BudgetError);
				expect((e as BudgetError).code).toBe("BUDGET_INVALID_INPUT");
			}
		}
	});

	// C
	it("C: a missing required top-level key is rejected", () => {
		for (const missing of [{ inputs: INPUTS }, { evidenceSnapshot: {} }, {}]) {
			expect(() => validateBudgetV2ResolvedSnapshot(missing)).toThrow(
				BudgetError,
			);
		}
	});
});

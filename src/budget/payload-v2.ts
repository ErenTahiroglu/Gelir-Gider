import { canonicalizePayload } from "../transactions/canonical-json";
import { CanonicalTransactionError } from "../transactions/errors";
import { BudgetError } from "./errors";
import {
	allocatePersonalBudgetV2,
	PERSONAL_BUDGET_V2,
	type PersonalBudgetV2Inputs,
	type PersonalBudgetV2Result,
} from "./policy-v2";

/**
 * The exact PERSONAL_BUDGET_V2 canonical payload contract. These key sets are
 * the single source of truth shared by the application producer
 * (`buildBudgetV2CanonicalPayload`) and asserted against the DB guard added in
 * migration 0061 (`trg_fn_guard_monthly_budget_v2_plan_revisions_insert`), so
 * a drift in either direction fails a regression test.
 */
export const BUDGET_V2_PAYLOAD_TOP_KEYS = [
	"periodMonth",
	"policyVersion",
	"currency",
	"inputs",
	"outputs",
	"evidenceSnapshot",
] as const;

export const BUDGET_V2_PAYLOAD_INPUT_KEYS = [
	"realizedIncome",
	"currentObligations",
	"basicLivingFunding",
	"dateBoundNecessaryPurchaseFunding",
	"coreEmergencyFundBalance",
	"mobilityBalance",
] as const;

export const BUDGET_V2_PAYLOAD_OUTPUT_KEYS = [
	"emergencyCatchUp",
	"deficit",
	"trueSurplus",
	"mobilityAllocation",
	"longTermInvestment",
	"discretionaryAllocation",
] as const;

/**
 * Internal boundary object: ALREADY-RESOLVED PERSONAL_BUDGET_V2 inputs plus a
 * caller-supplied evidence object. This is NOT a public HTTP DTO and must not
 * be exposed through HTTP. A later checkpoint builds the authoritative
 * resolver that produces this from live Income / Cards / People / Goals; for
 * now, lifecycle callers (and tests) supply a controlled, trusted snapshot.
 */
export interface BudgetV2ResolvedSnapshot {
	inputs: PersonalBudgetV2Inputs;
	evidenceSnapshot: Record<string, unknown>;
}

export interface ValidatedBudgetV2Snapshot {
	/** Normalized canonical money strings for the six inputs. */
	inputs: PersonalBudgetV2Inputs;
	evidenceSnapshot: Record<string, unknown>;
	/** Deterministic policy result (BigInt cents live here, never in the payload). */
	policyResult: PersonalBudgetV2Result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a supplied resolved snapshot BEFORE any DB mutation:
 *  - the six inputs must pass the existing V2 money parser / policy validation
 *    (this also produces the deterministic policy result);
 *  - `evidenceSnapshot` must be a non-null, non-array JSON object;
 *  - `evidenceSnapshot` must be JSON-safe / canonicalizable by the existing
 *    canonical infrastructure -- no BigInt, undefined, Date, functions, NaN,
 *    circular refs, over-deep or over-size trees.
 *
 * All failures surface as `BudgetError("BUDGET_INVALID_INPUT", ...)` so no raw
 * canonical error code leaks out of the budget domain.
 */
export function validateBudgetV2ResolvedSnapshot(
	snapshot: unknown,
): ValidatedBudgetV2Snapshot {
	if (!isPlainObject(snapshot)) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"Resolved snapshot must be a non-null object",
		);
	}
	if (!isPlainObject(snapshot.inputs)) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"Resolved snapshot inputs must be a non-null object",
		);
	}
	const rawInputs = snapshot.inputs as Record<string, unknown>;
	const inputKeys = Object.keys(rawInputs);
	if (
		inputKeys.length !== BUDGET_V2_PAYLOAD_INPUT_KEYS.length ||
		!BUDGET_V2_PAYLOAD_INPUT_KEYS.every((k) => Object.hasOwn(rawInputs, k))
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`Resolved snapshot inputs must have exactly the keys: ${BUDGET_V2_PAYLOAD_INPUT_KEYS.join(", ")}`,
		);
	}

	// Runs the pure V2 policy validation + parsing (throws BUDGET_INVALID_INPUT
	// on malformed / negative / bad-scale / NaN-like money).
	const policyResult = allocatePersonalBudgetV2(
		rawInputs as unknown as PersonalBudgetV2Inputs,
	);

	if (!isPlainObject(snapshot.evidenceSnapshot)) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"Resolved snapshot evidenceSnapshot must be a non-null JSON object (not an array)",
		);
	}
	const evidenceSnapshot = snapshot.evidenceSnapshot as Record<string, unknown>;
	try {
		canonicalizePayload(evidenceSnapshot);
	} catch (err) {
		if (err instanceof CanonicalTransactionError) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`evidenceSnapshot is not JSON-safe / canonicalizable: ${err.message}`,
			);
		}
		throw err;
	}

	return {
		inputs: {
			realizedIncome: policyResult.inputs.realizedIncome.amount,
			currentObligations: policyResult.inputs.currentObligations.amount,
			basicLivingFunding: policyResult.inputs.basicLivingFunding.amount,
			dateBoundNecessaryPurchaseFunding:
				policyResult.inputs.dateBoundNecessaryPurchaseFunding.amount,
			coreEmergencyFundBalance:
				policyResult.inputs.coreEmergencyFundBalance.amount,
			mobilityBalance: policyResult.inputs.mobilityBalance.amount,
		},
		evidenceSnapshot,
		policyResult,
	};
}

export interface BuildBudgetV2CanonicalPayloadArgs {
	periodMonth: string;
	currency: string;
	policyResult: PersonalBudgetV2Result;
	evidenceSnapshot: Record<string, unknown>;
}

/**
 * Deterministic PERSONAL_BUDGET_V2 canonical payload producer. Emits EXACTLY
 * the six top-level keys, six input keys, and six output keys the 0061 DB
 * guard enforces. Every monetary value is a canonical money STRING taken from
 * `PersonalBudgetV2Result.*.amount`; the `.cents` BigInt values are never
 * serialized. No recommendation / behavior / family text is injected.
 */
export function buildBudgetV2CanonicalPayload(
	args: BuildBudgetV2CanonicalPayloadArgs,
): Record<string, unknown> {
	const { periodMonth, currency, policyResult, evidenceSnapshot } = args;
	const i = policyResult.inputs;
	const o = policyResult.outputs;

	return {
		periodMonth,
		policyVersion: PERSONAL_BUDGET_V2,
		currency,
		inputs: {
			realizedIncome: i.realizedIncome.amount,
			currentObligations: i.currentObligations.amount,
			basicLivingFunding: i.basicLivingFunding.amount,
			dateBoundNecessaryPurchaseFunding:
				i.dateBoundNecessaryPurchaseFunding.amount,
			coreEmergencyFundBalance: i.coreEmergencyFundBalance.amount,
			mobilityBalance: i.mobilityBalance.amount,
		},
		outputs: {
			emergencyCatchUp: o.emergencyCatchUp.amount,
			deficit: o.deficit.amount,
			trueSurplus: o.trueSurplus.amount,
			mobilityAllocation: o.mobilityAllocation.amount,
			longTermInvestment: o.longTermInvestment.amount,
			discretionaryAllocation: o.discretionaryAllocation.amount,
		},
		evidenceSnapshot,
	};
}

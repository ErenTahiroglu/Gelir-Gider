/**
 * Dashboard API Client Functions & Runtime Contract Guards
 *
 * Calls authoritative same-origin endpoints using apiGet.
 */

import { apiGet } from "./client";
import type {
	AvailableToAllocateNowSection,
	BudgetV2CheckpointTimeline,
	BudgetV2DecisionCenterView,
	CreditCardStatementsListResponse,
	CreditCardsListResponse,
	QuickEntryTemplatesResponse,
	SpendingSummaryResponse,
} from "./dashboard-types";

export async function fetchBudgetCheckpoints(
	limit = 50,
): Promise<BudgetV2CheckpointTimeline> {
	return apiGet<BudgetV2CheckpointTimeline>(
		`/budget-v2/checkpoints?limit=${limit}`,
	);
}

export async function fetchBudgetDecisionCenter(
	paymentEventId: string,
): Promise<BudgetV2DecisionCenterView> {
	return apiGet<BudgetV2DecisionCenterView>(
		`/budget-v2/checkpoints/${encodeURIComponent(paymentEventId)}/decision-center`,
	);
}

export async function fetchSpendingSummary(
	periodMonth: string,
): Promise<SpendingSummaryResponse> {
	return apiGet<SpendingSummaryResponse>(
		`/spending/summary?periodMonth=${encodeURIComponent(periodMonth)}`,
	);
}

export async function fetchActiveCreditCards(
	limit = 100,
): Promise<CreditCardsListResponse> {
	return apiGet<CreditCardsListResponse>(
		`/credit-cards?status=ACTIVE&limit=${limit}`,
	);
}

export async function fetchOpenCreditCardStatements(
	cardId: string,
	limit = 100,
): Promise<CreditCardStatementsListResponse> {
	return apiGet<CreditCardStatementsListResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/statements?status=OPEN&limit=${limit}`,
	);
}

export async function fetchQuickEntryTemplates(): Promise<QuickEntryTemplatesResponse> {
	return apiGet<QuickEntryTemplatesResponse>("/quick-entry/templates");
}

/**
 * Runtime guard and extractor for `decisionCenter.checkpoint.report.availableToAllocateNow`.
 *
 * Verifies Section 18 consistency invariants:
 *   - target.paymentEventId === selected paymentEventId
 *   - target.periodMonth === currentPeriodMonth
 *   - checkpoint.temporalScope === "FROZEN_AT_CHECKPOINT"
 *
 * Extracts the top-level `availableToAllocateNow` from `checkpoint.report`
 * and validates that it matches either the available or unavailable contract shape.
 */
export function extractAvailableToAllocateNow(
	decisionCenter: BudgetV2DecisionCenterView,
	selectedPaymentEventId: string,
	currentPeriodMonth: string,
): AvailableToAllocateNowSection {
	if (
		decisionCenter.target.paymentEventId !== selectedPaymentEventId ||
		decisionCenter.target.periodMonth !== currentPeriodMonth ||
		decisionCenter.checkpoint.temporalScope !== "FROZEN_AT_CHECKPOINT"
	) {
		throw new Error(
			"Decision Center target consistency verification failed: target does not match selected checkpoint or temporal scope is not frozen",
		);
	}

	const report = decisionCenter.checkpoint.report;
	if (!report || typeof report !== "object" || Array.isArray(report)) {
		throw new Error(
			"Invalid checkpoint report payload: report is missing or not a JSON object",
		);
	}

	const reportObj = report as Record<string, unknown>;
	const atn = reportObj.availableToAllocateNow;
	if (!atn || typeof atn !== "object" || Array.isArray(atn)) {
		throw new Error(
			"Missing or invalid availableToAllocateNow in checkpoint report (expected top-level report.availableToAllocateNow)",
		);
	}

	const atnObj = atn as Record<string, unknown>;

	if (atnObj.available === true) {
		if (typeof atnObj.amount !== "string") {
			throw new Error(
				"availableToAllocateNow.available is true but amount is not a string",
			);
		}
		return atn as AvailableToAllocateNowSection;
	}

	if (atnObj.available === false) {
		if (
			atnObj.reason !== "SURPLUS_USE_ATTRIBUTION_INCOMPLETE" &&
			atnObj.reason !== "SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED"
		) {
			throw new Error(
				`Unexpected availableToAllocateNow unavailable reason: ${String(atnObj.reason)}`,
			);
		}
		return atn as AvailableToAllocateNowSection;
	}

	throw new Error(
		"availableToAllocateNow has invalid or missing available boolean property",
	);
}

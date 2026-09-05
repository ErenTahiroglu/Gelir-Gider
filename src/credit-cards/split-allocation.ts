import { CreditCardError } from "./errors";
import { compareAscii } from "./fingerprint";

export type SplitCalculationMethod = "EQUAL" | "MANUAL" | "RATIO";

export interface ManualParticipantInput {
	personId: string;
	shareAmount: bigint;
	dueDate?: Date | null;
	description?: string | null;
}

export interface EqualParticipantInput {
	personId: string;
	dueDate?: Date | null;
	description?: string | null;
}

export interface RatioParticipantInput {
	personId: string;
	weight: number;
	dueDate?: Date | null;
	description?: string | null;
}

export interface CalculatedParticipantShare {
	personId: string;
	shareAmount: bigint;
	weight?: number | null;
	dueDate?: Date | null;
	description?: string | null;
}

export interface SplitCalculationResult {
	method: SplitCalculationMethod;
	grossAmount: bigint;
	userShareAmount: bigint;
	externalShareAmount: bigint;
	userWeight?: number | null;
	participants: CalculatedParticipantShare[];
}

export function calculateEqualSplit(params: {
	grossAmount: bigint;
	participants: EqualParticipantInput[];
}): SplitCalculationResult {
	const { grossAmount, participants } = params;

	if (grossAmount <= 0n) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Gross amount must be positive for split calculation",
		);
	}

	if (participants.length < 1 || participants.length > 9) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Equal split requires between 1 and 9 external participants (got ${participants.length})`,
		);
	}

	const seenPeople = new Set<string>();
	for (const p of participants) {
		const pid = p.personId.trim().toLowerCase();
		if (seenPeople.has(pid)) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Duplicate personId in split: ${p.personId}`,
			);
		}
		seenPeople.add(pid);
	}

	// Total parties: 1 (User) + N (external participants)
	const totalParties = BigInt(1 + participants.length);
	const baseShare = grossAmount / totalParties;
	const remainder = Number(grossAmount % totalParties);

	// Tie-break order for remainder distribution:
	// 1. User first
	// 2. Participants in personId lexical ASC order
	// Sort participants by personId ASC for deterministic output
	const sortedParticipants = [...participants].sort((a, b) =>
		compareAscii(a.personId, b.personId),
	);

	let userShare = baseShare;
	let remainingCents = remainder;

	if (remainingCents > 0) {
		userShare += 1n;
		remainingCents -= 1;
	}

	const resultParticipants: CalculatedParticipantShare[] = [];
	let externalShareSum = 0n;

	for (const p of sortedParticipants) {
		let share = baseShare;
		if (remainingCents > 0) {
			share += 1n;
			remainingCents -= 1;
		}
		if (share <= 0n) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Calculated participant share must be > 0 cents (got ${share})`,
			);
		}
		resultParticipants.push({
			personId: p.personId,
			shareAmount: share,
			weight: 1,
			dueDate: p.dueDate ?? null,
			description: p.description?.trim() || null,
		});
		externalShareSum += share;
	}

	if (userShare + externalShareSum !== grossAmount) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Equal split sum invariant violated",
		);
	}

	return {
		method: "EQUAL",
		grossAmount,
		userShareAmount: userShare,
		externalShareAmount: externalShareSum,
		userWeight: 1,
		participants: resultParticipants,
	};
}

export function calculateManualSplit(params: {
	grossAmount: bigint;
	participants: ManualParticipantInput[];
}): SplitCalculationResult {
	const { grossAmount, participants } = params;

	if (grossAmount <= 0n) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Gross amount must be positive for split calculation",
		);
	}

	if (participants.length < 1 || participants.length > 9) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Manual split requires between 1 and 9 external participants (got ${participants.length})`,
		);
	}

	const seenPeople = new Set<string>();
	let externalShareSum = 0n;
	const resultParticipants: CalculatedParticipantShare[] = [];

	// Sort participants by personId ASC for deterministic output
	const sortedParticipants = [...participants].sort((a, b) =>
		compareAscii(a.personId, b.personId),
	);

	for (const p of sortedParticipants) {
		const pid = p.personId.trim().toLowerCase();
		if (seenPeople.has(pid)) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Duplicate personId in split: ${p.personId}`,
			);
		}
		seenPeople.add(pid);

		if (p.shareAmount <= 0n) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Each participant share must be > 0 cents (got ${p.shareAmount} for person ${p.personId})`,
			);
		}

		externalShareSum += p.shareAmount;
		resultParticipants.push({
			personId: p.personId,
			shareAmount: p.shareAmount,
			weight: null,
			dueDate: p.dueDate ?? null,
			description: p.description?.trim() || null,
		});
	}

	if (externalShareSum > grossAmount) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Sum of participant shares (${externalShareSum}) cannot exceed gross amount (${grossAmount})`,
		);
	}

	const userShare = grossAmount - externalShareSum;

	return {
		method: "MANUAL",
		grossAmount,
		userShareAmount: userShare,
		externalShareAmount: externalShareSum,
		userWeight: null,
		participants: resultParticipants,
	};
}

export function calculateRatioSplit(params: {
	grossAmount: bigint;
	userWeight: number;
	participants: RatioParticipantInput[];
}): SplitCalculationResult {
	const { grossAmount, userWeight, participants } = params;

	if (grossAmount <= 0n) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Gross amount must be positive for split calculation",
		);
	}

	if (participants.length < 1 || participants.length > 9) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Ratio split requires between 1 and 9 external participants (got ${participants.length})`,
		);
	}

	if (!Number.isSafeInteger(userWeight) || userWeight < 0) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`User weight must be a safe non-negative integer (got ${userWeight})`,
		);
	}

	const seenPeople = new Set<string>();
	let totalWeight = BigInt(userWeight);

	for (const p of participants) {
		const pid = p.personId.trim().toLowerCase();
		if (seenPeople.has(pid)) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Duplicate personId in split: ${p.personId}`,
			);
		}
		seenPeople.add(pid);

		if (!Number.isSafeInteger(p.weight) || p.weight <= 0) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Participant weight must be a safe positive integer (got ${p.weight} for person ${p.personId})`,
			);
		}
		totalWeight += BigInt(p.weight);
	}

	if (totalWeight <= 0n) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Total weight must be positive",
		);
	}

	// Largest-remainder allocation
	// Parties: USER (index -1), and sorted participants (index 0..N-1)
	const sortedParticipants = [...participants].sort((a, b) =>
		compareAscii(a.personId, b.personId),
	);

	interface PartyAllocation {
		isUser: boolean;
		personId: string | null;
		participantIndex: number;
		weight: number;
		baseShare: bigint;
		remainder: bigint; // (grossAmount * weight) % totalWeight
	}

	const parties: PartyAllocation[] = [];

	// User
	const userNum = grossAmount * BigInt(userWeight);
	parties.push({
		isUser: true,
		personId: null,
		participantIndex: -1,
		weight: userWeight,
		baseShare: userNum / totalWeight,
		remainder: userNum % totalWeight,
	});

	// External participants
	for (let i = 0; i < sortedParticipants.length; i++) {
		const p = sortedParticipants[i];
		if (!p) continue;
		const num = grossAmount * BigInt(p.weight);
		parties.push({
			isUser: false,
			personId: p.personId,
			participantIndex: i,
			weight: p.weight,
			baseShare: num / totalWeight,
			remainder: num % totalWeight,
		});
	}

	const sumBase = parties.reduce((acc, p) => acc + p.baseShare, 0n);
	const residualCents = Number(grossAmount - sumBase);

	// Sort parties for residual cent distribution:
	// 1. Remainder DESC
	// 2. Tie-break: USER first, then personId lexical ASC
	const partiesForResidual = [...parties].sort((a, b) => {
		if (b.remainder !== a.remainder) {
			return b.remainder > a.remainder ? 1 : -1;
		}
		if (a.isUser) return -1;
		if (b.isUser) return 1;
		return compareAscii(a.personId ?? "", b.personId ?? "");
	});

	const extraCentsMap = new Map<string, bigint>();
	let userExtraCent = 0n;

	for (let i = 0; i < residualCents; i++) {
		const party = partiesForResidual[i];
		if (!party) continue;
		if (party.isUser) {
			userExtraCent = 1n;
		} else if (party.personId) {
			extraCentsMap.set(party.personId, 1n);
		}
	}

	const userParty = parties[0];
	if (!userParty) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			"User party not found in ratio allocation",
		);
	}
	const userShare = userParty.baseShare + userExtraCent;
	const resultParticipants: CalculatedParticipantShare[] = [];
	let externalShareSum = 0n;

	for (let i = 0; i < sortedParticipants.length; i++) {
		const p = sortedParticipants[i];
		if (!p) continue;
		const partyItem = parties[i + 1];
		if (!partyItem) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`Participant party missing at index ${i + 1}`,
			);
		}
		const base = partyItem.baseShare;
		const extra = extraCentsMap.get(p.personId) ?? 0n;
		const share = base + extra;

		if (share <= 0n) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Calculated participant share must be > 0 cents (got ${share} for person ${p.personId})`,
			);
		}

		resultParticipants.push({
			personId: p.personId,
			shareAmount: share,
			weight: p.weight,
			dueDate: p.dueDate ?? null,
			description: p.description?.trim() || null,
		});
		externalShareSum += share;
	}

	if (userShare + externalShareSum !== grossAmount) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Ratio split sum invariant violated",
		);
	}

	return {
		method: "RATIO",
		grossAmount,
		userShareAmount: userShare,
		externalShareAmount: externalShareSum,
		userWeight,
		participants: resultParticipants,
	};
}

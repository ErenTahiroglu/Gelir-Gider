/**
 * Exact BigInt Cents Split Preview Math
 *
 * Replicates the deterministic algorithms in `src/credit-cards/split-allocation.ts`
 * without floating point arithmetic (Section 63).
 */

import { formatCentsToCanonical, parseMoneyToCents } from "./money";

export interface PreviewParticipant {
	personId: string;
	displayName?: string | undefined;
	shareAmount: string; // money string
	weight?: number | null | undefined;
}

export interface SplitPreviewResult {
	userShareAmount: string;
	externalShareAmount: string;
	participants: PreviewParticipant[];
	isValid: boolean;
	errorMessage?: string;
}

function compareAscii(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * Calculates EQUAL split preview.
 * Remainder is given to user first, then participants ordered by personId ASC.
 */
export function calculateEqualSplitPreview(
	grossAmountStr: string,
	participants: Array<{ personId: string; displayName?: string | undefined }>,
): SplitPreviewResult {
	let grossCents: bigint;
	try {
		grossCents = parseMoneyToCents(grossAmountStr);
	} catch {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Geçerli bir harcama tutarı giriniz.",
		};
	}

	if (grossCents <= 0n) {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Harcama tutarı sıfırdan büyük olmalıdır.",
		};
	}

	if (participants.length < 1 || participants.length > 9) {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Ortak harcama için 1 ile 9 kişi seçilmelidir.",
		};
	}

	// Check duplicates
	const seen = new Set<string>();
	for (const p of participants) {
		const pid = p.personId.trim().toLowerCase();
		if (seen.has(pid)) {
			return {
				userShareAmount: "0.00",
				externalShareAmount: "0.00",
				participants: [],
				isValid: false,
				errorMessage: "Aynı kişi birden fazla eklenemez.",
			};
		}
		seen.add(pid);
	}

	const totalParties = BigInt(1 + participants.length);
	const baseShare = grossCents / totalParties;
	let remainingCents = Number(grossCents % totalParties);

	const sortedParticipants = [...participants].sort((a, b) =>
		compareAscii(a.personId, b.personId),
	);

	let userShare = baseShare;
	if (remainingCents > 0) {
		userShare += 1n;
		remainingCents -= 1;
	}

	let externalSum = 0n;
	const resultParticipants: PreviewParticipant[] = [];

	for (const p of sortedParticipants) {
		let share = baseShare;
		if (remainingCents > 0) {
			share += 1n;
			remainingCents -= 1;
		}
		if (share <= 0n) {
			return {
				userShareAmount: "0.00",
				externalShareAmount: "0.00",
				participants: [],
				isValid: false,
				errorMessage: "Kişi başına düşen pay en az 1 kuruş olmalıdır.",
			};
		}
		externalSum += share;
		resultParticipants.push({
			personId: p.personId,
			displayName: p.displayName,
			shareAmount: formatCentsToCanonical(share),
			weight: 1,
		});
	}

	return {
		userShareAmount: formatCentsToCanonical(userShare),
		externalShareAmount: formatCentsToCanonical(externalSum),
		participants: resultParticipants,
		isValid: true,
	};
}

/**
 * Calculates MANUAL split preview.
 * Validates sum(externalShares) <= grossAmount and each share > 0.
 */
export function calculateManualSplitPreview(
	grossAmountStr: string,
	participants: Array<{
		personId: string;
		displayName?: string | undefined;
		shareAmountStr: string;
	}>,
): SplitPreviewResult {
	let grossCents: bigint;
	try {
		grossCents = parseMoneyToCents(grossAmountStr);
	} catch {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Geçerli bir harcama tutarı giriniz.",
		};
	}

	if (grossCents <= 0n) {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Harcama tutarı sıfırdan büyük olmalıdır.",
		};
	}

	if (participants.length < 1 || participants.length > 9) {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Ortak harcama için 1 ile 9 kişi seçilmelidir.",
		};
	}

	let externalSum = 0n;
	const resultParticipants: PreviewParticipant[] = [];
	const seen = new Set<string>();

	for (const p of participants) {
		const pid = p.personId.trim().toLowerCase();
		if (seen.has(pid)) {
			return {
				userShareAmount: "0.00",
				externalShareAmount: "0.00",
				participants: [],
				isValid: false,
				errorMessage: "Aynı kişi birden fazla eklenemez.",
			};
		}
		seen.add(pid);

		let shareCents: bigint;
		try {
			shareCents = parseMoneyToCents(p.shareAmountStr || "0.00");
		} catch {
			return {
				userShareAmount: "0.00",
				externalShareAmount: "0.00",
				participants: [],
				isValid: false,
				errorMessage: "Geçerli kişi payı giriniz.",
			};
		}

		if (shareCents <= 0n) {
			return {
				userShareAmount: "0.00",
				externalShareAmount: "0.00",
				participants: [],
				isValid: false,
				errorMessage: "Her kişi payı sıfırdan büyük olmalıdır.",
			};
		}

		externalSum += shareCents;
		resultParticipants.push({
			personId: p.personId,
			displayName: p.displayName,
			shareAmount: formatCentsToCanonical(shareCents),
			weight: null,
		});
	}

	if (externalSum > grossCents) {
		return {
			userShareAmount: "0.00",
			externalShareAmount: formatCentsToCanonical(externalSum),
			participants: resultParticipants,
			isValid: false,
			errorMessage: `Kişi payları toplamı (${formatCentsToCanonical(externalSum)}) toplam harcamayı (${formatCentsToCanonical(grossCents)}) aşamaz.`,
		};
	}

	const userShare = grossCents - externalSum;

	return {
		userShareAmount: formatCentsToCanonical(userShare),
		externalShareAmount: formatCentsToCanonical(externalSum),
		participants: resultParticipants,
		isValid: true,
	};
}

/**
 * Calculates RATIO split preview using largest-remainder method.
 */
export function calculateRatioSplitPreview(
	grossAmountStr: string,
	userWeight: number,
	participants: Array<{
		personId: string;
		displayName?: string | undefined;
		weight: number;
	}>,
): SplitPreviewResult {
	let grossCents: bigint;
	try {
		grossCents = parseMoneyToCents(grossAmountStr);
	} catch {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Geçerli bir harcama tutarı giriniz.",
		};
	}

	if (grossCents <= 0n) {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Harcama tutarı sıfırdan büyük olmalıdır.",
		};
	}

	if (participants.length < 1 || participants.length > 9) {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Ortak harcama için 1 ile 9 kişi seçilmelidir.",
		};
	}

	if (!Number.isSafeInteger(userWeight) || userWeight < 0) {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Senin ağırlığın negatif olamaz.",
		};
	}

	let totalWeight = BigInt(userWeight);
	const seen = new Set<string>();

	for (const p of participants) {
		const pid = p.personId.trim().toLowerCase();
		if (seen.has(pid)) {
			return {
				userShareAmount: "0.00",
				externalShareAmount: "0.00",
				participants: [],
				isValid: false,
				errorMessage: "Aynı kişi birden fazla eklenemez.",
			};
		}
		seen.add(pid);

		if (!Number.isSafeInteger(p.weight) || p.weight <= 0) {
			return {
				userShareAmount: "0.00",
				externalShareAmount: "0.00",
				participants: [],
				isValid: false,
				errorMessage: "Kişi ağırlığı sıfırdan büyük olmalıdır.",
			};
		}
		totalWeight += BigInt(p.weight);
	}

	if (totalWeight <= 0n) {
		return {
			userShareAmount: "0.00",
			externalShareAmount: "0.00",
			participants: [],
			isValid: false,
			errorMessage: "Toplam ağırlık sıfırdan büyük olmalıdır.",
		};
	}

	const sortedParticipants = [...participants].sort((a, b) =>
		compareAscii(a.personId, b.personId),
	);

	interface PartyAllocation {
		isUser: boolean;
		personId: string | null;
		displayName?: string | undefined;
		weight: number;
		baseShare: bigint;
		remainder: bigint;
	}

	const parties: PartyAllocation[] = [];

	const userNum = grossCents * BigInt(userWeight);
	parties.push({
		isUser: true,
		personId: null,
		weight: userWeight,
		baseShare: userNum / totalWeight,
		remainder: userNum % totalWeight,
	});

	for (const p of sortedParticipants) {
		const pNum = grossCents * BigInt(p.weight);
		parties.push({
			isUser: false,
			personId: p.personId,
			displayName: p.displayName,
			weight: p.weight,
			baseShare: pNum / totalWeight,
			remainder: pNum % totalWeight,
		});
	}

	let distributed = 0n;
	for (const party of parties) {
		distributed += party.baseShare;
	}

	const remainingCents = Number(grossCents - distributed);

	// Sort candidate parties by remainder DESC, tie-break: User first, then personId ASC
	const sortedIndices = parties
		.map((_, i) => i)
		.sort((a, b) => {
			const pa = parties[a]!;
			const pb = parties[b]!;
			if (pa.remainder !== pb.remainder) {
				return pa.remainder > pb.remainder ? -1 : 1;
			}
			if (pa.isUser) return -1;
			if (pb.isUser) return 1;
			return compareAscii(pa.personId!, pb.personId!);
		});

	const finalShares = new Map<number, bigint>();
	for (let i = 0; i < parties.length; i++) {
		finalShares.set(i, parties[i]?.baseShare ?? 0n);
	}

	for (let i = 0; i < remainingCents; i++) {
		const idx = sortedIndices[i % sortedIndices.length]!;
		finalShares.set(idx, finalShares.get(idx)! + 1n);
	}

	const userFinalShare = finalShares.get(0)!;
	let externalSum = 0n;
	const resultParticipants: PreviewParticipant[] = [];

	for (let i = 1; i < parties.length; i++) {
		const party = parties[i]!;
		const share = finalShares.get(i)!;
		externalSum += share;
		resultParticipants.push({
			personId: party.personId!,
			displayName: party.displayName,
			shareAmount: formatCentsToCanonical(share),
			weight: party.weight,
		});
	}

	return {
		userShareAmount: formatCentsToCanonical(userFinalShare),
		externalShareAmount: formatCentsToCanonical(externalSum),
		participants: resultParticipants,
		isValid: true,
	};
}

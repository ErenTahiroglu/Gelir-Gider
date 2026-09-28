import { useQuery } from "@tanstack/react-query";
import {
	AlertCircle,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	ShieldAlert,
} from "lucide-react";
import { useState } from "react";
import {
	extractAvailableToAllocateNow,
	fetchBudgetCheckpoints,
	fetchBudgetDecisionCenter,
} from "../../api/dashboard-api";
import type {
	AvailableToAllocateNowSection,
	BudgetV2CheckpointTimeline,
	BudgetV2DecisionCenterView,
} from "../../api/dashboard-types";
import { getIstanbulPeriodMonth } from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";

interface HeroAvailableSpendProps {
	isUnlocked: boolean;
}

export function HeroAvailableSpend({ isUnlocked }: HeroAvailableSpendProps) {
	const currentPeriodMonth = getIstanbulPeriodMonth();
	const [disclosureOpen, setDisclosureOpen] = useState(false);

	// 1. Fetch checkpoint timeline
	const timelineQuery = useQuery<BudgetV2CheckpointTimeline>({
		queryKey: ["budget-checkpoints"],
		queryFn: () => fetchBudgetCheckpoints(50),
		enabled: isUnlocked,
	});

	const timeline = timelineQuery.data;

	// Resolve target checkpoint
	let targetPaymentEventId: string | null = null;
	let checkpointUnavailableReason: string | null = null;

	if (timeline) {
		if (timeline.checkpoints.length === 0) {
			checkpointUnavailableReason =
				"Bu ay için doğrulanmış bütçe durumu henüz oluşmadı.";
		} else if (timeline.sharedMaxCheckpointAt) {
			// Section 17 Case B: sharedMaxCheckpointAt === true
			checkpointUnavailableReason =
				"En güncel bütçe durumu kesinleştirilemiyor.";
		} else {
			const newest = timeline.checkpoints[0];
			if (!newest) {
				checkpointUnavailableReason =
					"Bu ay için doğrulanmış bütçe durumu henüz oluşmadı.";
			} else if (newest.periodMonth !== currentPeriodMonth) {
				// Section 17 Case C: newest checkpoint is from old month
				checkpointUnavailableReason =
					"Bu ay için doğrulanmış bütçe kontrol noktası henüz yok.";
			} else {
				// Section 17 Case D: valid newest checkpoint for current month
				targetPaymentEventId = newest.paymentEventId;
			}
		}
	}

	// 2. Fetch Decision Center view if target checkpoint is unambiguous and current
	const decisionCenterQuery = useQuery<BudgetV2DecisionCenterView>({
		queryKey: ["budget-decision-center", targetPaymentEventId],
		queryFn: () => fetchBudgetDecisionCenter(targetPaymentEventId as string),
		enabled: isUnlocked && Boolean(targetPaymentEventId),
	});

	const decisionCenter = decisionCenterQuery.data;

	// 3. Extract and verify availableToAllocateNow
	let atn: AvailableToAllocateNowSection | null = null;
	let extractionError: string | null = null;

	if (decisionCenter && targetPaymentEventId) {
		try {
			atn = extractAvailableToAllocateNow(
				decisionCenter,
				targetPaymentEventId,
				currentPeriodMonth,
			);
		} catch (_err) {
			extractionError = "Bütçe doğrulama tutarlılığı sağlanamadı.";
		}
	}

	// Loading state
	const isLoading =
		timelineQuery.isLoading ||
		(Boolean(targetPaymentEventId) && decisionCenterQuery.isLoading);

	if (isLoading) {
		return (
			<section
				className="dashboard-hero hero-card loading"
				data-testid="hero-available-spend"
				aria-busy="true"
			>
				<div className="hero-header">
					<span className="hero-eyebrow">BU AY KULLANILABİLİR TUTAR</span>
				</div>
				<div className="hero-amount skeleton-amount" data-testid="hero-loading">
					<span className="amount-placeholder">—</span>
				</div>
				<div className="hero-footer">
					<span className="hero-tag skeleton-tag">
						Bütçe verisi doğrulanıyor...
					</span>
				</div>
			</section>
		);
	}

	// Network or API Error
	if (timelineQuery.isError || decisionCenterQuery.isError || extractionError) {
		return (
			<section
				className="dashboard-hero hero-card error"
				data-testid="hero-available-spend"
			>
				<div className="hero-header">
					<span className="hero-eyebrow">BU AY KULLANILABİLİR TUTAR</span>
				</div>
				<div className="hero-unconfirmed" data-testid="hero-error">
					<ShieldAlert
						size={28}
						className="unconfirmed-icon"
						aria-hidden="true"
					/>
					<div className="unconfirmed-text">
						<h2 className="unconfirmed-title">Bütçe durumu doğrulanamadı</h2>
						<p className="unconfirmed-desc">
							Doğrulanmış bütçe verileri şu anda sunucudan alınamadı.
						</p>
					</div>
				</div>
			</section>
		);
	}

	// Checkpoint unavailable (no checkpoint, ambiguous sharedMax, or old month)
	if (checkpointUnavailableReason) {
		return (
			<section
				className="dashboard-hero hero-card unavailable"
				data-testid="hero-available-spend"
			>
				<div className="hero-header">
					<span className="hero-eyebrow">BU AY KULLANILABİLİR TUTAR</span>
				</div>
				<div
					className="hero-unconfirmed"
					data-testid="hero-checkpoint-unavailable"
				>
					<AlertCircle
						size={28}
						className="unconfirmed-icon"
						aria-hidden="true"
					/>
					<div className="unconfirmed-text">
						<h2 className="unconfirmed-title">
							Kullanılabilir tutar henüz kesinleşmedi
						</h2>
						<p className="unconfirmed-desc">{checkpointUnavailableReason}</p>
					</div>
				</div>
			</section>
		);
	}

	// Decision center loaded and verified
	if (!atn) {
		return null;
	}

	// Section 20: available === true
	if (atn.available === true) {
		const formattedAmount = formatMoneyToTry(atn.amount);

		return (
			<section
				className="dashboard-hero hero-card available"
				data-testid="hero-available-spend"
			>
				<div className="hero-header">
					<span className="hero-eyebrow">BU AY KULLANILABİLİR TUTAR</span>
					<div className="hero-status-tag" data-testid="hero-status-verified">
						<CheckCircle2 size={15} aria-hidden="true" />
						<span>Doğrulandı</span>
					</div>
				</div>

				<div className="hero-body">
					<span className="hero-amount tabular-nums" data-testid="hero-amount">
						{formattedAmount}
					</span>
				</div>

				<div className="hero-footer">
					<span className="hero-note">
						Bu ay bütçe planlamanıza göre harcanabilir net güvenli tutar.
					</span>
				</div>
			</section>
		);
	}

	// Section 21: available === false (Fail-Closed State)
	// STRICT INVARIANTS: NEVER render 0 TL, 0,00 ₺, trueSurplus, or raw reasons.
	const pendingCount =
		atn.unattributedSubjectIds.length > 0
			? atn.unattributedSubjectIds.length
			: atn.candidateCount - atn.attributedCount > 0
				? atn.candidateCount - atn.attributedCount
				: 0;

	return (
		<section
			className="dashboard-hero hero-card unconfirmed"
			data-testid="hero-available-spend"
		>
			<div className="hero-header">
				<span className="hero-eyebrow">BU AY KULLANILABİLİR TUTAR</span>
			</div>

			<div className="hero-unconfirmed" data-testid="hero-unconfirmed-headline">
				<AlertCircle
					size={28}
					className="unconfirmed-icon"
					aria-hidden="true"
				/>
				<div className="unconfirmed-text">
					<h2 className="unconfirmed-title">
						Kullanılabilir tutar henüz kesinleşmedi
					</h2>
					<p className="unconfirmed-desc">
						Bazı harcamaların veya bütçe kullanımlarının sınıflandırılması henüz
						kesinleşmedi.
					</p>
				</div>
			</div>

			<div className="hero-disclosure-area">
				<button
					type="button"
					className="disclosure-toggle-btn"
					onClick={() => setDisclosureOpen((prev) => !prev)}
					aria-expanded={disclosureOpen}
					aria-controls="hero-why-unconfirmed"
					data-testid="hero-disclosure-toggle"
				>
					<span>Neden kesinleşmedi?</span>
					{disclosureOpen ? (
						<ChevronUp size={16} aria-hidden="true" />
					) : (
						<ChevronDown size={16} aria-hidden="true" />
					)}
				</button>

				{disclosureOpen && (
					<div
						id="hero-why-unconfirmed"
						className="disclosure-content"
						data-testid="hero-disclosure-content"
					>
						<p>
							Dönem içindeki bütçe kullanım tahsisleri tamamlanmadan net
							kullanılabilir tutar tahmin edilemez. Fazlalık bütçe kullanım
							sınıflandırması ve harcama onayları tamamlandığında net tutar
							otomatik olarak doğrulanacaktır.
						</p>
						{pendingCount > 0 && (
							<div className="pending-badge" data-testid="hero-pending-count">
								<span>{pendingCount} işlem sınıflandırma bekliyor</span>
							</div>
						)}
					</div>
				)}
			</div>
		</section>
	);
}

import { useQueries, useQuery } from "@tanstack/react-query";
import { CalendarClock, CreditCard, DollarSign } from "lucide-react";
import {
	fetchActiveCreditCards,
	fetchOpenCreditCardStatements,
	fetchSpendingSummary,
} from "../../api/dashboard-api";
import type {
	CreditCardStatementItem,
	CreditCardStatementsListResponse,
	CreditCardsListResponse,
	SpendingSummaryResponse,
} from "../../api/dashboard-types";
import {
	formatDueDateRelativeTurkish,
	getIstanbulPeriodMonth,
} from "../../lib/istanbul-date";
import { formatMoneyToTry, sumMoneyStrings } from "../../lib/money";

interface SummaryMetricsProps {
	isUnlocked: boolean;
}

export function SummaryMetrics({ isUnlocked }: SummaryMetricsProps) {
	const currentPeriodMonth = getIstanbulPeriodMonth();

	// 1. Spending Summary Query
	const spendingQuery = useQuery<SpendingSummaryResponse>({
		queryKey: ["spending-summary", currentPeriodMonth],
		queryFn: () => fetchSpendingSummary(currentPeriodMonth),
		enabled: isUnlocked,
	});

	// 2. Active Credit Cards Query
	const cardsQuery = useQuery<CreditCardsListResponse>({
		queryKey: ["active-credit-cards"],
		queryFn: () => fetchActiveCreditCards(100),
		enabled: isUnlocked,
	});

	const activeCards = cardsQuery.data?.cards ?? [];
	const cardsHasMore = cardsQuery.data?.hasMore ?? false;

	// 3. Open Statements Queries for each active card
	const statementQueries = useQueries({
		queries: activeCards.map((card) => ({
			queryKey: ["open-card-statements", card.cardId],
			queryFn: () => fetchOpenCreditCardStatements(card.cardId, 100),
			enabled: isUnlocked && activeCards.length > 0,
		})),
	});

	// --- 1. Bu Ay Harcanan Calculation ---
	let spendingDisplay: { amount: string; subtitle: string; isError: boolean } =
		{
			amount: "—",
			subtitle: "Yükleniyor...",
			isError: false,
		};

	if (spendingQuery.isLoading) {
		spendingDisplay = {
			amount: "—",
			subtitle: "Hesaplanıyor...",
			isError: false,
		};
	} else if (spendingQuery.isError || !spendingQuery.data) {
		spendingDisplay = {
			amount: "—",
			subtitle: "Harcama özeti doğrulanamadı",
			isError: true,
		};
	} else {
		try {
			const formatted = formatMoneyToTry(
				spendingQuery.data.totalPersonalSpending,
			);
			spendingDisplay = {
				amount: formatted,
				subtitle: "Doğrulanmış kişisel harcama",
				isError: false,
			};
		} catch {
			spendingDisplay = {
				amount: "—",
				subtitle: "Harcama tutarı geçersiz",
				isError: true,
			};
		}
	}

	// --- 2. Kartlarda Bu Dönem Calculation ---
	let cardLiabilityDisplay: {
		amount: string;
		subtitle: string;
		isError: boolean;
	} = {
		amount: "—",
		subtitle: "Yükleniyor...",
		isError: false,
	};

	if (cardsQuery.isLoading) {
		cardLiabilityDisplay = {
			amount: "—",
			subtitle: "Kartlar taranıyor...",
			isError: false,
		};
	} else if (cardsQuery.isError) {
		cardLiabilityDisplay = {
			amount: "—",
			subtitle: "Kart bilgisi alınamadı",
			isError: true,
		};
	} else if (cardsHasMore) {
		// Section 26: HasMore indicates truncated results -> fail aggregate closed
		cardLiabilityDisplay = {
			amount: "—",
			subtitle: "Kart sayısı limiti aşıldı",
			isError: true,
		};
	} else if (activeCards.length === 0) {
		cardLiabilityDisplay = {
			amount: "₺0,00",
			subtitle: "Aktif kart bulunmuyor",
			isError: false,
		};
	} else {
		try {
			const liabilityBalances = activeCards.map((c) => c.liveLiabilityBalance);
			const totalLiability = sumMoneyStrings(liabilityBalances);
			cardLiabilityDisplay = {
				amount: formatMoneyToTry(totalLiability),
				subtitle: `${activeCards.length} aktif kart toplamı`,
				isError: false,
			};
		} catch {
			cardLiabilityDisplay = {
				amount: "—",
				subtitle: "Bakiye hesaplanamadı",
				isError: true,
			};
		}
	}

	// --- 3. Yaklaşan Ödeme Calculation ---
	let upcomingDisplay: { amount: string; subtitle: string; isError: boolean } =
		{
			amount: "—",
			subtitle: "Yükleniyor...",
			isError: false,
		};

	const anyStatementLoading = statementQueries.some((q) => q.isLoading);
	const anyStatementError = statementQueries.some((q) => q.isError);
	const anyStatementHasMore = statementQueries.some(
		(q) => q.data && (q.data as CreditCardStatementsListResponse).hasMore,
	);

	if (cardsQuery.isLoading || anyStatementLoading) {
		upcomingDisplay = {
			amount: "—",
			subtitle: "Ekstreler kontrol ediliyor...",
			isError: false,
		};
	} else if (cardsQuery.isError || anyStatementError || anyStatementHasMore) {
		upcomingDisplay = {
			amount: "—",
			subtitle: "Ödeme bilgisi alınamadı",
			isError: true,
		};
	} else if (activeCards.length === 0) {
		upcomingDisplay = {
			amount: "—",
			subtitle: "Yaklaşan ödeme yok",
			isError: false,
		};
	} else {
		// Collect all OPEN statements across all cards
		const allOpenStatements: CreditCardStatementItem[] = [];
		for (const q of statementQueries) {
			const data = q.data as CreditCardStatementsListResponse | undefined;
			if (data && Array.isArray(data.statements)) {
				for (const s of data.statements) {
					if (s.status === "OPEN") {
						allOpenStatements.push(s);
					}
				}
			}
		}

		if (allOpenStatements.length === 0) {
			upcomingDisplay = {
				amount: "—",
				subtitle: "Yaklaşan ödeme yok",
				isError: false,
			};
		} else {
			// Sort by dueDate ASC to find earliest outstanding payment
			allOpenStatements.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
			const earliest = allOpenStatements[0];

			if (earliest) {
				try {
					const formattedAmount = formatMoneyToTry(earliest.statementAmount);
					const relativeDate = formatDueDateRelativeTurkish(earliest.dueDate);
					upcomingDisplay = {
						amount: formattedAmount,
						subtitle: `Son gün: ${relativeDate}`,
						isError: false,
					};
				} catch {
					upcomingDisplay = {
						amount: "—",
						subtitle: "Ödeme tutarı geçersiz",
						isError: true,
					};
				}
			}
		}
	}

	return (
		<section
			className="dashboard-summary-metrics"
			aria-label="Özet Göstergeler"
		>
			<div className="metrics-grid">
				{/* 1. Bu Ay Harcanan */}
				<div
					className={`metric-card ${spendingDisplay.isError ? "card-error" : ""}`}
					data-testid="metric-bu-ay-harcanan"
				>
					<div className="metric-header">
						<span className="metric-title">Bu Ay Harcanan</span>
						<DollarSign size={18} className="metric-icon" aria-hidden="true" />
					</div>
					<div className="metric-body">
						<span
							className="metric-value tabular-nums"
							data-testid="value-bu-ay-harcanan"
						>
							{spendingDisplay.amount}
						</span>
					</div>
					<div className="metric-footer">
						<span className="metric-subtitle">{spendingDisplay.subtitle}</span>
					</div>
				</div>

				{/* 2. Kartlarda Bu Dönem */}
				<div
					className={`metric-card ${cardLiabilityDisplay.isError ? "card-error" : ""}`}
					data-testid="metric-kartlarda-bu-donem"
				>
					<div className="metric-header">
						<span className="metric-title">Kartlarda Bu Dönem</span>
						<CreditCard size={18} className="metric-icon" aria-hidden="true" />
					</div>
					<div className="metric-body">
						<span
							className="metric-value tabular-nums"
							data-testid="value-kartlarda-bu-donem"
						>
							{cardLiabilityDisplay.amount}
						</span>
					</div>
					<div className="metric-footer">
						<span className="metric-subtitle">
							{cardLiabilityDisplay.subtitle}
						</span>
					</div>
				</div>

				{/* 3. Yaklaşan Ödeme */}
				<div
					className={`metric-card ${upcomingDisplay.isError ? "card-error" : ""}`}
					data-testid="metric-yaklasan-odeme"
				>
					<div className="metric-header">
						<span className="metric-title">Yaklaşan Ödeme</span>
						<CalendarClock
							size={18}
							className="metric-icon"
							aria-hidden="true"
						/>
					</div>
					<div className="metric-body">
						<span
							className="metric-value tabular-nums"
							data-testid="value-yaklasan-odeme"
						>
							{upcomingDisplay.amount}
						</span>
					</div>
					<div className="metric-footer">
						<span className="metric-subtitle">{upcomingDisplay.subtitle}</span>
					</div>
				</div>
			</div>
		</section>
	);
}

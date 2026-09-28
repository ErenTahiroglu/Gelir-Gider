import { useQuery } from "@tanstack/react-query";
import { CreditCard as CardIcon } from "lucide-react";
import { fetchActiveCreditCards } from "../../api/dashboard-api";
import type { CreditCardsListResponse } from "../../api/dashboard-types";
import { formatMoneyToTry } from "../../lib/money";

interface CreditCardSummaryProps {
	isUnlocked: boolean;
}

export function CreditCardSummary({ isUnlocked }: CreditCardSummaryProps) {
	const cardsQuery = useQuery<CreditCardsListResponse>({
		queryKey: ["active-credit-cards"],
		queryFn: () => fetchActiveCreditCards(100),
		enabled: isUnlocked,
	});

	const cards = cardsQuery.data?.cards ?? [];

	if (cardsQuery.isLoading) {
		return (
			<div
				className="dashboard-card-section"
				data-testid="card-summary-loading"
			>
				<h3 className="section-title">Kart Durumu</h3>
				<p className="section-loading">Kartlar yükleniyor...</p>
			</div>
		);
	}

	if (cardsQuery.isError) {
		return (
			<div className="dashboard-card-section" data-testid="card-summary-error">
				<h3 className="section-title">Kart Durumu</h3>
				<p className="section-error">Kart bilgileri alınamadı.</p>
			</div>
		);
	}

	if (cards.length === 0) {
		return (
			<div className="dashboard-card-section" data-testid="card-summary-empty">
				<h3 className="section-title">Kart Durumu</h3>
				<p className="section-empty">Kayıtlı aktif kredi kartı bulunmuyor.</p>
			</div>
		);
	}

	return (
		<div className="dashboard-card-section" data-testid="credit-card-summary">
			<div className="section-header">
				<h3 className="section-title">Aktif Kartlar</h3>
				<span className="card-count-badge">{cards.length} kart</span>
			</div>

			<ul className="card-list" aria-label="Aktif Kart Listesi">
				{cards.map((card) => {
					let balanceDisplay = "—";
					try {
						balanceDisplay = formatMoneyToTry(card.liveLiabilityBalance);
					} catch {
						balanceDisplay = "—";
					}

					return (
						<li
							key={card.cardId}
							className="card-item"
							data-testid={`card-row-${card.cardId}`}
						>
							<div className="card-item-left">
								<div className="card-icon-wrapper" aria-hidden="true">
									<CardIcon size={18} />
								</div>
								<div className="card-item-info">
									<span className="card-item-name">{card.displayName}</span>
									<span className="card-item-meta">
										{card.issuer} {card.lastFour ? `•••• ${card.lastFour}` : ""}
									</span>
								</div>
							</div>

							<div className="card-item-right">
								<span className="card-item-balance tabular-nums">
									{balanceDisplay}
								</span>
								<span className="card-item-label">Güncel Borç</span>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

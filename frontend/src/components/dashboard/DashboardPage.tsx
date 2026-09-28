import { useAuth } from "../../auth/auth-context";
import { CreditCardSummary } from "./CreditCardSummary";
import { HeroAvailableSpend } from "./HeroAvailableSpend";
import { QuickTemplatesStrip } from "./QuickTemplatesStrip";
import { SummaryMetrics } from "./SummaryMetrics";

export function DashboardPage() {
	const { state } = useAuth();
	const isUnlocked = state.status === "UNLOCKED";

	return (
		<div className="dashboard-page" data-testid="dashboard-page">
			{/* 1. Budget V2 Authoritative Hero */}
			<HeroAvailableSpend isUnlocked={isUnlocked} />

			{/* 2. Secondary Metrics (Bu Ay Harcanan, Kartlar, Yaklaşan Ödeme) */}
			<SummaryMetrics isUnlocked={isUnlocked} />

			{/* 3. Lower Grid: Credit Card Details & Quick Templates */}
			<div className="dashboard-lower-grid">
				<CreditCardSummary isUnlocked={isUnlocked} />
				<QuickTemplatesStrip isUnlocked={isUnlocked} />
			</div>
		</div>
	);
}

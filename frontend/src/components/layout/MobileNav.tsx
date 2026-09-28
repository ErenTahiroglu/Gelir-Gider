import { Link, useRouterState } from "@tanstack/react-router";
import { CreditCard, Home, MoreHorizontal, Plus, Repeat } from "lucide-react";
import { useQuickEntry } from "../../context/QuickEntryContext";

export function MobileNav() {
	const { openQuickEntry } = useQuickEntry();
	const routerState = useRouterState();
	const currentPath = routerState.location.pathname;

	const isHomeActive = currentPath === "/";
	const isTransactionsActive =
		currentPath.startsWith("/transactions") ||
		currentPath.startsWith("/manual-expenses");

	return (
		<nav
			className="mobile-bottom-nav"
			data-testid="mobile-bottom-nav"
			aria-label="Mobil Gezinme Menüsü"
		>
			<div className="mobile-nav-inner">
				<Link
					to="/"
					className={`mobile-nav-item ${isHomeActive ? "active" : ""}`}
					aria-current={isHomeActive ? "page" : undefined}
					data-testid="mobile-nav-home"
					aria-label="Ana Sayfa"
				>
					<Home size={22} aria-hidden="true" />
					<span className="mobile-nav-label">Ana Sayfa</span>
				</Link>

				<Link
					to="/transactions"
					className={`mobile-nav-item ${isTransactionsActive ? "active" : ""}`}
					aria-current={isTransactionsActive ? "page" : undefined}
					data-testid="mobile-nav-transactions"
					aria-label="Hareketler"
				>
					<Repeat size={22} aria-hidden="true" />
					<span className="mobile-nav-label">Hareketler</span>
				</Link>

				<div className="mobile-nav-center">
					<button
						type="button"
						className="mobile-quick-entry-fab"
						onClick={() => openQuickEntry()}
						data-testid="mobile-quick-entry-fab"
						aria-label="Hızlı Kayıt"
						title="Hızlı Kayıt"
					>
						<Plus size={26} aria-hidden="true" />
					</button>
				</div>

				<button
					type="button"
					className="mobile-nav-item disabled"
					disabled
					aria-disabled="true"
					data-testid="mobile-nav-cards"
					aria-label="Kartlar (F5 aşamasında eklenecek)"
				>
					<CreditCard size={22} aria-hidden="true" />
					<span className="mobile-nav-label">Kartlar</span>
				</button>

				<button
					type="button"
					className="mobile-nav-item disabled"
					disabled
					aria-disabled="true"
					data-testid="mobile-nav-more"
					aria-label="Daha Fazla (Gelecek aşamalarda eklenecek)"
				>
					<MoreHorizontal size={22} aria-hidden="true" />
					<span className="mobile-nav-label">Daha Fazla</span>
				</button>
			</div>
		</nav>
	);
}

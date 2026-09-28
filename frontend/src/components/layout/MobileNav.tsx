import { Link } from "@tanstack/react-router";
import { CreditCard, Home, MoreHorizontal, Plus, Repeat } from "lucide-react";

export function MobileNav() {
	return (
		<nav
			className="mobile-bottom-nav"
			data-testid="mobile-bottom-nav"
			aria-label="Mobil Gezinme Menüsü"
		>
			<div className="mobile-nav-inner">
				<Link
					to="/"
					className="mobile-nav-item active"
					aria-current="page"
					data-testid="mobile-nav-home"
					aria-label="Ana Sayfa"
				>
					<Home size={22} aria-hidden="true" />
					<span className="mobile-nav-label">Ana Sayfa</span>
				</Link>

				<button
					type="button"
					className="mobile-nav-item disabled"
					disabled
					aria-disabled="true"
					data-testid="mobile-nav-transactions"
					aria-label="Hareketler (F3 aşamasında eklenecek)"
				>
					<Repeat size={22} aria-hidden="true" />
					<span className="mobile-nav-label">Hareketler</span>
				</button>

				<div className="mobile-nav-center">
					<button
						type="button"
						className="mobile-quick-entry-fab disabled"
						disabled
						aria-disabled="true"
						data-testid="mobile-quick-entry-fab"
						aria-label="Hızlı Kayıt (F4 aşamasında eklenecek)"
						title="Hızlı Kayıt (F4)"
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

import { Link, useRouterState } from "@tanstack/react-router";
import {
	Bell,
	CalendarCheck,
	ChevronLeft,
	ChevronRight,
	CreditCard,
	FileSpreadsheet,
	Home,
	PieChart,
	Repeat,
	Target,
	TrendingUp,
	Users,
	Wallet,
} from "lucide-react";
import { useEffect } from "react";

interface DesktopSidebarProps {
	collapsed: boolean;
	onToggleCollapse: () => void;
}

export function DesktopSidebar({
	collapsed,
	onToggleCollapse,
}: DesktopSidebarProps) {
	const routerState = useRouterState();
	const currentPath = routerState.location.pathname;

	const isHomeActive = currentPath === "/";
	const isTransactionsActive =
		currentPath.startsWith("/transactions") ||
		currentPath.startsWith("/manual-expenses");
	const isCardsActive = currentPath.startsWith("/cards");
	const isIncomeActive = currentPath.startsWith("/income");
	const isPeopleActive = currentPath.startsWith("/people");
	const isMidasActive = currentPath.startsWith("/midas");
	const isGoalsActive = currentPath.startsWith("/goals");
	const isLongTermActive = currentPath.startsWith("/long-term");
	const isMonthCloseActive = currentPath.startsWith("/month-close");
	const isImportsActive = currentPath.startsWith("/imports");
	const isNotificationsActive = currentPath.startsWith("/notifications");
	// Keyboard shortcut: Cmd/Ctrl + B to toggle sidebar
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
				const active = document.activeElement;
				if (
					active instanceof HTMLInputElement ||
					active instanceof HTMLTextAreaElement ||
					active instanceof HTMLSelectElement ||
					(active instanceof HTMLElement && active.isContentEditable)
				) {
					return;
				}
				e.preventDefault();
				onToggleCollapse();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onToggleCollapse]);

	return (
		<aside
			className={`desktop-sidebar ${collapsed ? "collapsed" : "expanded"}`}
			data-testid="desktop-sidebar"
			aria-label="Ana Menü"
		>
			<div className="sidebar-header">
				<div className="sidebar-brand">
					<div className="brand-logo" aria-hidden="true">
						GG
					</div>
					{!collapsed && <span className="brand-name">Gelir-Gider</span>}
				</div>

				<button
					type="button"
					className="sidebar-toggle-btn"
					onClick={onToggleCollapse}
					aria-label={
						collapsed
							? "Kenar çubuğunu genişlet (Ctrl+B)"
							: "Kenar çubuğunu daralt (Ctrl+B)"
					}
					title={collapsed ? "Genişlet (Ctrl+B)" : "Daralt (Ctrl+B)"}
					data-testid="sidebar-toggle-btn"
				>
					{collapsed ? (
						<ChevronRight size={18} aria-hidden="true" />
					) : (
						<ChevronLeft size={18} aria-hidden="true" />
					)}
				</button>
			</div>

			<nav className="sidebar-nav" aria-label="Sayfalar">
				<ul className="nav-list">
					<li className="nav-item">
						<Link
							to="/"
							className={`nav-link ${isHomeActive ? "active" : ""}`}
							aria-current={isHomeActive ? "page" : undefined}
							title={collapsed ? "Ana Sayfa" : undefined}
							data-testid="nav-link-home"
						>
							<Home size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Ana Sayfa</span>}
						</Link>
					</li>

					<li className="nav-item">
						<Link
							to="/transactions"
							className={`nav-link ${isTransactionsActive ? "active" : ""}`}
							aria-current={isTransactionsActive ? "page" : undefined}
							title={collapsed ? "Hareketler" : undefined}
							data-testid="nav-link-transactions"
						>
							<Repeat size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Hareketler</span>}
						</Link>
					</li>

					<li className="nav-item">
						<Link
							to="/cards"
							className={`nav-link ${isCardsActive ? "active" : ""}`}
							aria-current={isCardsActive ? "page" : undefined}
							title={collapsed ? "Kredi Kartları" : undefined}
							data-testid="nav-link-cards"
						>
							<CreditCard size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Kredi Kartları</span>}
						</Link>
					</li>

					<li className="nav-item">
						<Link
							to="/income"
							className={`nav-link ${isIncomeActive ? "active" : ""}`}
							aria-current={isIncomeActive ? "page" : undefined}
							title={collapsed ? "Gelirler" : undefined}
							data-testid="nav-link-income"
						>
							<Wallet size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Gelirler</span>}
						</Link>
					</li>

					<li className="nav-item">
						<Link
							to="/people"
							className={`nav-link ${isPeopleActive ? "active" : ""}`}
							aria-current={isPeopleActive ? "page" : undefined}
							title={collapsed ? "Kişiler" : undefined}
							data-testid="nav-link-people"
						>
							<Users size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Kişiler</span>}
						</Link>
					</li>

					<li className="nav-item">
						<Link
							to="/midas"
							className={`nav-link ${isMidasActive ? "active" : ""}`}
							aria-current={isMidasActive ? "page" : undefined}
							title={collapsed ? "Likidite" : undefined}
							data-testid="nav-link-midas"
						>
							<PieChart size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Likidite</span>}
						</Link>
					</li>

					<li className="nav-item">
						<Link
							to="/goals"
							className={`nav-link ${isGoalsActive ? "active" : ""}`}
							aria-current={isGoalsActive ? "page" : undefined}
							title={collapsed ? "Hedefler" : undefined}
							data-testid="nav-link-goals"
						>
							<Target size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Hedefler</span>}
						</Link>
					</li>

					<li className="nav-item">
						<Link
							to="/long-term"
							className={`nav-link ${isLongTermActive ? "active" : ""}`}
							aria-current={isLongTermActive ? "page" : undefined}
							title={collapsed ? "Uzun Vadeli" : undefined}
							data-testid="nav-link-long-term"
						>
							<TrendingUp size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Uzun Vadeli</span>}
						</Link>
					</li>

					<li className="nav-item">
						<Link
							to="/month-close"
							className={`nav-link ${isMonthCloseActive ? "active" : ""}`}
							aria-current={isMonthCloseActive ? "page" : undefined}
							title={collapsed ? "Ayı Tamamla" : undefined}
							data-testid="nav-link-month-close"
						>
							<CalendarCheck size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Ayı Tamamla</span>}
						</Link>
					</li>

					<li className="nav-item">
						<Link
							to="/imports"
							className={`nav-link ${isImportsActive ? "active" : ""}`}
							aria-current={isImportsActive ? "page" : undefined}
							title={collapsed ? "İçe Aktar" : undefined}
							data-testid="nav-link-imports"
						>
							<FileSpreadsheet size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">İçe Aktar</span>}
						</Link>
					</li>

					<li className="nav-item">
						<Link
							to="/notifications"
							className={`nav-link ${isNotificationsActive ? "active" : ""}`}
							aria-current={isNotificationsActive ? "page" : undefined}
							title={collapsed ? "Bildirimler" : undefined}
							data-testid="nav-link-notifications"
						>
							<Bell size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Bildirimler</span>}
						</Link>
					</li>
				</ul>
			</nav>
		</aside>
	);
}

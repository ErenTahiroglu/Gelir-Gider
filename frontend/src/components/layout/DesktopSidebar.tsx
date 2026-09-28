import {
	ChevronLeft,
	ChevronRight,
	CreditCard,
	Home,
	PieChart,
	Repeat,
	Target,
	TrendingUp,
	Users,
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
						<a
							href="/"
							className="nav-link active"
							aria-current="page"
							title={collapsed ? "Ana Sayfa" : undefined}
							data-testid="nav-link-home"
						>
							<Home size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Ana Sayfa</span>}
						</a>
					</li>

					<li className="nav-item">
						<button
							type="button"
							className="nav-link disabled"
							disabled
							aria-disabled="true"
							title={collapsed ? "Hareketler (F3)" : "F3 aşamasında eklenecek"}
							data-testid="nav-link-transactions"
						>
							<Repeat size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Hareketler</span>}
						</button>
					</li>

					<li className="nav-item">
						<button
							type="button"
							className="nav-link disabled"
							disabled
							aria-disabled="true"
							title={collapsed ? "Kartlar (F5)" : "F5 aşamasında eklenecek"}
							data-testid="nav-link-cards"
						>
							<CreditCard size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Kartlar</span>}
						</button>
					</li>

					<li className="nav-item">
						<button
							type="button"
							className="nav-link disabled"
							disabled
							aria-disabled="true"
							title={collapsed ? "Kişiler (F6)" : "F6 aşamasında eklenecek"}
							data-testid="nav-link-people"
						>
							<Users size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Kişiler</span>}
						</button>
					</li>

					<li className="nav-item">
						<button
							type="button"
							className="nav-link disabled"
							disabled
							aria-disabled="true"
							title={collapsed ? "Bütçe (F7)" : "F7 aşamasında eklenecek"}
							data-testid="nav-link-budget"
						>
							<PieChart size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Bütçe</span>}
						</button>
					</li>

					<li className="nav-item">
						<button
							type="button"
							className="nav-link disabled"
							disabled
							aria-disabled="true"
							title={collapsed ? "Hedefler (F8)" : "F8 aşamasında eklenecek"}
							data-testid="nav-link-goals"
						>
							<Target size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Hedefler</span>}
						</button>
					</li>

					<li className="nav-item">
						<button
							type="button"
							className="nav-link disabled"
							disabled
							aria-disabled="true"
							title={collapsed ? "Yatırımlar (F8)" : "F8 aşamasında eklenecek"}
							data-testid="nav-link-investments"
						>
							<TrendingUp size={20} aria-hidden="true" />
							{!collapsed && <span className="nav-label">Yatırımlar</span>}
						</button>
					</li>
				</ul>
			</nav>
		</aside>
	);
}

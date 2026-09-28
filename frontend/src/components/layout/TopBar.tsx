import { Bell, Calendar, Lock, LogOut } from "lucide-react";
import { useAuth } from "../../auth/auth-context";
import {
	formatPeriodMonthTurkish,
	getIstanbulPeriodMonth,
} from "../../lib/istanbul-date";

export function TopBar() {
	const { state, lockNow, logout } = useAuth();
	const currentPeriod = getIstanbulPeriodMonth();
	const periodLabel = formatPeriodMonthTurkish(currentPeriod);
	const displayName = state.status === "UNLOCKED" ? state.user.displayName : "";

	return (
		<header className="app-topbar">
			<div className="topbar-left">
				<div
					className="period-badge"
					data-testid="period-badge"
					title="Mevcut Dönem"
				>
					<Calendar size={16} aria-hidden="true" />
					<span className="period-text">{periodLabel}</span>
				</div>
			</div>

			<div className="topbar-right">
				{displayName && (
					<span className="user-greeting" data-testid="user-greeting">
						{displayName}
					</span>
				)}

				<button
					type="button"
					className="topbar-btn icon-btn"
					aria-label="Bildirimler (Henüz aktif değil)"
					title="Bildirimler"
					disabled
					aria-disabled="true"
				>
					<Bell size={18} aria-hidden="true" />
				</button>

				<button
					type="button"
					className="topbar-btn lock-btn"
					onClick={lockNow}
					data-testid="manual-lock-btn"
					aria-label="Uygulamayı Kilitle"
					title="Uygulamayı Kilitle"
				>
					<Lock size={16} aria-hidden="true" />
					<span className="btn-text">Kilitle</span>
				</button>

				<button
					type="button"
					className="topbar-btn logout-btn"
					onClick={() => void logout()}
					data-testid="topbar-logout-btn"
					aria-label="Çıkış Yap"
					title="Çıkış Yap"
				>
					<LogOut size={16} aria-hidden="true" />
					<span className="btn-text">Çıkış</span>
				</button>
			</div>
		</header>
	);
}

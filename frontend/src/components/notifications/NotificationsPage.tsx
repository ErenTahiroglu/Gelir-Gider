import { Bell, Settings } from "lucide-react";
import { useState } from "react";
import { NotificationEventList } from "./NotificationEventList";
import { PushSettings } from "./PushSettings";

export function NotificationsPage() {
	const [activeTab, setActiveTab] = useState<"history" | "settings">("history");

	return (
		<div
			className="page-container notifications-page"
			data-testid="notifications-page"
		>
			<div className="page-header">
				<div>
					<h1 className="page-title">Bildirim Merkezi</h1>
					<span className="page-subtitle">
						Ödeme planları, hatırlatmalar ve Web Push ayarları
					</span>
				</div>
			</div>

			<div
				className="filter-tabs-container"
				role="tablist"
				aria-label="Bildirim Sekmeleri"
			>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === "history"}
					className={`filter-tab ${activeTab === "history" ? "active" : ""}`}
					onClick={() => setActiveTab("history")}
					data-testid="tab-notification-history"
				>
					<Bell size={16} aria-hidden="true" />
					Bildirim Geçmişi
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === "settings"}
					className={`filter-tab ${activeTab === "settings" ? "active" : ""}`}
					onClick={() => setActiveTab("settings")}
					data-testid="tab-push-settings"
				>
					<Settings size={16} aria-hidden="true" />
					Push & Cihaz Ayarları
				</button>
			</div>

			<div className="tab-content-area">
				{activeTab === "history" && <NotificationEventList />}
				{activeTab === "settings" && <PushSettings />}
			</div>
		</div>
	);
}

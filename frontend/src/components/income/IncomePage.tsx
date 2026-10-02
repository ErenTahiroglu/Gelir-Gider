import { useState } from "react";
import "../../api/domain-errors";
import { IncomeEntitlementsPanel } from "./IncomeEntitlementsPanel";
import { IncomeOverviewPanel } from "./IncomeOverviewPanel";
import { IncomeReceiptsPanel } from "./IncomeReceiptsPanel";
import { IncomeSourcesPanel } from "./IncomeSourcesPanel";
import { ReferenceIncomePanel } from "./ReferenceIncomePanel";

type IncomeTab =
	| "overview"
	| "sources"
	| "entitlements"
	| "receipts"
	| "reference";

export function IncomePage() {
	const [activeTab, setActiveTab] = useState<IncomeTab>("overview");

	return (
		<div className="page-container income-page" data-testid="income-page">
			<div className="page-header">
				<div className="header-title-block">
					<h1 className="page-title">Gelir Yönetimi</h1>
					<p className="page-subtitle">
						Gelir kaynaklarınızı, beklenen aylık hak edişlerinizi ve gerçekleşen
						tahsilatları yönetin.
					</p>
				</div>
			</div>

			{/* Segmented Tab Controls */}
			<div className="segmented-tabs-wrapper">
				<div
					className="segmented-tabs"
					role="tablist"
					aria-label="Gelir Sekmeleri"
				>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "overview"}
						className={`segmented-tab ${activeTab === "overview" ? "active" : ""}`}
						onClick={() => setActiveTab("overview")}
						data-testid="tab-overview"
					>
						Genel Bakış
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "sources"}
						className={`segmented-tab ${activeTab === "sources" ? "active" : ""}`}
						onClick={() => setActiveTab("sources")}
						data-testid="tab-sources"
					>
						Gelir Kaynakları
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "entitlements"}
						className={`segmented-tab ${activeTab === "entitlements" ? "active" : ""}`}
						onClick={() => setActiveTab("entitlements")}
						data-testid="tab-entitlements"
					>
						Beklenen Gelirler
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "receipts"}
						className={`segmented-tab ${activeTab === "receipts" ? "active" : ""}`}
						onClick={() => setActiveTab("receipts")}
						data-testid="tab-receipts"
					>
						Gerçekleşen Gelirler
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "reference"}
						className={`segmented-tab ${activeTab === "reference" ? "active" : ""}`}
						onClick={() => setActiveTab("reference")}
						data-testid="tab-reference"
					>
						Referans Gelir
					</button>
				</div>
			</div>

			{/* Tab Panels */}
			<div className="tab-content">
				{activeTab === "overview" && (
					<IncomeOverviewPanel
						onSelectTab={(t) => setActiveTab(t as IncomeTab)}
					/>
				)}
				{activeTab === "sources" && <IncomeSourcesPanel />}
				{activeTab === "entitlements" && <IncomeEntitlementsPanel />}
				{activeTab === "receipts" && <IncomeReceiptsPanel />}
				{activeTab === "reference" && <ReferenceIncomePanel />}
			</div>
		</div>
	);
}

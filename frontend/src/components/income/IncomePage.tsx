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
		<div
			className="income-page container mx-auto px-4 py-6"
			data-testid="income-page"
		>
			<div className="flex flex-wrap justify-between items-center gap-4 mb-6">
				<div>
					<h1 className="page-title text-2xl font-bold">Gelir Yönetimi</h1>
					<p className="text-secondary text-sm">
						Gelir kaynaklarınızı, beklenen aylık hak edişlerinizi ve gerçekleşen
						tahsilatları yönetin.
					</p>
				</div>
			</div>

			{/* Segmented Tab Controls */}
			<div className="segmented-tabs-wrapper mb-6 overflow-x-auto">
				<div
					className="segmented-tabs flex gap-1 p-1 bg-secondary/15 rounded-lg w-max sm:w-auto"
					role="tablist"
					aria-label="Gelir Sekmeleri"
				>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "overview"}
						className={`segmented-tab px-4 py-2 text-sm font-medium rounded-md transition-colors ${
							activeTab === "overview"
								? "bg-surface shadow text-primary font-semibold"
								: "text-secondary hover:text-foreground"
						}`}
						onClick={() => setActiveTab("overview")}
						data-testid="tab-overview"
					>
						Genel Bakış
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "sources"}
						className={`segmented-tab px-4 py-2 text-sm font-medium rounded-md transition-colors ${
							activeTab === "sources"
								? "bg-surface shadow text-primary font-semibold"
								: "text-secondary hover:text-foreground"
						}`}
						onClick={() => setActiveTab("sources")}
						data-testid="tab-sources"
					>
						Gelir Kaynakları
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "entitlements"}
						className={`segmented-tab px-4 py-2 text-sm font-medium rounded-md transition-colors ${
							activeTab === "entitlements"
								? "bg-surface shadow text-primary font-semibold"
								: "text-secondary hover:text-foreground"
						}`}
						onClick={() => setActiveTab("entitlements")}
						data-testid="tab-entitlements"
					>
						Beklenen Gelirler
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "receipts"}
						className={`segmented-tab px-4 py-2 text-sm font-medium rounded-md transition-colors ${
							activeTab === "receipts"
								? "bg-surface shadow text-primary font-semibold"
								: "text-secondary hover:text-foreground"
						}`}
						onClick={() => setActiveTab("receipts")}
						data-testid="tab-receipts"
					>
						Gerçekleşen Gelirler
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "reference"}
						className={`segmented-tab px-4 py-2 text-sm font-medium rounded-md transition-colors ${
							activeTab === "reference"
								? "bg-surface shadow text-primary font-semibold"
								: "text-secondary hover:text-foreground"
						}`}
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

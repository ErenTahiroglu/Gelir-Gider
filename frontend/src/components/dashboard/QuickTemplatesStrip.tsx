import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bookmark, CreditCard, Sparkles } from "lucide-react";
import { fetchQuickEntryTemplates } from "../../api/dashboard-api";
import type { QuickEntryTemplatesResponse } from "../../api/dashboard-types";
import { useQuickEntry } from "../../context/QuickEntryContext";

interface QuickTemplatesStripProps {
	isUnlocked: boolean;
}

export function QuickTemplatesStrip({ isUnlocked }: QuickTemplatesStripProps) {
	const { openQuickEntry } = useQuickEntry();
	const navigate = useNavigate();

	const handleManageClick = () => {
		try {
			void navigate({ to: "/settings/quick-templates" });
		} catch {
			window.location.hash = "/settings/quick-templates";
		}
	};

	const templatesQuery = useQuery<QuickEntryTemplatesResponse>({
		queryKey: ["quick-entry-templates"],
		queryFn: fetchQuickEntryTemplates,
		enabled: isUnlocked,
	});

	const allTemplates = templatesQuery.data?.templates ?? [];

	// Filter only ACTIVE executable templates (MANUAL_EXPENSE and CREDIT_CARD_EXPENSE)
	const executableTemplates = allTemplates.filter(
		(t) =>
			t.status === "ACTIVE" &&
			(t.templateType === "MANUAL_EXPENSE" ||
				t.templateType === "CREDIT_CARD_EXPENSE"),
	);
	const topTemplates = executableTemplates.slice(0, 5);

	if (templatesQuery.isLoading) {
		return (
			<div
				className="dashboard-templates-section"
				data-testid="quick-templates-loading"
			>
				<h3 className="section-title">Hızlı Kayıt Şablonları</h3>
				<p className="section-loading">Şablonlar yükleniyor...</p>
			</div>
		);
	}

	if (templatesQuery.isError) {
		return (
			<div
				className="dashboard-templates-section"
				data-testid="quick-templates-error"
			>
				<h3 className="section-title">Hızlı Kayıt Şablonları</h3>
				<p className="section-error">Şablonlar alınamadı.</p>
			</div>
		);
	}

	if (executableTemplates.length === 0) {
		return (
			<div
				className="dashboard-templates-section"
				data-testid="quick-templates-empty"
			>
				<div className="section-header">
					<div className="section-title-wrap">
						<Sparkles size={16} className="section-icon" aria-hidden="true" />
						<h3 className="section-title">Hızlı Kayıt Şablonları</h3>
					</div>
					<button
						type="button"
						onClick={handleManageClick}
						className="manage-templates-link"
						data-testid="manage-templates-link"
					>
						Şablonları Yönet
					</button>
				</div>
				<p className="section-empty" data-testid="templates-empty-message">
					Henüz hızlı kayıt şablonu yok.
				</p>
			</div>
		);
	}

	return (
		<div
			className="dashboard-templates-section"
			data-testid="quick-templates-strip"
		>
			<div className="section-header">
				<div className="section-title-wrap">
					<Sparkles size={16} className="section-icon" aria-hidden="true" />
					<h3 className="section-title">Hızlı Kayıt Şablonları</h3>
				</div>
				<button
					type="button"
					onClick={handleManageClick}
					className="manage-templates-link"
					data-testid="manage-templates-link"
				>
					Şablonları Yönet
				</button>
			</div>

			<ul className="templates-chip-list" aria-label="Kayıtlı Şablonlar">
				{topTemplates.map((template) => (
					<li key={template.id} className="template-chip">
						<button
							type="button"
							className="template-chip-btn"
							onClick={() => openQuickEntry(template.id)}
							data-testid={`template-chip-${template.id}`}
						>
							{template.templateType === "CREDIT_CARD_EXPENSE" ? (
								<CreditCard
									size={14}
									className="chip-icon"
									aria-hidden="true"
								/>
							) : (
								<Bookmark size={14} className="chip-icon" aria-hidden="true" />
							)}
							<span className="chip-name">{template.name}</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

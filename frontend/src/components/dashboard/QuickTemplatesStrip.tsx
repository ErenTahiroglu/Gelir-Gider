import { useQuery } from "@tanstack/react-query";
import { Bookmark, Sparkles } from "lucide-react";
import { fetchQuickEntryTemplates } from "../../api/dashboard-api";
import type { QuickEntryTemplatesResponse } from "../../api/dashboard-types";

interface QuickTemplatesStripProps {
	isUnlocked: boolean;
}

export function QuickTemplatesStrip({ isUnlocked }: QuickTemplatesStripProps) {
	const templatesQuery = useQuery<QuickEntryTemplatesResponse>({
		queryKey: ["quick-entry-templates"],
		queryFn: fetchQuickEntryTemplates,
		enabled: isUnlocked,
	});

	const templates = templatesQuery.data?.templates ?? [];
	const topTemplates = templates.slice(0, 5);

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

	if (templates.length === 0) {
		return (
			<div
				className="dashboard-templates-section"
				data-testid="quick-templates-empty"
			>
				<div className="section-header">
					<h3 className="section-title">Hızlı Kayıt Şablonları</h3>
					<span className="section-badge read-only-badge">
						Salt Okunur (F4)
					</span>
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
				<span className="section-badge read-only-badge">Salt Okunur (F4)</span>
			</div>

			<ul className="templates-chip-list" aria-label="Kayıtlı Şablonlar">
				{topTemplates.map((template) => (
					<li
						key={template.id}
						className="template-chip"
						data-testid={`template-chip-${template.id}`}
					>
						<Bookmark size={14} className="chip-icon" aria-hidden="true" />
						<span className="chip-name">{template.name}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

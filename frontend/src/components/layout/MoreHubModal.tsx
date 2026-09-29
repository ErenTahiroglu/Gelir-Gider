import { Link, useRouterState } from "@tanstack/react-router";
import {
	Award,
	Calendar,
	FileText,
	PieChart,
	Sliders,
	Users,
} from "lucide-react";
import { AccessibleModal } from "../common/AccessibleModal";

interface MoreHubModalProps {
	isOpen: boolean;
	onClose: () => void;
}

export function MoreHubModal({ isOpen, onClose }: MoreHubModalProps) {
	const routerState = useRouterState();
	const currentPath = routerState.location.pathname;

	const isPeopleActive = currentPath.startsWith("/people");
	const isTemplatesActive = currentPath.startsWith("/settings/quick-templates");

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={onClose}
			title="Daha Fazla"
			variant="bottom-sheet"
			className="more-hub-modal"
		>
			<div className="more-hub-content" data-testid="more-hub-sheet">
				<div className="more-hub-section">
					<h3 className="more-hub-section-title">Hizmetler & Yönetim</h3>
					<ul className="more-hub-list">
						{/* Active item: Kişiler */}
						<li className="more-hub-item">
							<Link
								to="/people"
								className={`more-hub-link ${isPeopleActive ? "active" : ""}`}
								onClick={onClose}
								aria-current={isPeopleActive ? "page" : undefined}
								data-testid="more-hub-link-people"
							>
								<div className="more-hub-icon-wrapper">
									<Users size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<span className="more-hub-item-name">Kişiler</span>
									<span className="more-hub-item-desc">
										Borç, alacak ve tahsilat takibi
									</span>
								</div>
							</Link>
						</li>

						{/* Active item: Şablon Ayarları */}
						<li className="more-hub-item">
							<Link
								to="/settings/quick-templates"
								className={`more-hub-link ${isTemplatesActive ? "active" : ""}`}
								onClick={onClose}
								aria-current={isTemplatesActive ? "page" : undefined}
								data-testid="more-hub-link-templates"
							>
								<div className="more-hub-icon-wrapper">
									<Sliders size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<span className="more-hub-item-name">
										Hızlı Kayıt Şablonları
									</span>
									<span className="more-hub-item-desc">
										Şablonları yönet ve düzenle
									</span>
								</div>
							</Link>
						</li>
					</ul>
				</div>

				<div className="more-hub-section">
					<h3 className="more-hub-section-title">Gelecek Özellikler</h3>
					<ul className="more-hub-list">
						{/* Disabled F7: Bütçe & Hedefler */}
						<li className="more-hub-item">
							<button
								type="button"
								className="more-hub-link disabled"
								disabled
								aria-disabled="true"
								data-testid="more-hub-link-budget"
							>
								<div className="more-hub-icon-wrapper">
									<PieChart size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<div className="more-hub-item-header">
										<span className="more-hub-item-name">Bütçe & Hedefler</span>
										<span className="more-hub-badge">F7</span>
									</div>
									<span className="more-hub-item-desc">
										Aylık bütçe ve birikim hedefleri
									</span>
								</div>
							</button>
						</li>

						{/* Disabled F8: Ayı Tamamla */}
						<li className="more-hub-item">
							<button
								type="button"
								className="more-hub-link disabled"
								disabled
								aria-disabled="true"
								data-testid="more-hub-link-month-close"
							>
								<div className="more-hub-icon-wrapper">
									<Calendar size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<div className="more-hub-item-header">
										<span className="more-hub-item-name">Ayı Tamamla</span>
										<span className="more-hub-badge">F8</span>
									</div>
									<span className="more-hub-item-desc">
										Dönem sonu mutabakatı ve kapanış
									</span>
								</div>
							</button>
						</li>

						{/* Disabled F9: Ekstre İçe Aktar */}
						<li className="more-hub-item">
							<button
								type="button"
								className="more-hub-link disabled"
								disabled
								aria-disabled="true"
								data-testid="more-hub-link-statement-import"
							>
								<div className="more-hub-icon-wrapper">
									<FileText size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<div className="more-hub-item-header">
										<span className="more-hub-item-name">Ekstre İçe Aktar</span>
										<span className="more-hub-badge">F9</span>
									</div>
									<span className="more-hub-item-desc">
										PDF ve CSV ekstre yükleme
									</span>
								</div>
							</button>
						</li>

						{/* Disabled Future: Kampanyalar & Ödüller */}
						<li className="more-hub-item">
							<button
								type="button"
								className="more-hub-link disabled"
								disabled
								aria-disabled="true"
								data-testid="more-hub-link-campaigns"
							>
								<div className="more-hub-icon-wrapper">
									<Award size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<div className="more-hub-item-header">
										<span className="more-hub-item-name">
											Kampanyalar & Ödüller
										</span>
										<span className="more-hub-badge">Yakında</span>
									</div>
									<span className="more-hub-item-desc">
										Kart fırsatları ve puan takibi
									</span>
								</div>
							</button>
						</li>
					</ul>
				</div>
			</div>
		</AccessibleModal>
	);
}

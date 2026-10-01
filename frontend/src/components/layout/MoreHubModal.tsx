import { Link, useRouterState } from "@tanstack/react-router";
import {
	Award,
	Bell,
	Calendar,
	FileSpreadsheet,
	PieChart,
	Sliders,
	Target,
	TrendingUp,
	Users,
	Wallet,
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
	const isGoalsActive = currentPath.startsWith("/goals");
	const isMidasActive = currentPath.startsWith("/midas");
	const isLongTermActive = currentPath.startsWith("/long-term");
	const isIncomeActive = currentPath.startsWith("/income");
	const isMonthCloseActive = currentPath.startsWith("/month-close");
	const isImportsActive = currentPath.startsWith("/imports");
	const isNotificationsActive = currentPath.startsWith("/notifications");

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
						{/* Active item: Ekstre İçe Aktar (F9) */}
						<li className="more-hub-item">
							<Link
								to="/imports"
								className={`more-hub-link ${isImportsActive ? "active" : ""}`}
								onClick={onClose}
								aria-current={isImportsActive ? "page" : undefined}
								data-testid="more-hub-link-statement-import"
							>
								<div className="more-hub-icon-wrapper">
									<FileSpreadsheet size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<span className="more-hub-item-name">Ekstre İçe Aktar</span>
									<span className="more-hub-item-desc">
										CSV ekstre yükleme ve işlem eşleme
									</span>
								</div>
							</Link>
						</li>

						{/* Active item: Bildirimler (F9) */}
						<li className="more-hub-item">
							<Link
								to="/notifications"
								className={`more-hub-link ${isNotificationsActive ? "active" : ""}`}
								onClick={onClose}
								aria-current={isNotificationsActive ? "page" : undefined}
								data-testid="more-hub-link-notifications"
							>
								<div className="more-hub-icon-wrapper">
									<Bell size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<span className="more-hub-item-name">Bildirimler</span>
									<span className="more-hub-item-desc">
										Bildirim geçmişi ve Web Push ayarları
									</span>
								</div>
							</Link>
						</li>

						{/* Active item: Gelirler */}
						<li className="more-hub-item">
							<Link
								to="/income"
								className={`more-hub-link ${isIncomeActive ? "active" : ""}`}
								onClick={onClose}
								aria-current={isIncomeActive ? "page" : undefined}
								data-testid="more-hub-link-income"
							>
								<div className="more-hub-icon-wrapper">
									<Wallet size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<span className="more-hub-item-name">Gelirler</span>
									<span className="more-hub-item-desc">
										Kaynaklar, beklenen gelir ve tahsilatlar
									</span>
								</div>
							</Link>
						</li>

						{/* Active item: Ayı Tamamla */}
						<li className="more-hub-item">
							<Link
								to="/month-close"
								className={`more-hub-link ${isMonthCloseActive ? "active" : ""}`}
								onClick={onClose}
								aria-current={isMonthCloseActive ? "page" : undefined}
								data-testid="more-hub-link-month-close"
							>
								<div className="more-hub-icon-wrapper">
									<Calendar size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<span className="more-hub-item-name">Ayı Tamamla</span>
									<span className="more-hub-item-desc">
										Dönem sonu mutabakatı ve kapanış
									</span>
								</div>
							</Link>
						</li>

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

						{/* Active item: Hedefler */}
						<li className="more-hub-item">
							<Link
								to="/goals"
								className={`more-hub-link ${isGoalsActive ? "active" : ""}`}
								onClick={onClose}
								aria-current={isGoalsActive ? "page" : undefined}
								data-testid="more-hub-link-goals"
							>
								<div className="more-hub-icon-wrapper">
									<Target size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<span className="more-hub-item-name">Hedefler</span>
									<span className="more-hub-item-desc">
										Kısa vadeli birikim ve harcama hedefleri
									</span>
								</div>
							</Link>
						</li>

						{/* Active item: Midas Likidite */}
						<li className="more-hub-item">
							<Link
								to="/midas"
								className={`more-hub-link ${isMidasActive ? "active" : ""}`}
								onClick={onClose}
								aria-current={isMidasActive ? "page" : undefined}
								data-testid="more-hub-link-midas"
							>
								<div className="more-hub-icon-wrapper">
									<PieChart size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<span className="more-hub-item-name">Midas Likidite</span>
									<span className="more-hub-item-desc">
										Kart rezervi ve serbest bakiye yönetimi
									</span>
								</div>
							</Link>
						</li>

						{/* Active item: Uzun Vadeli */}
						<li className="more-hub-item">
							<Link
								to="/long-term"
								className={`more-hub-link ${isLongTermActive ? "active" : ""}`}
								onClick={onClose}
								aria-current={isLongTermActive ? "page" : undefined}
								data-testid="more-hub-link-long-term"
							>
								<div className="more-hub-icon-wrapper">
									<TrendingUp size={20} aria-hidden="true" />
								</div>
								<div className="more-hub-item-info">
									<span className="more-hub-item-name">Uzun Vadeli</span>
									<span className="more-hub-item-desc">
										Uzun vadeli yatırım transfer görevleri
									</span>
								</div>
							</Link>
						</li>
					</ul>
				</div>

				<div className="more-hub-section">
					<h3 className="more-hub-section-title">Gelecek Özellikler</h3>
					<ul className="more-hub-list">
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

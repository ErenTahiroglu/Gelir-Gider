/**
 * Template Management Component
 *
 * Route: /settings/quick-templates
 * Adheres strictly to Sections 21-36, 56-59:
 *   - Displays Aktif and Arşivlenmiş templates separately
 *   - Create supported templates: MANUAL_EXPENSE and CREDIT_CARD_EXPENSE
 *   - Edit supported templates: full config replacement, templateType is strictly immutable
 *   - Archive: POST /quick-entry/templates/:id/archive. No hard delete, no unarchive
 *   - Unsupported templates (INCOME, RECEIVABLE, PAYABLE): displayed with future-domain notice
 *   - Network uncertainty: refetches list and prompts user to check list before retrying (no auto-retry)
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	Archive,
	ArrowLeft,
	Bookmark,
	CreditCard,
	Edit2,
	Plus,
	Sliders,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError } from "../../api/errors";
import {
	fetchAllLedgerAccounts,
	fetchSpendingCategories,
} from "../../api/manual-expenses-api";
import {
	archiveQuickEntryTemplate,
	createQuickEntryTemplate,
	fetchAllActiveCreditCards,
	fetchQuickEntryTemplates,
	updateQuickEntryTemplate,
} from "../../api/quick-entry-api";
import type {
	BudgetCategorySelection,
	CreateTemplatePayload,
	QuickEntryTemplateItem,
	QuickEntryTemplateType,
	UpdateTemplatePayload,
} from "../../api/quick-entry-types";
import { MoneyInput } from "../common/MoneyInput";

export function TemplateManagement() {
	const queryClient = useQueryClient();

	// 1. Fetch templates
	const {
		data: templatesData,
		isLoading: templatesLoading,
		error: templatesError,
		refetch: refetchTemplates,
	} = useQuery({
		queryKey: ["quick-entry-templates"],
		queryFn: fetchQuickEntryTemplates,
	});

	// Reference data for creation / editing
	const { data: accounts } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		staleTime: 60_000,
	});

	const { data: categoriesData } = useQuery({
		queryKey: ["spending-categories"],
		queryFn: fetchSpendingCategories,
		staleTime: 60_000,
	});

	const { data: cards } = useQuery({
		queryKey: ["active-credit-cards"],
		queryFn: () => fetchAllActiveCreditCards(100),
		staleTime: 60_000,
	});

	const selectableAccounts = useMemo(
		() =>
			(accounts ?? []).filter(
				(acc) =>
					acc.accountType === "ASSET" &&
					acc.currency === "TRY" &&
					acc.archived === false,
			),
		[accounts],
	);

	const activeCategories = useMemo(
		() =>
			(categoriesData?.categories ?? []).filter((c) => c.status === "ACTIVE"),
		[categoriesData?.categories],
	);

	const activeCards = cards ?? [];

	// Local State
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [modalMode, setModalMode] = useState<"create" | "edit">("create");
	const [editingTemplate, setEditingTemplate] =
		useState<QuickEntryTemplateItem | null>(null);

	// Form State
	const [name, setName] = useState("");
	const [templateType, setTemplateType] = useState<
		"MANUAL_EXPENSE" | "CREDIT_CARD_EXPENSE"
	>("MANUAL_EXPENSE");
	const [sortOrder, setSortOrder] = useState<number>(0);
	const [sourceAssetAccountId, setSourceAssetAccountId] = useState("");
	const [cardId, setCardId] = useState("");
	const [spendingCategoryId, setSpendingCategoryId] = useState("");
	const [budgetCategoryOverride, setBudgetCategoryOverride] =
		useState<BudgetCategorySelection>("MANDATORY_EXPENSE");
	const [defaultAmountCanonical, setDefaultAmountCanonical] = useState("");
	const [defaultAmountDisplay, setDefaultAmountDisplay] = useState("");
	const [defaultAmountValid, setDefaultAmountValid] = useState(true);
	const [merchant, setMerchant] = useState("");
	const [description, setDescription] = useState("");

	// Submission state
	const [formSubmitting, setFormSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [networkUncertaintyWarning, setNetworkUncertaintyWarning] = useState<
		string | null
	>(null);

	// Template lists: Active vs Archived
	const templates = templatesData?.templates ?? [];
	const activeTemplates = templates.filter((t) => t.status === "ACTIVE");
	const archivedTemplates = templates.filter((t) => t.status === "ARCHIVED");

	const openCreateModal = () => {
		setModalMode("create");
		setEditingTemplate(null);
		setName("");
		setTemplateType("MANUAL_EXPENSE");
		setSortOrder(0);
		setSourceAssetAccountId(selectableAccounts[0]?.accountId ?? "");
		setCardId(activeCards[0]?.cardId ?? "");
		setSpendingCategoryId("");
		setBudgetCategoryOverride("MANDATORY_EXPENSE");
		setDefaultAmountCanonical("");
		setDefaultAmountDisplay("");
		setDefaultAmountValid(true);
		setMerchant("");
		setDescription("");
		setFormError(null);
		setNetworkUncertaintyWarning(null);
		setIsModalOpen(true);
	};

	const openEditModal = (t: QuickEntryTemplateItem) => {
		setModalMode("edit");
		setEditingTemplate(t);
		setName(t.name);
		setSortOrder(t.sortOrder);

		const cfg = t.config as Record<string, unknown>;

		if (t.templateType === "MANUAL_EXPENSE") {
			setTemplateType("MANUAL_EXPENSE");
			setSourceAssetAccountId((cfg.sourceAssetAccountId as string) ?? "");
			setSpendingCategoryId((cfg.spendingCategoryId as string) ?? "");
			setBudgetCategoryOverride(
				(cfg.budgetCategoryOverride as BudgetCategorySelection) ??
					"MANDATORY_EXPENSE",
			);
			setMerchant((cfg.merchant as string) ?? "");
			setDescription((cfg.description as string) ?? "");

			const amt = (cfg.defaultAmount as string) ?? "";
			setDefaultAmountCanonical(amt);
			if (amt) {
				const parts = amt.split(".");
				setDefaultAmountDisplay(
					parts[1] !== undefined ? `${parts[0]},${parts[1]}` : (parts[0] ?? ""),
				);
			} else {
				setDefaultAmountDisplay("");
			}
			setDefaultAmountValid(true);
		} else if (t.templateType === "CREDIT_CARD_EXPENSE") {
			setTemplateType("CREDIT_CARD_EXPENSE");
			setCardId((cfg.cardId as string) ?? "");
			setSpendingCategoryId((cfg.spendingCategoryId as string) ?? "");
			setBudgetCategoryOverride(
				(cfg.budgetCategoryOverride as BudgetCategorySelection) ??
					"MANDATORY_EXPENSE",
			);
			setMerchant((cfg.merchant as string) ?? "");
			setDescription((cfg.description as string) ?? "");

			const amt = (cfg.defaultAmount as string) ?? "";
			setDefaultAmountCanonical(amt);
			if (amt) {
				const parts = amt.split(".");
				setDefaultAmountDisplay(
					parts[1] !== undefined ? `${parts[0]},${parts[1]}` : (parts[0] ?? ""),
				);
			} else {
				setDefaultAmountDisplay("");
			}
			setDefaultAmountValid(true);
		} else {
			// Unsupported template type: only name and sortOrder can be safely updated
			setFormError(null);
		}

		setFormError(null);
		setNetworkUncertaintyWarning(null);
		setIsModalOpen(true);
	};

	const closeModal = () => {
		setIsModalOpen(false);
		setEditingTemplate(null);
		setFormError(null);
		setNetworkUncertaintyWarning(null);
	};

	const handleCategoryChange = (catId: string) => {
		setSpendingCategoryId(catId);
		if (!catId) return;

		const cat = activeCategories.find((c) => c.id === catId);
		if (!cat) return;

		if (cat.defaultBudgetCategory === "ASK") {
			setBudgetCategoryOverride("MANDATORY_EXPENSE");
		} else {
			setBudgetCategoryOverride(cat.defaultBudgetCategory);
		}
	};

	const handleFormSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		const trimmedName = name.trim();
		if (!trimmedName || trimmedName.length > 100) {
			setFormError("Lütfen 1-100 karakter arasında bir şablon adı girin.");
			return;
		}

		if (sortOrder < 0 || !Number.isInteger(sortOrder)) {
			setFormError("Sıra negatif olmayan bir tam sayı olmalıdır.");
			return;
		}

		if (!defaultAmountValid) {
			setFormError("Lütfen geçerli bir varsayılan tutar girin.");
			return;
		}

		setFormSubmitting(true);
		setFormError(null);
		setNetworkUncertaintyWarning(null);

		try {
			if (modalMode === "create") {
				let config: Record<string, unknown> = {};

				if (templateType === "MANUAL_EXPENSE") {
					if (!sourceAssetAccountId) {
						setFormError("Lütfen bir ödeme kaynağı seçin.");
						setFormSubmitting(false);
						return;
					}
					config = {
						sourceAssetAccountId,
						spendingCategoryId: spendingCategoryId || undefined,
						budgetCategoryOverride,
						merchant: merchant.trim() || undefined,
						description: description.trim() || undefined,
						defaultAmount: defaultAmountCanonical || undefined,
					};
				} else if (templateType === "CREDIT_CARD_EXPENSE") {
					if (!cardId) {
						setFormError("Lütfen bir kart seçin.");
						setFormSubmitting(false);
						return;
					}
					config = {
						cardId,
						spendingCategoryId: spendingCategoryId || undefined,
						budgetCategoryOverride,
						merchant: merchant.trim() || undefined,
						description: description.trim() || undefined,
						defaultAmount: defaultAmountCanonical || undefined,
					};
				}

				const payload: CreateTemplatePayload = {
					name: trimmedName,
					templateType,
					config,
					sortOrder,
				};

				await createQuickEntryTemplate(payload);
			} else {
				// Edit mode: Send complete intended config
				if (!editingTemplate) return;

				let config: Record<string, unknown> = {};
				const existingCfg = (editingTemplate.config ?? {}) as Record<
					string,
					unknown
				>;

				if (editingTemplate.templateType === "MANUAL_EXPENSE") {
					if (!sourceAssetAccountId) {
						setFormError("Lütfen bir ödeme kaynağı seçin.");
						setFormSubmitting(false);
						return;
					}
					config = {
						sourceAssetAccountId,
						spendingCategoryId: spendingCategoryId || undefined,
						budgetCategoryOverride,
						merchant: merchant.trim() || undefined,
						description: description.trim() || undefined,
						defaultAmount: defaultAmountCanonical || undefined,
					};
				} else if (editingTemplate.templateType === "CREDIT_CARD_EXPENSE") {
					if (!cardId) {
						setFormError("Lütfen bir kart seçin.");
						setFormSubmitting(false);
						return;
					}
					config = {
						cardId,
						spendingCategoryId: spendingCategoryId || undefined,
						budgetCategoryOverride,
						merchant: merchant.trim() || undefined,
						description: description.trim() || undefined,
						defaultAmount: defaultAmountCanonical || undefined,
						// Section 36: Preserve existing shortTermGoalId!
						shortTermGoalId: existingCfg.shortTermGoalId as string | undefined,
					};
				} else {
					// Unsupported future domain template: preserve its existing config entirely!
					config = existingCfg;
				}

				const payload: UpdateTemplatePayload = {
					name: trimmedName,
					config,
					sortOrder,
				};

				await updateQuickEntryTemplate(editingTemplate.id, payload);
			}

			// Invalidate templates query across surfaces
			await queryClient.invalidateQueries({
				queryKey: ["quick-entry-templates"],
			});
			closeModal();
		} catch (err) {
			if (err instanceof ApiError && err.code === "NETWORK_ERROR") {
				// Section 30: Network uncertainty
				setNetworkUncertaintyWarning(
					"Şablon işleminin tamamlanıp tamamlanmadığı doğrulanamadı. Liste yenilendi; tekrar işlem yapmadan önce kontrol edin.",
				);
				void refetchTemplates();
			} else {
				setFormError(
					err instanceof ApiError
						? err.message || "Şablon kaydedilirken bir hata oluştu."
						: "Beklenmeyen bir hata oluştu.",
				);
			}
		} finally {
			setFormSubmitting(false);
		}
	};

	const handleArchive = async (templateId: string) => {
		try {
			await archiveQuickEntryTemplate(templateId);
			await queryClient.invalidateQueries({
				queryKey: ["quick-entry-templates"],
			});
		} catch (err) {
			setFormError("Şablon arşivlenirken bir hata oluştu.");
		}
	};

	const getTemplateTypeLabel = (type: QuickEntryTemplateType) => {
		switch (type) {
			case "MANUAL_EXPENSE":
				return "Nakit / Banka";
			case "CREDIT_CARD_EXPENSE":
				return "Kredi Kartı";
			case "INCOME":
				return "Gelir";
			case "RECEIVABLE":
				return "Alacak";
			case "PAYABLE":
				return "Borç";
			default:
				return type;
		}
	};

	return (
		<div
			className="template-management-container"
			data-testid="template-management-page"
		>
			<div className="template-management-header">
				<div className="header-left">
					<Link
						to="/"
						className="back-link btn btn-secondary btn-sm"
						data-testid="back-to-dashboard-btn"
					>
						<ArrowLeft size={16} aria-hidden="true" />
						<span>Ana Sayfa</span>
					</Link>
					<h1 className="page-title">Hızlı Kayıt Şablonları</h1>
				</div>
				<button
					type="button"
					onClick={openCreateModal}
					className="btn btn-primary"
					data-testid="create-template-btn"
				>
					<Plus size={16} aria-hidden="true" />
					<span>Yeni Şablon</span>
				</button>
			</div>

			{/* Global error banner */}
			{templatesError && (
				<div
					className="form-error-banner"
					role="alert"
					data-testid="templates-fetch-error"
				>
					<span>Şablonlar yüklenirken bir hata oluştu.</span>
					<button
						type="button"
						onClick={() => refetchTemplates()}
						className="btn btn-secondary btn-sm"
						style={{ marginLeft: "12px" }}
					>
						Tekrar Dene
					</button>
				</div>
			)}

			{/* Loading State */}
			{templatesLoading && (
				<p className="loading-text" data-testid="templates-loading">
					Şablonlar yükleniyor...
				</p>
			)}

			{!templatesLoading && (
				<div className="templates-sections-container">
					{/* 1. AKTİF ŞABLONLAR */}
					<div className="templates-section">
						<h2 className="section-title">Aktif Şablonlar</h2>
						{activeTemplates.length === 0 ? (
							<p
								className="empty-text"
								data-testid="no-active-templates-message"
							>
								Aktif şablon bulunamadı.
							</p>
						) : (
							<div
								className="templates-grid"
								data-testid="active-templates-list"
							>
								{activeTemplates.map((t) => {
									const isSupported =
										t.templateType === "MANUAL_EXPENSE" ||
										t.templateType === "CREDIT_CARD_EXPENSE";
									const cfg = t.config as Record<string, unknown>;

									return (
										<div
											key={t.id}
											className="template-card card"
											data-testid={`template-card-${t.id}`}
										>
											<div className="template-card-header">
												<div className="template-card-title-wrap">
													<div className="template-card-icon">
														{t.templateType === "CREDIT_CARD_EXPENSE" ? (
															<CreditCard size={18} aria-hidden="true" />
														) : (
															<Bookmark size={18} aria-hidden="true" />
														)}
													</div>
													<div>
														<h3 className="template-name">{t.name}</h3>
														<span className="template-type-badge">
															{getTemplateTypeLabel(t.templateType)}
														</span>
													</div>
												</div>
												<span className="template-sort-badge">
													Sıra: {t.sortOrder}
												</span>
											</div>

											{/* Config details */}
											<div className="template-card-body">
												{Boolean(cfg.defaultAmount) && (
													<p className="template-detail-item">
														<strong>Tutar:</strong> {String(cfg.defaultAmount)}{" "}
														₺
													</p>
												)}
												{Boolean(cfg.merchant) && (
													<p className="template-detail-item">
														<strong>İşyeri:</strong> {String(cfg.merchant)}
													</p>
												)}
												{Boolean(cfg.description) && (
													<p className="template-detail-item">
														<strong>Açıklama:</strong> {String(cfg.description)}
													</p>
												)}

												{!isSupported && (
													<p
														className="future-domain-notice"
														data-testid={`future-domain-notice-${t.id}`}
													>
														Henüz bu hızlı kayıt türü kullanıma açılmadı.
													</p>
												)}
											</div>

											{/* Actions */}
											<div className="template-card-actions">
												<button
													type="button"
													onClick={() => openEditModal(t)}
													className="btn btn-secondary btn-sm"
													data-testid={`edit-template-btn-${t.id}`}
												>
													<Edit2 size={14} aria-hidden="true" />
													<span>Düzenle</span>
												</button>
												<button
													type="button"
													onClick={() => handleArchive(t.id)}
													className="btn btn-secondary btn-sm"
													data-testid={`archive-template-btn-${t.id}`}
												>
													<Archive size={14} aria-hidden="true" />
													<span>Arşivle</span>
												</button>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</div>

					{/* 2. ARŞİVLENMİŞ ŞABLONLAR */}
					<div className="templates-section">
						<h2 className="section-title">Arşivlenmiş Şablonlar</h2>
						{archivedTemplates.length === 0 ? (
							<p
								className="empty-text"
								data-testid="no-archived-templates-message"
							>
								Arşivlenmiş şablon bulunamadı.
							</p>
						) : (
							<div
								className="templates-grid"
								data-testid="archived-templates-list"
							>
								{archivedTemplates.map((t) => (
									<div
										key={t.id}
										className="template-card card archived"
										data-testid={`archived-card-${t.id}`}
									>
										<div className="template-card-header">
											<div>
												<h3 className="template-name">{t.name}</h3>
												<span className="template-type-badge">
													{getTemplateTypeLabel(t.templateType)}
												</span>
											</div>
											<span className="archived-status-badge">Arşivlendi</span>
										</div>
										<p className="archived-note">
											Bu şablon arşivlenmiş olup hızlı kayıtlarda görünmez.
										</p>
									</div>
								))}
							</div>
						)}
					</div>
				</div>
			)}

			{/* Create / Edit Modal */}
			{isModalOpen && (
				<div
					className="accessible-modal-overlay"
					data-testid="template-form-modal"
				>
					<div
						className="accessible-modal-backdrop"
						onClick={closeModal}
						aria-hidden="true"
					/>
					<div
						className="accessible-modal-content modal-variant-center-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="template-modal-title"
						tabIndex={-1}
					>
						<header className="modal-header">
							<h2 id="template-modal-title" className="modal-title">
								{modalMode === "create" ? "Yeni Şablon" : "Şablonu Düzenle"}
							</h2>
							<button
								type="button"
								onClick={closeModal}
								className="modal-close-btn"
								aria-label="Kapat"
							>
								✕
							</button>
						</header>

						<div className="modal-body">
							{/* Network Uncertainty Warning */}
							{networkUncertaintyWarning && (
								<div
									className="form-warning-banner"
									role="alert"
									data-testid="network-uncertainty-warning"
								>
									{networkUncertaintyWarning}
								</div>
							)}

							{/* Form Error */}
							{formError && (
								<div
									className="form-error-banner"
									role="alert"
									data-testid="template-form-error"
								>
									{formError}
								</div>
							)}

							<form onSubmit={handleFormSubmit} noValidate>
								{/* Şablon Adı * */}
								<div className="form-group">
									<label htmlFor="tpl-name" className="form-label required">
										Şablon Adı *
									</label>
									<input
										type="text"
										id="tpl-name"
										value={name}
										onChange={(e) => setName(e.target.value)}
										maxLength={100}
										required
										className="form-input"
										data-testid="tpl-name-input"
									/>
								</div>

								{/* Şablon Türü (Create mode: choose; Edit mode: immutable text) */}
								<div className="form-group">
									<span className="form-label required">Şablon Türü *</span>
									{modalMode === "create" ? (
										<div className="financial-class-options" role="radiogroup">
											<label className="radio-option">
												<input
													type="radio"
													name="createTemplateType"
													value="MANUAL_EXPENSE"
													checked={templateType === "MANUAL_EXPENSE"}
													onChange={() => setTemplateType("MANUAL_EXPENSE")}
													data-testid="tpl-type-manual"
												/>
												<span>Nakit / Banka Harcaması</span>
											</label>
											<label className="radio-option">
												<input
													type="radio"
													name="createTemplateType"
													value="CREDIT_CARD_EXPENSE"
													checked={templateType === "CREDIT_CARD_EXPENSE"}
													onChange={() =>
														setTemplateType("CREDIT_CARD_EXPENSE")
													}
													data-testid="tpl-type-cc"
												/>
												<span>Kredi Kartı Harcaması</span>
											</label>
										</div>
									) : (
										<p
											className="immutable-type-text"
											data-testid="immutable-template-type"
										>
											<strong>
												{getTemplateTypeLabel(
													editingTemplate?.templateType ?? "MANUAL_EXPENSE",
												)}
											</strong>
											<span
												style={{
													color: "var(--text-secondary)",
													fontSize: "var(--font-size-xs)",
													marginLeft: "8px",
												}}
											>
												(Şablon türü değiştirilemez)
											</span>
										</p>
									)}
								</div>

								{/* MANUAL_EXPENSE Specific: Ödeme Kaynağı * */}
								{templateType === "MANUAL_EXPENSE" && (
									<div className="form-group">
										<label
											htmlFor="tpl-source-account"
											className="form-label required"
										>
											Ödeme Kaynağı *
										</label>
										<select
											id="tpl-source-account"
											value={sourceAssetAccountId}
											onChange={(e) => setSourceAssetAccountId(e.target.value)}
											required
											className="form-select"
											data-testid="tpl-source-account-select"
										>
											<option value="">Hesap Seçin...</option>
											{selectableAccounts.map((acc) => (
												<option key={acc.accountId} value={acc.accountId}>
													{acc.name} ({acc.currency})
												</option>
											))}
										</select>
									</div>
								)}

								{/* CREDIT_CARD_EXPENSE Specific: Kart * */}
								{templateType === "CREDIT_CARD_EXPENSE" && (
									<div className="form-group">
										<label htmlFor="tpl-card" className="form-label required">
											Kart *
										</label>
										<select
											id="tpl-card"
											value={cardId}
											onChange={(e) => setCardId(e.target.value)}
											required
											className="form-select"
											data-testid="tpl-card-select"
										>
											<option value="">Kart Seçin...</option>
											{activeCards.map((c) => (
												<option key={c.cardId} value={c.cardId}>
													{c.displayName || c.issuer} ({c.code})
												</option>
											))}
										</select>
									</div>
								)}

								{/* Kategori */}
								{(templateType === "MANUAL_EXPENSE" ||
									templateType === "CREDIT_CARD_EXPENSE") && (
									<div className="form-group">
										<label htmlFor="tpl-category" className="form-label">
											Kategori
										</label>
										<select
											id="tpl-category"
											value={spendingCategoryId}
											onChange={(e) => handleCategoryChange(e.target.value)}
											className="form-select"
											data-testid="tpl-category-select"
										>
											<option value="">Kategori Seçin (İsteğe bağlı)</option>
											{activeCategories.map((cat) => (
												<option key={cat.id} value={cat.id}>
													{cat.name}
												</option>
											))}
										</select>
									</div>
								)}

								{/* Finansal Sınıf * */}
								{(templateType === "MANUAL_EXPENSE" ||
									templateType === "CREDIT_CARD_EXPENSE") && (
									<div className="form-group">
										<span className="form-label required">
											Harcama Türü / Finansal Sınıf *
										</span>
										<div className="financial-class-options" role="radiogroup">
											<label className="radio-option">
												<input
													type="radio"
													name="tplBudgetCategory"
													value="MANDATORY_EXPENSE"
													checked={
														budgetCategoryOverride === "MANDATORY_EXPENSE"
													}
													onChange={() =>
														setBudgetCategoryOverride("MANDATORY_EXPENSE")
													}
													data-testid="tpl-class-mandatory"
												/>
												<span>Zorunlu Temel İhtiyaç</span>
											</label>
											<label className="radio-option">
												<input
													type="radio"
													name="tplBudgetCategory"
													value="DISCRETIONARY_SPEND"
													checked={
														budgetCategoryOverride === "DISCRETIONARY_SPEND"
													}
													onChange={() =>
														setBudgetCategoryOverride("DISCRETIONARY_SPEND")
													}
													data-testid="tpl-class-discretionary"
												/>
												<span>Keyfi / Esnek Harcama</span>
											</label>
											<label className="radio-option">
												<input
													type="radio"
													name="tplBudgetCategory"
													value="SHORT_TERM_PURCHASE"
													checked={
														budgetCategoryOverride === "SHORT_TERM_PURCHASE"
													}
													onChange={() =>
														setBudgetCategoryOverride("SHORT_TERM_PURCHASE")
													}
													data-testid="tpl-class-short-term"
												/>
												<span>Planlı Kısa Vadeli Alım</span>
											</label>
										</div>
									</div>
								)}

								{/* Varsayılan Tutar */}
								{(templateType === "MANUAL_EXPENSE" ||
									templateType === "CREDIT_CARD_EXPENSE") && (
									<div className="form-group">
										<label htmlFor="tpl-default-amount" className="form-label">
											Varsayılan Tutar (İsteğe bağlı)
										</label>
										<MoneyInput
											id="tpl-default-amount"
											value={defaultAmountDisplay}
											onChange={(canonical, raw, isValid) => {
												setDefaultAmountCanonical(canonical);
												setDefaultAmountDisplay(raw);
												setDefaultAmountValid(isValid);
											}}
										/>
									</div>
								)}

								{/* İşyeri */}
								{(templateType === "MANUAL_EXPENSE" ||
									templateType === "CREDIT_CARD_EXPENSE") && (
									<div className="form-group">
										<label htmlFor="tpl-merchant" className="form-label">
											İşyeri (İsteğe bağlı)
										</label>
										<input
											type="text"
											id="tpl-merchant"
											value={merchant}
											onChange={(e) => setMerchant(e.target.value)}
											maxLength={100}
											placeholder="Örn: Migros"
											className="form-input"
											data-testid="tpl-merchant-input"
										/>
									</div>
								)}

								{/* Açıklama */}
								{(templateType === "MANUAL_EXPENSE" ||
									templateType === "CREDIT_CARD_EXPENSE") && (
									<div className="form-group">
										<label htmlFor="tpl-description" className="form-label">
											Açıklama (İsteğe bağlı)
										</label>
										<input
											type="text"
											id="tpl-description"
											value={description}
											onChange={(e) => setDescription(e.target.value)}
											maxLength={255}
											placeholder="Örn: Haftalık alışveriş"
											className="form-input"
											data-testid="tpl-description-input"
										/>
									</div>
								)}

								{/* Sıra */}
								<div className="form-group">
									<label htmlFor="tpl-sort-order" className="form-label">
										Sıra (Görüntüleme Önceliği)
									</label>
									<input
										type="number"
										id="tpl-sort-order"
										value={sortOrder}
										onChange={(e) =>
											setSortOrder(Math.max(0, Number(e.target.value) || 0))
										}
										min={0}
										className="form-input"
										data-testid="tpl-sort-order-input"
									/>
								</div>

								{/* Actions */}
								<div className="form-actions">
									<button
										type="button"
										onClick={closeModal}
										disabled={formSubmitting}
										className="btn btn-secondary"
									>
										Vazgeç
									</button>
									<button
										type="submit"
										disabled={formSubmitting || !defaultAmountValid}
										className="btn btn-primary"
										data-testid="tpl-save-btn"
									>
										{formSubmitting ? "Kaydediliyor..." : "Kaydet"}
									</button>
								</div>
							</form>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

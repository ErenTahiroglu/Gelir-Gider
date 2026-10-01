/**
 * Quick Entry Sheet Component
 *
 * Accessible bottom-sheet on mobile / center-dialog on desktop.
 * Opens immediately on FAB or Dashboard chip tap without waiting for network.
 * Provides 3-tap happy path for executable templates.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	ArrowLeft,
	Bookmark,
	Coins,
	CreditCard,
	DollarSign,
	Settings,
	Wallet,
} from "lucide-react";
import { useState } from "react";
import { fetchAllActivePeople } from "../../api/people-api";
import { fetchQuickEntryTemplates } from "../../api/quick-entry-api";
import type {
	CreditCardExpenseTemplateConfig,
	IncomeTemplateConfig,
	QuickEntryTemplateItem,
} from "../../api/quick-entry-types";
import { useQuickEntry } from "../../context/QuickEntryContext";
import { AccessibleModal } from "../common/AccessibleModal";
import { IncomeReceiptForm } from "../income/IncomeReceiptForm";
import {
	ManualExpenseForm,
	type ManualExpenseInitialValues,
} from "../manual-expenses/ManualExpenseForm";
import { ObligationForm } from "../people/obligations/ObligationForm";
import { CreditCardQuickPurchaseForm } from "./CreditCardQuickPurchaseForm";

export function QuickEntrySheet() {
	const { isOpen } = useQuickEntry();
	if (!isOpen) return null;
	return <QuickEntryModalContent />;
}

function QuickEntryModalContent() {
	const { isOpen, selectedTemplateId, closeQuickEntry, selectTemplate } =
		useQuickEntry();
	const navigate = useNavigate();

	const [directType, setDirectType] = useState<
		"NONE" | "MANUAL_EXPENSE" | "CREDIT_CARD_EXPENSE" | "INCOME"
	>("NONE");
	const [overridePersonId, setOverridePersonId] = useState<string>("");
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	// Load templates using shared query key ["quick-entry-templates"]
	const { data: templatesData, isLoading: templatesLoading } = useQuery({
		queryKey: ["quick-entry-templates"],
		queryFn: fetchQuickEntryTemplates,
		enabled: isOpen,
	});

	// Load active people for obligation templates
	const { data: peopleData } = useQuery({
		queryKey: ["active-people"],
		queryFn: () => fetchAllActivePeople(100),
		enabled: isOpen,
	});

	const allTemplates = templatesData?.templates ?? [];
	const activePeople = peopleData ?? [];

	// Filter only ACTIVE and supported execution types for the sheet (Section 65 + F8 INCOME)
	const activeExecutableTemplates = allTemplates.filter(
		(t) =>
			t.status === "ACTIVE" &&
			(t.templateType === "MANUAL_EXPENSE" ||
				t.templateType === "CREDIT_CARD_EXPENSE" ||
				t.templateType === "RECEIVABLE" ||
				t.templateType === "PAYABLE" ||
				t.templateType === "INCOME"),
	);

	const selectedTemplate = selectedTemplateId
		? allTemplates.find((t) => t.id === selectedTemplateId)
		: null;

	const handleClose = () => {
		setDirectType("NONE");
		setOverridePersonId("");
		setSuccessMessage(null);
		closeQuickEntry();
	};

	const handleBack = () => {
		selectTemplate(null);
		setDirectType("NONE");
		setOverridePersonId("");
		setSuccessMessage(null);
	};

	const handleSuccess = () => {
		setSuccessMessage("İşlem kaydedildi");
		setTimeout(() => {
			handleClose();
		}, 800);
	};

	const handleManageTemplates = () => {
		handleClose();
		void navigate({ to: "/settings/quick-templates" });
	};

	// Determine Modal Title
	let title = "Hızlı Kayıt";
	if (selectedTemplate) {
		title = selectedTemplate.name;
	} else if (directType === "MANUAL_EXPENSE") {
		title = "Nakit / Banka Harcaması";
	} else if (directType === "CREDIT_CARD_EXPENSE") {
		title = "Kart Harcaması";
	} else if (directType === "INCOME") {
		title = "Gelir Gir";
	}

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={handleClose}
			title={title}
			variant="bottom-sheet"
			className="quick-entry-modal"
		>
			<div className="quick-entry-content" data-testid="quick-entry-sheet">
				{/* Success Banner */}
				{successMessage && (
					<div
						className="quick-entry-success-banner"
						role="status"
						data-testid="quick-entry-success"
					>
						<span>✓ {successMessage}</span>
					</div>
				)}

				{/* Back navigation button if inside a form */}
				{(selectedTemplate || directType !== "NONE") && (
					<button
						type="button"
						onClick={handleBack}
						className="quick-entry-back-btn"
						data-testid="quick-entry-back-btn"
						aria-label="Şablonlara Dön"
					>
						<ArrowLeft size={16} aria-hidden="true" />
						<span>Tüm Seçenekler</span>
					</button>
				)}

				{/* 1. Form view: Executable template selected */}
				{selectedTemplate && (
					<div className="quick-entry-form-container">
						{selectedTemplate.templateType === "MANUAL_EXPENSE" && (
							<ManualExpenseForm
								mode="create"
								quickEntryMode={true}
								initialValues={{
									amount: (selectedTemplate.config as Record<string, unknown>)
										.defaultAmount as string | undefined,
									sourceAssetAccountId: (
										selectedTemplate.config as Record<string, unknown>
									).sourceAssetAccountId as string | undefined,
									spendingCategoryId: (
										selectedTemplate.config as Record<string, unknown>
									).spendingCategoryId as string | undefined,
									budgetCategoryOverride: (
										selectedTemplate.config as Record<string, unknown>
									).budgetCategoryOverride as
										| ManualExpenseInitialValues["budgetCategoryOverride"]
										| undefined,
									merchant: (selectedTemplate.config as Record<string, unknown>)
										.merchant as string | undefined,
									description: (
										selectedTemplate.config as Record<string, unknown>
									).description as string | undefined,
								}}
								onSuccess={handleSuccess}
								onCancel={handleClose}
							/>
						)}

						{selectedTemplate.templateType === "CREDIT_CARD_EXPENSE" && (
							<CreditCardQuickPurchaseForm
								config={
									selectedTemplate.config as CreditCardExpenseTemplateConfig
								}
								onSuccess={handleSuccess}
								onCancel={handleClose}
							/>
						)}

						{(selectedTemplate.templateType === "RECEIVABLE" ||
							selectedTemplate.templateType === "PAYABLE") &&
							(() => {
								const cfg = selectedTemplate.config as Record<string, unknown>;
								const targetPersonId =
									overridePersonId || (cfg.personId as string | undefined);
								const matchedPerson = activePeople.find(
									(p) => p.personId === targetPersonId,
								);

								if (!matchedPerson) {
									return (
										<div className="stale-person-box card">
											<div
												className="alert alert-warning"
												role="alert"
												data-testid="stale-person-warning"
											>
												<span>
													Şablondaki kişi artık kullanılamıyor. Lütfen başka bir
													kişi seçin.
												</span>
											</div>
											<div className="form-group mt-3">
												<label
													htmlFor="quick-override-person"
													className="form-label"
												>
													Geçerli Kişi Seçin
												</label>
												<select
													id="quick-override-person"
													className="form-control"
													value={overridePersonId}
													onChange={(e) => setOverridePersonId(e.target.value)}
													data-testid="quick-override-person-select"
												>
													<option value="">Kişi Seçin...</option>
													{activePeople.map((p) => (
														<option key={p.personId} value={p.personId}>
															{p.displayName}
														</option>
													))}
												</select>
											</div>
										</div>
									);
								}

								return (
									<ObligationForm
										mode="create"
										personId={matchedPerson.personId}
										initialDirection={selectedTemplate.templateType}
										initialValues={{
											amount: cfg.defaultAmount as string | undefined,
											description: cfg.description as string | undefined,
											dueDate: cfg.dueDate as string | undefined,
										}}
										onSuccess={handleSuccess}
										onCancel={handleClose}
									/>
								);
							})()}

						{/* F8: INCOME template execution */}
						{selectedTemplate.templateType === "INCOME" && (
							<IncomeTemplateExecution
								cfg={selectedTemplate.config as IncomeTemplateConfig}
								onSuccess={handleSuccess}
								onClose={handleClose}
							/>
						)}
					</div>
				)}

				{/* 2. Form view: Direct manual expense creation */}
				{!selectedTemplate && directType === "MANUAL_EXPENSE" && (
					<div className="quick-entry-form-container">
						<ManualExpenseForm
							mode="create"
							quickEntryMode={false}
							onSuccess={handleSuccess}
							onCancel={handleClose}
						/>
					</div>
				)}

				{/* 3. Form view: Direct credit card purchase creation */}
				{!selectedTemplate && directType === "CREDIT_CARD_EXPENSE" && (
					<div className="quick-entry-form-container">
						<CreditCardQuickPurchaseForm
							onSuccess={handleSuccess}
							onCancel={handleClose}
						/>
					</div>
				)}

				{/* 4. Form view: Direct income entry */}
				{!selectedTemplate && directType === "INCOME" && (
					<div className="quick-entry-form-container">
						<DirectIncomeEntry
							onSuccess={handleSuccess}
							onClose={handleClose}
						/>
					</div>
				)}

				{/* 4. Selection view: List templates and direct buttons */}
				{!selectedTemplate && directType === "NONE" && (
					<div className="quick-entry-initial-view">
						{/* Saved executable templates section */}
						<div className="quick-entry-section">
							<h3 className="quick-entry-section-label">Kayıtlı Şablonlar</h3>

							{templatesLoading ? (
								<p className="quick-entry-loading-text">
									Şablonlar yükleniyor...
								</p>
							) : activeExecutableTemplates.length === 0 ? (
								<p
									className="quick-entry-empty-text"
									data-testid="quick-entry-empty"
								>
									Kayıtlı aktif şablon bulunamadı.
								</p>
							) : (
								<div
									className="quick-entry-templates-grid"
									data-testid="quick-entry-templates-list"
								>
									{activeExecutableTemplates.map(
										(template: QuickEntryTemplateItem) => (
											<button
												key={template.id}
												type="button"
												className="quick-entry-template-btn"
												onClick={() => selectTemplate(template.id)}
												data-testid={`quick-template-btn-${template.id}`}
											>
												<div className="template-btn-icon">
													{template.templateType === "CREDIT_CARD_EXPENSE" ? (
														<CreditCard size={18} aria-hidden="true" />
													) : template.templateType === "RECEIVABLE" ||
														template.templateType === "PAYABLE" ? (
														<Coins size={18} aria-hidden="true" />
													) : template.templateType === "INCOME" ? (
														<Wallet size={18} aria-hidden="true" />
													) : (
														<Bookmark size={18} aria-hidden="true" />
													)}
												</div>
												<div className="template-btn-info">
													<span className="template-btn-name">
														{template.name}
													</span>
													{Boolean(
														(template.config as Record<string, unknown>)
															.defaultAmount,
													) && (
														<span className="template-btn-amount">
															{String(
																(template.config as Record<string, unknown>)
																	.defaultAmount,
															)}{" "}
															₺
														</span>
													)}
												</div>
											</button>
										),
									)}
								</div>
							)}
						</div>

						{/* Direct entry buttons */}
						<div className="quick-entry-section">
							<h3 className="quick-entry-section-label">Hızlı Harcama Gir</h3>
							<div className="quick-entry-direct-actions">
								<button
									type="button"
									className="quick-entry-action-card"
									onClick={() => setDirectType("MANUAL_EXPENSE")}
									data-testid="quick-entry-cash-btn"
								>
									<DollarSign size={20} aria-hidden="true" />
									<span>Nakit / Banka Harcaması</span>
								</button>
								<button
									type="button"
									className="quick-entry-action-card"
									onClick={() => setDirectType("CREDIT_CARD_EXPENSE")}
									data-testid="quick-entry-card-btn"
								>
									<CreditCard size={20} aria-hidden="true" />
									<span>Kart Harcaması</span>
								</button>
								<button
									type="button"
									className="quick-entry-action-card"
									onClick={() => setDirectType("INCOME")}
									data-testid="quick-entry-income-btn"
								>
									<Wallet size={20} aria-hidden="true" />
									<span>Gelir Gir</span>
								</button>
							</div>
						</div>

						{/* Manage templates footer link */}
						<div className="quick-entry-footer">
							<button
								type="button"
								className="quick-entry-manage-link"
								onClick={handleManageTemplates}
								data-testid="quick-entry-manage-link"
							>
								<Settings size={16} aria-hidden="true" />
								<span>Şablonları Yönet</span>
							</button>
						</div>
					</div>
				)}
			</div>
		</AccessibleModal>
	);
}

// =============================================================================
// F8: Income Template Execution
// Executes INCOME templates through POST /income/receipts.
// Prompts for destinationAccountId and receivedAt (not stored in template config).
// =============================================================================
interface IncomeTemplateExecutionProps {
	cfg: IncomeTemplateConfig;
	onSuccess: () => void;
	onClose: () => void;
}

function IncomeTemplateExecution({
	cfg,
	onSuccess,
	onClose,
}: IncomeTemplateExecutionProps) {
	return (
		<IncomeReceiptForm
			initialValues={{
				...(cfg.incomeSourceId !== undefined
					? { sourceId: cfg.incomeSourceId }
					: {}),
				...(cfg.defaultAmount !== undefined
					? { amount: cfg.defaultAmount }
					: {}),
				...(cfg.description !== undefined ? { note: cfg.description } : {}),
			}}
			onSuccess={onSuccess}
			onCancel={onClose}
			isQuickEntry={true}
		/>
	);
}

// =============================================================================
// F8: Direct Income Entry
// Opens IncomeReceiptForm without any template prefill.
// =============================================================================
interface DirectIncomeEntryProps {
	onSuccess: () => void;
	onClose: () => void;
}

function DirectIncomeEntry({ onSuccess, onClose }: DirectIncomeEntryProps) {
	return (
		<IncomeReceiptForm
			onSuccess={onSuccess}
			onCancel={onClose}
			isQuickEntry={true}
		/>
	);
}

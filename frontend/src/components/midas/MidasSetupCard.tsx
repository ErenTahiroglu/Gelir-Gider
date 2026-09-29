import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, RefreshCw, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import { fetchMidasLiquidity, setupMidasAccount } from "../../api/f7-api";
import { fetchAllLedgerAccounts } from "../../api/manual-expenses-api";
import type { LedgerAccountItem } from "../../api/manual-expenses-types";
import { formatMoneyToTry, parseMoneyToCents } from "../../lib/money";

interface MidasSetupCardProps {
	onSetupSuccess?: () => void;
}

export function MidasSetupCard({ onSetupSuccess }: MidasSetupCardProps) {
	const queryClient = useQueryClient();
	const [selectedAccountId, setSelectedAccountId] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);

	// Load all ledger accounts (paginated helper)
	const {
		data: accounts,
		isLoading: accountsLoading,
		error: accountsError,
	} = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		staleTime: 60_000,
	});

	// Eligible candidate (Section 12):
	// accountType === "ASSET" && normalBalance === "DEBIT" && currency === "TRY" && archived === false
	// Prefer preventing negative-balance accounts using BigInt cents
	const eligibleAccounts = useMemo(() => {
		if (!accounts) return [];
		return accounts.filter((acc: LedgerAccountItem) => {
			if (
				acc.accountType !== "ASSET" ||
				acc.normalBalance !== "DEBIT" ||
				acc.currency !== "TRY" ||
				acc.archived
			) {
				return false;
			}
			try {
				return parseMoneyToCents(acc.balance) >= 0n;
			} catch {
				return false;
			}
		});
	}, [accounts]);

	const setupMutation = useMutation({
		mutationFn: async (ledgerAccountId: string) => {
			return setupMidasAccount(ledgerAccountId);
		},
		onSuccess: () => {
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
			onSetupSuccess?.();
		},
		onError: async (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				// Section 14: Network uncertainty recovery for Midas setup
				// First refetch GET /midas/liquidity
				try {
					const state = await fetchMidasLiquidity();
					if (state?.liquidity?.ledgerAccountId === selectedAccountId) {
						// Success verified!
						setIsNetworkUncertain(false);
						setErrorMessage(null);
						void queryClient.invalidateQueries({
							queryKey: ["midas-liquidity"],
						});
						onSetupSuccess?.();
						return;
					}
					if (state?.liquidity?.ledgerAccountId) {
						// Another account linked
						setIsNetworkUncertain(false);
						setErrorMessage(
							"Midas hesabı başka bir kasa/banka hesabına bağlanmış.",
						);
						return;
					}
				} catch {
					// Still not configured or network down
				}
				setIsNetworkUncertain(true);
				setErrorMessage("Midas hesabının bağlanıp bağlanmadığı doğrulanamadı.");
				return;
			}

			setIsNetworkUncertain(false);
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error ? err.message : "Midas hesabı bağlanamadı.",
				);
			}
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!selectedAccountId) {
			setErrorMessage("Lütfen Midas'a bağlanacak bir kasa/banka hesabı seçin.");
			return;
		}
		setErrorMessage(null);
		setIsNetworkUncertain(false);
		setupMutation.mutate(selectedAccountId);
	};

	const handleRetry = () => {
		if (!selectedAccountId) return;
		setupMutation.mutate(selectedAccountId);
	};

	return (
		<div className="card midas-setup-card" data-testid="midas-setup-card">
			<div className="card-header">
				<div className="header-icon-badge">
					<Wallet size={24} aria-hidden="true" />
				</div>
				<div>
					<h2 className="card-title">Midas Likidite Hesabını Bağla</h2>
					<p className="card-subtitle">
						Kredi kartı rezervleri, hedefler ve yatırımlar için Midas likidite
						havuzunu kurun.
					</p>
				</div>
			</div>

			<div className="midas-setup-body">
				<p className="setup-explanation">
					Midas likidite yönetimi, sistemdeki tek bir varlık hesabı (kasa/banka)
					ile eşleşir. Bu hesap üzerinden kart borçları için rezerv ayrılabilir,
					kısa vadeli hedefler fonlanabilir ve uzun vadeli yatırımlar takip
					edilebilir.
				</p>

				{errorMessage && (
					<div
						className={`alert ${isNetworkUncertain ? "alert-warning" : "alert-danger"}`}
						role="alert"
						data-testid="midas-setup-alert"
					>
						<AlertCircle size={18} aria-hidden="true" />
						<div className="alert-content">
							<span>{errorMessage}</span>
							{isNetworkUncertain && (
								<div className="alert-actions mt-2">
									<button
										type="button"
										className="btn btn-sm btn-primary"
										onClick={handleRetry}
										disabled={setupMutation.isPending}
										data-testid="retry-uncertain-btn"
									>
										<RefreshCw
											size={14}
											className={setupMutation.isPending ? "spin" : ""}
											aria-hidden="true"
										/>
										<span>Aynı İşlemi Tekrar Dene</span>
									</button>
								</div>
							)}
						</div>
					</div>
				)}

				<form onSubmit={handleSubmit} className="setup-form">
					<div className="form-group">
						<label htmlFor="midas-ledger-account" className="form-label">
							Bağlanacak Kasa / Banka Hesabı
						</label>

						{accountsLoading ? (
							<div className="loading-state">
								<RefreshCw size={16} className="spin" aria-hidden="true" />
								<span>Hesaplar yükleniyor...</span>
							</div>
						) : accountsError ? (
							<div className="text-danger">Hesaplar yüklenemedi.</div>
						) : eligibleAccounts.length === 0 ? (
							<div className="text-muted">
								Uygun, negatif bakiyesi olmayan bir TL varlık hesabı bulunamadı.
							</div>
						) : (
							<select
								id="midas-ledger-account"
								className="form-select"
								value={selectedAccountId}
								onChange={(e) => {
									setSelectedAccountId(e.target.value);
									setErrorMessage(null);
								}}
								disabled={setupMutation.isPending || isNetworkUncertain}
								data-testid="midas-ledger-account-select"
								required
							>
								<option value="">Hesap Seçin...</option>
								{eligibleAccounts.map((acc) => (
									<option key={acc.accountId} value={acc.accountId}>
										{acc.name} ({acc.code}) — {formatMoneyToTry(acc.balance)}
									</option>
								))}
							</select>
						)}
					</div>

					<div className="setup-actions">
						<button
							type="submit"
							className="btn btn-primary"
							disabled={
								!selectedAccountId ||
								setupMutation.isPending ||
								isNetworkUncertain
							}
							data-testid="midas-setup-submit-btn"
						>
							{setupMutation.isPending ? (
								<>
									<RefreshCw size={16} className="spin" aria-hidden="true" />
									<span>Bağlanıyor...</span>
								</>
							) : (
								<>
									<CheckCircle2 size={16} aria-hidden="true" />
									<span>Midas Hesabını Kur</span>
								</>
							)}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

import {
	Check,
	Clock,
	Copy,
	Key,
	Plus,
	RefreshCw,
	ShieldCheck,
	Smartphone,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/errors";
import * as authApi from "../../auth/auth-api";
import type { RegisteredDevice } from "../../auth/auth-types";
import { getWebAuthnAdapter } from "../../auth/webauthn-client";

export function DeviceManagementPage() {
	const [devices, setDevices] = useState<RegisteredDevice[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Pairing modal state
	const [isGenerating, setIsGenerating] = useState(false);
	const [pairingToken, setPairingToken] = useState<string | null>(null);
	const [pairingExpiresAt, setPairingExpiresAt] = useState<Date | null>(null);
	const [copied, setCopied] = useState(false);
	const [pairingError, setPairingError] = useState<string | null>(null);

	const loadDevices = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const res = await authApi.fetchDevices();
			setDevices(res.devices);
		} catch (err) {
			setError(
				err instanceof ApiError
					? err.userMessage
					: "Kayıtlı cihazlar yüklenemedi.",
			);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadDevices();
	}, [loadDevices]);

	const handleCreatePairingGrant = async () => {
		setIsGenerating(true);
		setPairingError(null);
		setPairingToken(null);
		setPairingExpiresAt(null);
		setCopied(false);

		try {
			// 1. Get fresh reauth options
			const options = await authApi.fetchReauthOptions();
			// 2. Perform WebAuthn assertion on this trusted device
			const adapter = getWebAuthnAdapter();
			const assertion = await adapter.authenticate(options);
			// 3. Request pairing grant from backend
			const grantRes = await authApi.createPairingGrant({
				response: assertion,
			});

			setPairingToken(grantRes.enrollmentGrantToken);
			setPairingExpiresAt(new Date(grantRes.expiresAt));
		} catch (err) {
			const message =
				err instanceof ApiError
					? err.userMessage
					: "Yeni cihaz eşleme yetkilendirmesi başarısız oldu.";
			setPairingError(message);
		} finally {
			setIsGenerating(false);
		}
	};

	const handleCopyToken = async () => {
		if (!pairingToken) return;
		try {
			await navigator.clipboard.writeText(pairingToken);
			setCopied(true);
			setTimeout(() => setCopied(false), 3000);
		} catch {
			// Fallback if clipboard API is unavailable
			setCopied(true);
		}
	};

	const formatDate = (isoString: string | null) => {
		if (!isoString) return "-";
		try {
			return new Intl.DateTimeFormat("tr-TR", {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(new Date(isoString));
		} catch {
			return isoString;
		}
	};

	return (
		<div className="page-container" data-testid="device-management-page">
			<header className="page-header">
				<div>
					<h1 className="page-title">Güvenlik & Cihazlar</h1>
					<p className="page-subtitle">
						Hesabınıza erişim yetkisi olan Passkey cihazlarını görüntüleyin ve
						yeni cihaz eşleyin.
					</p>
				</div>
				<button
					type="button"
					className="btn btn-primary"
					onClick={() => void handleCreatePairingGrant()}
					disabled={isGenerating}
					data-testid="add-device-button"
				>
					<Plus size={16} aria-hidden="true" />
					{isGenerating ? "Doğrulanıyor..." : "Yeni Cihaz / Passkey Ekle"}
				</button>
			</header>

			{error && (
				<div
					className="auth-alert"
					role="alert"
					style={{ marginBottom: "var(--space-4)" }}
				>
					{error}
				</div>
			)}

			{/* Pairing Code Card */}
			{(pairingToken || pairingError) && (
				<section
					className="card"
					style={{
						marginBottom: "var(--space-6)",
						borderColor: pairingError
							? "var(--color-danger, #ef4444)"
							: "var(--color-primary, #6366f1)",
						backgroundColor: "var(--surface-raised)",
					}}
					data-testid="pairing-grant-section"
				>
					<div className="card-header">
						<div className="card-title-group">
							<ShieldCheck size={20} aria-hidden="true" />
							<h2 className="card-title">Yeni Cihaz Eşleme Kodu</h2>
						</div>
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={() => {
								setPairingToken(null);
								setPairingError(null);
								void loadDevices();
							}}
							data-testid="close-pairing-section-button"
						>
							Kapat
						</button>
					</div>

					{pairingError ? (
						<div className="auth-alert" role="alert">
							{pairingError}
						</div>
					) : (
						<div>
							<p style={{ margin: "0 0 var(--space-3) 0", lineHeight: 1.5 }}>
								Bu kod <strong>tek kullanımlıktır</strong> ve 10 dakika
								geçerlidir. İkinci cihazınızda (ör. Honor 90) Gelir-Gider kilit
								ekranından <strong>"Yeni cihaz bağla"</strong> seçeneğini açıp
								bu kodu girin.
							</p>

							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: "var(--space-2)",
									padding: "var(--space-3)",
									background: "var(--surface-base)",
									borderRadius: "var(--radius-md)",
									border: "1px dashed var(--color-border)",
									wordBreak: "break-all",
									fontFamily: "var(--font-mono, monospace)",
									fontSize: "var(--font-size-base)",
								}}
							>
								<code
									style={{ flex: 1, userSelect: "all" }}
									data-testid="pairing-token-display"
								>
									{pairingToken}
								</code>
								<button
									type="button"
									className="btn btn-secondary btn-sm"
									onClick={() => void handleCopyToken()}
									data-testid="copy-pairing-token-button"
									aria-label="Eşleme kodunu kopyala"
								>
									{copied ? (
										<>
											<Check size={16} aria-hidden="true" />
											Kopyalandı
										</>
									) : (
										<>
											<Copy size={16} aria-hidden="true" />
											Kopyala
										</>
									)}
								</button>
							</div>

							{pairingExpiresAt && (
								<p
									style={{
										display: "flex",
										alignItems: "center",
										gap: "var(--space-1)",
										margin: "var(--space-2) 0 0 0",
										fontSize: "var(--font-size-xs)",
										color: "var(--text-muted)",
									}}
								>
									<Clock size={14} aria-hidden="true" />
									Son geçerlilik: {formatDate(pairingExpiresAt.toISOString())}
								</p>
							)}
						</div>
					)}
				</section>
			)}

			{/* Registered Devices List */}
			<section className="card" data-testid="registered-devices-card">
				<div className="card-header">
					<div className="card-title-group">
						<Smartphone size={20} aria-hidden="true" />
						<h2 className="card-title">Kayıtlı Cihazlar</h2>
					</div>
					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={() => void loadDevices()}
						disabled={isLoading}
						aria-label="Cihaz listesini yenile"
					>
						<RefreshCw
							size={16}
							className={isLoading ? "spin" : ""}
							aria-hidden="true"
						/>
					</button>
				</div>

				{isLoading ? (
					<div style={{ padding: "var(--space-6)", textAlign: "center" }}>
						Yükleniyor...
					</div>
				) : devices.length === 0 ? (
					<div className="empty-state-card">
						<Key size={32} aria-hidden="true" />
						<p>Henüz kayıtlı cihaz bulunmuyor.</p>
					</div>
				) : (
					<div className="batch-cards-grid" style={{ gap: "var(--space-3)" }}>
						{devices.map((device, idx) => (
							<div
								key={device.id}
								className="card"
								style={{
									display: "flex",
									flexDirection: "column",
									gap: "var(--space-2)",
									backgroundColor: "var(--surface-raised)",
								}}
								data-testid={`device-item-${device.id}`}
							>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
									}}
								>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: "var(--space-2)",
										}}
									>
										<Smartphone size={18} aria-hidden="true" />
										<span style={{ fontWeight: 600 }}>{device.deviceName}</span>
									</div>
									{idx === 0 && (
										<span
											className="badge badge-success"
											style={{
												padding: "2px 8px",
												borderRadius: "var(--radius-full)",
												fontSize: "var(--font-size-xs)",
												background: "rgba(16, 185, 129, 0.15)",
												color: "var(--color-success, #10b981)",
											}}
										>
											Birincil / Aktif
										</span>
									)}
								</div>

								<div
									style={{
										fontSize: "var(--font-size-xs)",
										color: "var(--text-muted)",
										display: "flex",
										flexWrap: "wrap",
										gap: "var(--space-4)",
									}}
								>
									<span>Eklenme: {formatDate(device.createdAt)}</span>
									{device.lastUsedAt && (
										<span>Son Kullanım: {formatDate(device.lastUsedAt)}</span>
									)}
								</div>
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
export default DeviceManagementPage;

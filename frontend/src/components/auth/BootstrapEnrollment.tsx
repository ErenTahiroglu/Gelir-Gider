import type React from "react";
import { useState } from "react";
import { useAuth } from "../../auth/auth-context";

export function BootstrapEnrollment() {
	const { state, submitBootstrap, submitEnrollment } = useAuth();

	const [bootstrapToken, setBootstrapToken] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [deviceName, setDeviceName] = useState("Bu cihaz");
	const [localError, setLocalError] = useState<string | null>(null);

	const isAuthorizing = state.status === "BOOTSTRAP_AUTHORIZING";
	const isEnrolling = state.status === "ENROLLING";

	const errorMessage =
		localError ||
		(state.status === "BOOTSTRAP_REQUIRED" || state.status === "ENROLLING"
			? state.error
			: undefined);

	const handleAuthorize = async (e: React.FormEvent) => {
		e.preventDefault();
		setLocalError(null);

		if (!bootstrapToken.trim() || !displayName.trim()) {
			setLocalError("Lütfen kurulum anahtarını ve kullanıcı adınızı girin.");
			return;
		}

		await submitBootstrap(bootstrapToken.trim(), displayName.trim());
		// Clear sensitive token from input state
		setBootstrapToken("");
	};

	const handleRegisterPasskey = async (e: React.FormEvent) => {
		e.preventDefault();
		setLocalError(null);

		if (!deviceName.trim()) {
			setLocalError("Lütfen bir cihaz adı girin.");
			return;
		}

		await submitEnrollment(deviceName.trim());
	};

	return (
		<main className="auth-surface" data-testid="bootstrap-enrollment">
			<div className="auth-card">
				<header className="auth-header">
					<h1 className="auth-title">İlk Kurulum</h1>
					<p className="auth-subtitle">
						{isEnrolling
							? "Passkey oluşturmak için cihaz adınızı belirleyin."
							: "Sistemi kullanmaya başlamak için kurulum anahtarınızı girin."}
					</p>
				</header>

				{errorMessage && (
					<div
						className="auth-alert"
						role="alert"
						aria-live="polite"
						data-testid="bootstrap-error-alert"
					>
						{errorMessage}
					</div>
				)}

				{!isEnrolling ? (
					<form onSubmit={(e) => void handleAuthorize(e)} className="auth-form">
						<div className="form-group">
							<label htmlFor="bootstrap-token-input">Kurulum Anahtarı</label>
							<input
								id="bootstrap-token-input"
								type="password"
								className="input-field"
								value={bootstrapToken}
								onChange={(e) => setBootstrapToken(e.target.value)}
								placeholder="BOOTSTRAP_TOKEN"
								autoComplete="off"
								disabled={isAuthorizing}
								data-testid="bootstrap-token-input"
							/>
						</div>

						<div className="form-group">
							<label htmlFor="display-name-input">Kullanıcı Adı</label>
							<input
								id="display-name-input"
								type="text"
								className="input-field"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder="Örn: Eren"
								disabled={isAuthorizing}
								data-testid="display-name-input"
							/>
						</div>

						<div className="auth-actions">
							<button
								type="submit"
								className="btn btn-primary"
								disabled={isAuthorizing}
								data-testid="authorize-bootstrap-button"
							>
								{isAuthorizing ? "Doğrulanıyor..." : "Devam Et"}
							</button>
						</div>
					</form>
				) : (
					<form
						onSubmit={(e) => void handleRegisterPasskey(e)}
						className="auth-form"
					>
						<div className="form-group">
							<label htmlFor="device-name-input">Cihaz Adı</label>
							<input
								id="device-name-input"
								type="text"
								className="input-field"
								value={deviceName}
								onChange={(e) => setDeviceName(e.target.value)}
								placeholder="Örn: Bu cihaz"
								data-testid="device-name-input"
							/>
						</div>

						<div className="auth-actions">
							<button
								type="submit"
								className="btn btn-primary"
								data-testid="register-passkey-button"
							>
								Passkey Oluştur
							</button>
						</div>
					</form>
				)}
			</div>
		</main>
	);
}

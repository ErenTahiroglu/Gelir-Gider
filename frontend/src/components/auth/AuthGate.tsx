import type React from "react";
import { useAuth } from "../../auth/auth-context";
import { BootstrapEnrollment } from "./BootstrapEnrollment";
import { LockedOverlay } from "./LockedOverlay";
import { PrivacyShield } from "./PrivacyShield";
import { RecoveryCodePanel } from "./RecoveryCodePanel";
import { RecoveryFlow } from "./RecoveryFlow";
import { UnlockScreen } from "./UnlockScreen";

export function AuthGate({ children }: { children: React.ReactNode }) {
	const { state, retryBootstrapOrInit } = useAuth();

	if (state.status === "BOOTING") {
		return (
			<div
				className="app-booting-shell"
				role="status"
				aria-label="Yükleniyor"
				data-testid="booting-shell"
			>
				<div className="booting-spinner" aria-hidden="true" />
				<span className="booting-text">Gelir-Gider başlatılıyor...</span>
			</div>
		);
	}

	if (state.status === "FATAL_AUTH_STATE") {
		return (
			<main className="auth-surface" data-testid="fatal-auth-screen">
				<div className="auth-card">
					<header className="auth-header">
						<h1 className="auth-title">Bağlantı Hatası</h1>
						<p className="auth-subtitle">Güvenlik durumu doğrulanamadı.</p>
					</header>
					<div className="auth-alert" role="alert">
						{state.error}
					</div>
					<div className="auth-actions">
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => void retryBootstrapOrInit()}
							data-testid="retry-init-button"
						>
							Yeniden Dene
						</button>
					</div>
				</div>
			</main>
		);
	}

	if (
		state.status === "BOOTSTRAP_REQUIRED" ||
		state.status === "BOOTSTRAP_AUTHORIZING" ||
		state.status === "ENROLLING"
	) {
		return <BootstrapEnrollment />;
	}

	if (state.status === "RECOVERY_CODE_REQUIRED") {
		return <RecoveryCodePanel />;
	}

	if (state.status === "RECOVERY_REQUIRED" || state.status === "RECOVERING") {
		return <RecoveryFlow />;
	}

	if (state.status === "AUTH_REQUIRED" || state.status === "AUTHENTICATING") {
		return <UnlockScreen />;
	}

	// Unlocked or background locked
	const isPrivacyHidden = state.status === "PRIVACY_HIDDEN";
	const isReauthLocked =
		state.status === "REAUTH_REQUIRED" || state.status === "REAUTHENTICATING";

	return (
		<div className="protected-container" data-testid="protected-container">
			<div
				className="protected-content"
				inert={isReauthLocked ? true : undefined}
				aria-hidden={isPrivacyHidden || isReauthLocked}
			>
				{children}
			</div>

			{isPrivacyHidden && <PrivacyShield />}
			{isReauthLocked && <LockedOverlay />}
		</div>
	);
}

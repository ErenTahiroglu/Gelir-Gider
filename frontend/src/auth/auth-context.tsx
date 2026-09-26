import type React from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { onSessionLost } from "../api/client";
import { ApiError } from "../api/errors";
import * as authApi from "./auth-api";
import type { AuthState } from "./auth-types";
import { setupVisibilityLock } from "./visibility-lock";
import { getWebAuthnAdapter } from "./webauthn-client";

export interface AuthContextValue {
	state: AuthState;
	authenticateWithPasskey: () => Promise<void>;
	reauthenticateWithPasskey: () => Promise<void>;
	submitBootstrap: (token: string, displayName: string) => Promise<void>;
	submitEnrollment: (deviceName: string) => Promise<void>;
	acknowledgeRecoveryCode: () => Promise<void>;
	startRecoveryFlow: () => void;
	cancelRecoveryFlow: () => void;
	submitRecoveryCode: (recoveryCode: string) => Promise<void>;
	logout: () => Promise<void>;
	retryBootstrapOrInit: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
	const [state, setState] = useState<AuthState>({ status: "BOOTING" });

	// Use refs to track current user and state without stale closure in event callbacks
	const stateRef = useRef<AuthState>(state);
	stateRef.current = state;

	const currentUserRef = useRef<{ displayName: string } | null>(null);

	const initAuth = useCallback(async () => {
		setState({ status: "BOOTING" });
		try {
			const statusRes = await authApi.fetchAuthStatus();

			if (statusRes.state === "UNINITIALIZED") {
				setState({ status: "BOOTSTRAP_REQUIRED" });
				return;
			}

			if (statusRes.state === "INITIALIZED") {
				try {
					const sessionRes = await authApi.fetchAuthSession();
					if (sessionRes.authenticated && sessionRes.user) {
						currentUserRef.current = {
							displayName: sessionRes.user.displayName,
						};
						setState({
							status: "UNLOCKED",
							user: { displayName: sessionRes.user.displayName },
						});
					} else {
						setState({ status: "AUTH_REQUIRED" });
					}
				} catch (sessionErr) {
					if (sessionErr instanceof ApiError && sessionErr.status === 401) {
						setState({ status: "AUTH_REQUIRED" });
					} else {
						setState({
							status: "AUTH_REQUIRED",
							error:
								sessionErr instanceof ApiError
									? sessionErr.userMessage
									: "Oturum doğrulanamadı.",
						});
					}
				}
				return;
			}

			// Unknown state
			setState({
				status: "FATAL_AUTH_STATE",
				error: "Bilinmeyen kimlik doğrulama durumu.",
			});
		} catch (err) {
			setState({
				status: "FATAL_AUTH_STATE",
				error:
					err instanceof ApiError
						? err.userMessage
						: "Sistem durumu alınamadı. Lütfen daha sonra tekrar deneyin.",
			});
		}
	}, []);

	useEffect(() => {
		void initAuth();
	}, [initAuth]);

	// Register 401 session-loss listener
	useEffect(() => {
		return onSessionLost(() => {
			const current = stateRef.current;
			if (
				current.status === "UNLOCKED" ||
				current.status === "PRIVACY_HIDDEN" ||
				current.status === "REAUTH_REQUIRED" ||
				current.status === "REAUTHENTICATING"
			) {
				currentUserRef.current = null;
				setState({
					status: "AUTH_REQUIRED",
					error: "Oturumunuz sona erdi. Lütfen tekrar giriş yapın.",
				});
			}
		});
	}, []);

	// Register visibility lock listener
	useEffect(() => {
		const isUnlocked = () => stateRef.current.status === "UNLOCKED";

		const cleanup = setupVisibilityLock(
			{
				onHide: (hiddenAt) => {
					const current = stateRef.current;
					if (current.status === "UNLOCKED") {
						setState({
							status: "PRIVACY_HIDDEN",
							user: current.user,
							hiddenAt,
						});
					}
				},
				onRestoreUnlocked: () => {
					const current = stateRef.current;
					if (current.status === "PRIVACY_HIDDEN") {
						setState({
							status: "UNLOCKED",
							user: current.user,
						});
					}
				},
				onRequireReauth: () => {
					const current = stateRef.current;
					if (
						current.status === "PRIVACY_HIDDEN" ||
						current.status === "UNLOCKED"
					) {
						const user =
							current.status === "PRIVACY_HIDDEN" ||
							current.status === "UNLOCKED"
								? current.user
								: (currentUserRef.current ?? { displayName: "Kullanıcı" });
						setState({
							status: "REAUTH_REQUIRED",
							user,
						});
					}
				},
			},
			isUnlocked,
		);

		return cleanup;
	}, []);

	const authenticateWithPasskey = useCallback(async () => {
		setState({ status: "AUTHENTICATING" });
		try {
			const options = await authApi.fetchAuthenticationOptions();
			const adapter = getWebAuthnAdapter();
			const assertion = await adapter.authenticate(options);
			const verifyRes = await authApi.verifyAuthentication({
				response: assertion,
			});

			const user = { displayName: verifyRes.user.displayName };
			currentUserRef.current = user;
			setState({ status: "UNLOCKED", user });
		} catch (err) {
			const userMessage =
				err instanceof ApiError
					? err.userMessage
					: "Passkey doğrulaması yapılamadı.";
			setState({ status: "AUTH_REQUIRED", error: userMessage });
		}
	}, []);

	const reauthenticateWithPasskey = useCallback(async () => {
		const currentUser =
			currentUserRef.current ??
			(stateRef.current.status === "REAUTH_REQUIRED" ||
			stateRef.current.status === "REAUTHENTICATING"
				? stateRef.current.user
				: { displayName: "Kullanıcı" });

		setState({ status: "REAUTHENTICATING", user: currentUser });
		try {
			const options = await authApi.fetchReauthOptions();
			const adapter = getWebAuthnAdapter();
			const assertion = await adapter.authenticate(options);
			await authApi.verifyReauth({ response: assertion });

			// Reauth succeeded! Return to UNLOCKED without modifying session cookie.
			setState({ status: "UNLOCKED", user: currentUser });
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				// Existing session expired while locked: abandon reauth and fallback to cold auth
				currentUserRef.current = null;
				setState({
					status: "AUTH_REQUIRED",
					error:
						"Oturum süreniz doldu. Lütfen tekrar tam kimlik doğrulaması yapın.",
				});
				return;
			}

			const userMessage =
				err instanceof ApiError
					? err.userMessage
					: "Yeniden doğrulama tamamlanamadı.";
			setState({
				status: "REAUTH_REQUIRED",
				user: currentUser,
				error: userMessage,
			});
		}
	}, []);

	const submitBootstrap = useCallback(
		async (bootstrapToken: string, displayName: string) => {
			setState({ status: "BOOTSTRAP_AUTHORIZING" });
			try {
				const res = await authApi.authorizeBootstrap({
					bootstrapToken,
					displayName,
				});
				setState({
					status: "ENROLLING",
					grantToken: res.enrollmentGrantToken,
					displayName,
				});
			} catch (err) {
				const userMessage =
					err instanceof ApiError
						? err.userMessage
						: "Kurulum yetkilendirmesi başarısız oldu.";
				setState({ status: "BOOTSTRAP_REQUIRED", error: userMessage });
			}
		},
		[],
	);

	const submitRecoveryCode = useCallback(async (recoveryCode: string) => {
		setState({ status: "RECOVERING" });
		try {
			const res = await authApi.authorizeRecovery({ recoveryCode });
			setState({
				status: "ENROLLING",
				grantToken: res.enrollmentGrantToken,
				displayName: "Kullanıcı",
			});
		} catch (err) {
			const userMessage =
				err instanceof ApiError
					? err.userMessage
					: "Kurtarma kodu doğrulanamadı.";
			setState({ status: "RECOVERY_REQUIRED", error: userMessage });
		}
	}, []);

	const submitEnrollment = useCallback(async (deviceName: string) => {
		const current = stateRef.current;
		if (current.status !== "ENROLLING") return;

		const { grantToken, displayName } = current;

		try {
			const options = await authApi.fetchEnrollmentOptions(grantToken);
			const adapter = getWebAuthnAdapter();
			const registration = await adapter.register(options);
			const verifyRes = await authApi.verifyEnrollment({
				response: registration,
				deviceName,
			});

			currentUserRef.current = { displayName };

			setState({
				status: "RECOVERY_CODE_REQUIRED",
				recoveryCode: verifyRes.recoveryCode,
				warning: verifyRes.warning?.message,
				authenticatedAfterEnroll: verifyRes.authenticated,
			});
		} catch (err) {
			const userMessage =
				err instanceof ApiError ? err.userMessage : "Passkey kaydı yapılamadı.";
			setState({
				status: "ENROLLING",
				grantToken,
				displayName,
				error: userMessage,
			});
		}
	}, []);

	const acknowledgeRecoveryCode = useCallback(async () => {
		const current = stateRef.current;
		if (current.status !== "RECOVERY_CODE_REQUIRED") return;

		if (current.authenticatedAfterEnroll) {
			const user = currentUserRef.current ?? { displayName: "Kullanıcı" };
			setState({ status: "UNLOCKED", user });
		} else {
			// Session establishment failed case: proceed to normal login
			setState({
				status: "AUTH_REQUIRED",
				error:
					"Passkey başarıyla kaydedildi. Devam etmek için lütfen giriş yapın.",
			});
		}
	}, []);

	const startRecoveryFlow = useCallback(() => {
		setState({ status: "RECOVERY_REQUIRED" });
	}, []);

	const cancelRecoveryFlow = useCallback(() => {
		setState({ status: "AUTH_REQUIRED" });
	}, []);

	const logout = useCallback(async () => {
		try {
			await authApi.logout();
		} catch (err) {
			// Even if logout fails on server, clear client memory
			console.error("Logout error:", err);
		} finally {
			currentUserRef.current = null;
			setState({ status: "AUTH_REQUIRED" });
		}
	}, []);

	const retryBootstrapOrInit = useCallback(async () => {
		await initAuth();
	}, [initAuth]);

	return (
		<AuthContext.Provider
			value={{
				state,
				authenticateWithPasskey,
				reauthenticateWithPasskey,
				submitBootstrap,
				submitEnrollment,
				acknowledgeRecoveryCode,
				startRecoveryFlow,
				cancelRecoveryFlow,
				submitRecoveryCode,
				logout,
				retryBootstrapOrInit,
			}}
		>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth(): AuthContextValue {
	const context = useContext(AuthContext);
	if (!context) {
		throw new Error("useAuth must be used within an AuthProvider");
	}
	return context;
}

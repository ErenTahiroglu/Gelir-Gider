import {
	browserSupportsWebAuthn,
	startAuthentication,
	startRegistration,
} from "@simplewebauthn/browser";
import { ApiError } from "../api/errors";
import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON,
} from "./auth-types";

export interface BrowserWebAuthnClient {
	startAuthentication: (params: {
		optionsJSON: PublicKeyCredentialRequestOptionsJSON;
	}) => Promise<AuthenticationResponseJSON>;
	startRegistration: (params: {
		optionsJSON: PublicKeyCredentialCreationOptionsJSON;
	}) => Promise<RegistrationResponseJSON>;
}

let activeBrowserClient: BrowserWebAuthnClient = {
	startAuthentication,
	startRegistration,
};

export function setBrowserWebAuthnClient(client: BrowserWebAuthnClient): void {
	activeBrowserClient = client;
}

export function resetBrowserWebAuthnClient(): void {
	activeBrowserClient = {
		startAuthentication,
		startRegistration,
	};
}

export interface WebAuthnAdapter {
	isSupported(): boolean;
	authenticate(
		options: PublicKeyCredentialRequestOptionsJSON,
	): Promise<AuthenticationResponseJSON>;
	register(
		options: PublicKeyCredentialCreationOptionsJSON,
	): Promise<RegistrationResponseJSON>;
}

export const defaultWebAuthnAdapter: WebAuthnAdapter = {
	isSupported(): boolean {
		try {
			return browserSupportsWebAuthn();
		} catch {
			return false;
		}
	},

	async authenticate(
		options: PublicKeyCredentialRequestOptionsJSON,
	): Promise<AuthenticationResponseJSON> {
		if (!this.isSupported()) {
			throw new ApiError({
				status: 0,
				code: "WEBAUTHN_NOT_SUPPORTED",
				message: "Bu cihaz veya tarayıcı Passkey doğrulamasını desteklemiyor.",
			});
		}

		try {
			return await activeBrowserClient.startAuthentication({
				optionsJSON: options,
			});
		} catch (err: unknown) {
			if (err instanceof ApiError) {
				throw err;
			}

			if (
				err instanceof Error &&
				(err.name === "NotAllowedError" ||
					err.name === "AbortError" ||
					err.message.toLowerCase().includes("cancelled") ||
					err.message.toLowerCase().includes("abort") ||
					err.message.toLowerCase().includes("not allowed"))
			) {
				throw new ApiError({
					status: 0,
					code: "WEBAUTHN_CANCELLED",
					message: "Passkey doğrulaması tamamlanmadı. Tekrar deneyebilirsiniz.",
				});
			}

			throw new ApiError({
				status: 0,
				code: "WEBAUTHN_AUTHENTICATION_FAILED",
				message:
					err instanceof Error
						? err.message
						: "Passkey doğrulaması başarısız oldu.",
			});
		}
	},

	async register(
		options: PublicKeyCredentialCreationOptionsJSON,
	): Promise<RegistrationResponseJSON> {
		if (!this.isSupported()) {
			throw new ApiError({
				status: 0,
				code: "WEBAUTHN_NOT_SUPPORTED",
				message: "Bu cihaz veya tarayıcı Passkey doğrulamasını desteklemiyor.",
			});
		}

		try {
			return await activeBrowserClient.startRegistration({
				optionsJSON: options,
			});
		} catch (err: unknown) {
			if (err instanceof ApiError) {
				throw err;
			}

			if (
				err instanceof Error &&
				(err.name === "NotAllowedError" ||
					err.name === "AbortError" ||
					err.message.toLowerCase().includes("cancelled") ||
					err.message.toLowerCase().includes("abort") ||
					err.message.toLowerCase().includes("not allowed"))
			) {
				throw new ApiError({
					status: 0,
					code: "WEBAUTHN_CANCELLED",
					message: "Passkey kaydı tamamlanmadı. Tekrar deneyebilirsiniz.",
				});
			}

			throw new ApiError({
				status: 0,
				code: "WEBAUTHN_REGISTRATION_FAILED",
				message:
					err instanceof Error ? err.message : "Passkey kaydı başarısız oldu.",
			});
		}
	},
};

let activeAdapter: WebAuthnAdapter = defaultWebAuthnAdapter;

export function getWebAuthnAdapter(): WebAuthnAdapter {
	return activeAdapter;
}

export function setWebAuthnAdapter(adapter: WebAuthnAdapter): void {
	activeAdapter = adapter;
}

export function resetWebAuthnAdapter(): void {
	activeAdapter = defaultWebAuthnAdapter;
	resetBrowserWebAuthnClient();
}

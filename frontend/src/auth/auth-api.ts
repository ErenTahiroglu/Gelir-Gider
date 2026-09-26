import { apiFetch } from "../api/client";
import type {
	AuthenticationVerifyRequest,
	AuthenticationVerifyResponse,
	AuthSessionResponse,
	AuthStatusResponse,
	BootstrapAuthorizeRequest,
	BootstrapAuthorizeResponse,
	EnrollmentVerifyRequest,
	EnrollmentVerifyResponse,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	ReauthVerifyRequest,
	ReauthVerifyResponse,
	RecoveryAuthorizeRequest,
	RecoveryAuthorizeResponse,
} from "./auth-types";

export async function fetchAuthStatus(): Promise<AuthStatusResponse> {
	return apiFetch<AuthStatusResponse>("/auth/status", { method: "GET" });
}

export async function fetchAuthSession(): Promise<AuthSessionResponse> {
	return apiFetch<AuthSessionResponse>("/auth/session", { method: "GET" });
}

export async function authorizeBootstrap(
	data: BootstrapAuthorizeRequest,
): Promise<BootstrapAuthorizeResponse> {
	return apiFetch<BootstrapAuthorizeResponse>("/auth/bootstrap/authorize", {
		method: "POST",
		json: data,
	});
}

export async function authorizeRecovery(
	data: RecoveryAuthorizeRequest,
): Promise<RecoveryAuthorizeResponse> {
	return apiFetch<RecoveryAuthorizeResponse>("/auth/recovery/authorize", {
		method: "POST",
		json: data,
	});
}

export async function fetchEnrollmentOptions(
	enrollmentGrantToken: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	return apiFetch<PublicKeyCredentialCreationOptionsJSON>(
		"/auth/passkey/enrollment/options",
		{
			method: "POST",
			json: { enrollmentGrantToken },
		},
	);
}

export async function verifyEnrollment(
	data: EnrollmentVerifyRequest,
): Promise<EnrollmentVerifyResponse> {
	return apiFetch<EnrollmentVerifyResponse>("/auth/passkey/enrollment/verify", {
		method: "POST",
		json: data,
	});
}

export async function fetchAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
	return apiFetch<PublicKeyCredentialRequestOptionsJSON>(
		"/auth/passkey/authentication/options",
		{
			method: "POST",
		},
	);
}

export async function verifyAuthentication(
	data: AuthenticationVerifyRequest,
): Promise<AuthenticationVerifyResponse> {
	return apiFetch<AuthenticationVerifyResponse>(
		"/auth/passkey/authentication/verify",
		{
			method: "POST",
			json: data,
		},
	);
}

export async function fetchReauthOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
	return apiFetch<PublicKeyCredentialRequestOptionsJSON>(
		"/auth/passkey/reauth/options",
		{
			method: "POST",
		},
	);
}

export async function verifyReauth(
	data: ReauthVerifyRequest,
): Promise<ReauthVerifyResponse> {
	return apiFetch<ReauthVerifyResponse>("/auth/passkey/reauth/verify", {
		method: "POST",
		json: data,
	});
}

export async function logout(): Promise<void> {
	return apiFetch<void>("/auth/logout", {
		method: "POST",
	});
}

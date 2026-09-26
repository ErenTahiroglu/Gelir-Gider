import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/browser";

// --- DTOs matching exact backend contracts ---

export interface AuthStatusResponse {
	state: "INITIALIZED" | "UNINITIALIZED";
}

export interface AuthSessionResponse {
	authenticated: boolean;
	user: {
		displayName: string;
	};
}

export interface BootstrapAuthorizeRequest {
	bootstrapToken: string;
	displayName: string;
}

export interface BootstrapAuthorizeResponse {
	enrollmentGrantToken: string;
}

export interface RecoveryAuthorizeRequest {
	recoveryCode: string;
}

export interface RecoveryAuthorizeResponse {
	enrollmentGrantToken: string;
}

export interface EnrollmentVerifyRequest {
	response: RegistrationResponseJSON;
	deviceName: string;
}

export interface EnrollmentVerifyResponse {
	verified: boolean;
	purpose: string;
	credential: {
		deviceName: string;
	};
	recoveryCode: string;
	authenticated: boolean;
	warning?: {
		code: string;
		message: string;
	};
}

export interface AuthenticationVerifyRequest {
	response: AuthenticationResponseJSON;
}

export interface AuthenticationVerifyResponse {
	authenticated: boolean;
	user: {
		displayName: string;
	};
}

export interface ReauthVerifyRequest {
	response: AuthenticationResponseJSON;
}

export interface ReauthVerifyResponse {
	verified: boolean;
	credential: {
		deviceName: string;
	};
}

// --- Frontend Auth State Machine ---

export type AuthState =
	| { status: "BOOTING" }
	| { status: "BOOTSTRAP_REQUIRED"; error?: string | undefined }
	| { status: "BOOTSTRAP_AUTHORIZING" }
	| {
			status: "ENROLLING";
			grantToken: string;
			displayName: string;
			error?: string | undefined;
	  }
	| {
			status: "RECOVERY_CODE_REQUIRED";
			recoveryCode: string;
			warning?: string | undefined;
			authenticatedAfterEnroll: boolean;
	  }
	| { status: "AUTH_REQUIRED"; error?: string | undefined }
	| { status: "AUTHENTICATING" }
	| { status: "RECOVERY_REQUIRED"; error?: string | undefined }
	| { status: "RECOVERING" }
	| { status: "UNLOCKED"; user: { displayName: string } }
	| {
			status: "PRIVACY_HIDDEN";
			user: { displayName: string };
			hiddenAt: number;
	  }
	| {
			status: "REAUTH_REQUIRED";
			user: { displayName: string };
			error?: string | undefined;
	  }
	| { status: "REAUTHENTICATING"; user: { displayName: string } }
	| { status: "FATAL_AUTH_STATE"; error: string };

export type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON,
};

import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { webauthnCredentials } from "../db/schema/auth";

export interface ActiveCredentialRecord {
	id: string;
	userId: string;
	credentialId: string;
	publicKey: Uint8Array;
	signCount: number;
	deviceName: string;
	deviceType: string | null;
	transports: AuthenticatorTransportFuture[] | null;
	backedUp: boolean;
	stateVersion: number;
	createdAt: Date;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
}

export interface FindActiveCredentialParams {
	db: Database;
	userId: string;
	credentialId: string;
}

export async function findActiveCredential({
	db,
	userId,
	credentialId,
}: FindActiveCredentialParams): Promise<ActiveCredentialRecord | null> {
	const [record] = await db
		.select()
		.from(webauthnCredentials)
		.where(
			and(
				eq(webauthnCredentials.userId, userId),
				eq(webauthnCredentials.credentialId, credentialId),
				isNull(webauthnCredentials.revokedAt),
			),
		)
		.limit(1);

	if (!record) {
		return null;
	}

	return {
		...record,
		transports: (record.transports as AuthenticatorTransportFuture[]) ?? null,
		publicKey: new Uint8Array(record.publicKey),
	};
}

export interface CreateCredentialParams {
	db: Database;
	userId: string;
	credentialId: string;
	publicKey: Uint8Array;
	signCount: number;
	deviceName: string;
	deviceType: string | null;
	transports?: AuthenticatorTransportFuture[] | null | undefined;
	backedUp: boolean;
}

export async function createCredential({
	db,
	userId,
	credentialId,
	publicKey,
	signCount,
	deviceName,
	deviceType,
	transports,
	backedUp,
}: CreateCredentialParams) {
	const [created] = await db
		.insert(webauthnCredentials)
		.values({
			userId,
			credentialId,
			publicKey: new Uint8Array(publicKey),
			signCount,
			deviceName,
			deviceType,
			transports: transports && transports.length > 0 ? transports : null,
			backedUp,
		})
		.returning();

	return created;
}

export interface UpdateCredentialAfterAuthenticationParams {
	db: Database;
	credentialDbId: string;
	userId: string;
	previouslyReadCounter: number;
	previousStateVersion: number;
	newCounter: number;
}

export async function updateCredentialAfterAuthentication({
	db,
	credentialDbId,
	userId,
	previouslyReadCounter,
	previousStateVersion,
	newCounter,
}: UpdateCredentialAfterAuthenticationParams) {
	const now = new Date();

	// Atomic update using state_version optimistic concurrency token and atomic DB increment
	const [updated] = await db
		.update(webauthnCredentials)
		.set({
			signCount: newCounter,
			lastUsedAt: now,
			stateVersion: sql`${webauthnCredentials.stateVersion} + 1`,
		})
		.where(
			and(
				eq(webauthnCredentials.id, credentialDbId),
				eq(webauthnCredentials.userId, userId),
				isNull(webauthnCredentials.revokedAt),
				eq(webauthnCredentials.stateVersion, previousStateVersion),
				eq(webauthnCredentials.signCount, previouslyReadCounter),
			),
		)
		.returning();

	return updated ?? null;
}

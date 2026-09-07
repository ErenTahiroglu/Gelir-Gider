import { describe, expect, it } from "vitest";
import {
	BACKUP_ENVELOPE_FORMAT_VERSION,
	BACKUP_ENVELOPE_MAGIC,
	decryptBackupPayload,
	encryptBackupPayload,
	envelopeKeyIdMatches,
} from "../src/backups/crypto";
import { BackupError } from "../src/backups/errors";

function makeKey(seed: number): Uint8Array {
	const key = new Uint8Array(32);
	for (let i = 0; i < 32; i++) key[i] = (seed + i) % 256;
	return key;
}

const KEY_A = makeKey(1);
const KEY_B = makeKey(99);

const BASE_PARAMS = {
	backupId: "20260907",
	createdAt: "2026-09-07T02:17:00.000Z",
	key: KEY_A,
	keyId: "v1",
};

describe("Backup crypto (GG_BACKUP_V1 envelope)", () => {
	it("round-trips encrypt/decrypt with an exact plaintext match", async () => {
		const plaintext = JSON.stringify({ hello: "world", n: 42 });
		const envelope = await encryptBackupPayload({ ...BASE_PARAMS, plaintext });
		const decrypted = await decryptBackupPayload({ envelope, key: KEY_A });
		expect(new TextDecoder().decode(decrypted)).toBe(plaintext);
	});

	it("produces different ciphertext for the same plaintext on repeated calls (random IV)", async () => {
		const plaintext = "same plaintext every time";
		const envelope1 = await encryptBackupPayload({ ...BASE_PARAMS, plaintext });
		const envelope2 = await encryptBackupPayload({ ...BASE_PARAMS, plaintext });
		expect(envelope1.ciphertextBase64).not.toBe(envelope2.ciphertextBase64);
		expect(envelope1.ivBase64).not.toBe(envelope2.ivBase64);
	});

	it("carries the expected envelope header fields", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "x",
		});
		expect(envelope.magic).toBe(BACKUP_ENVELOPE_MAGIC);
		expect(envelope.formatVersion).toBe(BACKUP_ENVELOPE_FORMAT_VERSION);
		expect(envelope.backupId).toBe(BASE_PARAMS.backupId);
		expect(envelope.createdAt).toBe(BASE_PARAMS.createdAt);
		expect(envelope.keyId).toBe(BASE_PARAMS.keyId);
		expect(envelope.ciphertextSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("rejects decryption when a single bit of ciphertext is mutated", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "tamper me",
		});
		const bytes = Uint8Array.from(atob(envelope.ciphertextBase64), (c) =>
			c.charCodeAt(0),
		);
		bytes[0] = (bytes[0] ?? 0) ^ 0x01;
		let tamperedBinary = "";
		for (const b of bytes) tamperedBinary += String.fromCharCode(b);
		const tampered = { ...envelope, ciphertextBase64: btoa(tamperedBinary) };

		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("rejects decryption when an AAD-bound header field (backupId) is mutated", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "aad test",
		});
		const tampered = { ...envelope, backupId: "20991231" };
		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("rejects decryption when the IV is mutated", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "iv test",
		});
		const bytes = Uint8Array.from(atob(envelope.ivBase64), (c) =>
			c.charCodeAt(0),
		);
		bytes[0] = (bytes[0] ?? 0) ^ 0xff;
		let binary = "";
		for (const b of bytes) binary += String.fromCharCode(b);
		const tampered = { ...envelope, ivBase64: btoa(binary) };

		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("rejects decryption with the wrong key", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "wrong key test",
		});
		await expect(
			decryptBackupPayload({ envelope, key: KEY_B }),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("rejects an envelope with an unrecognized magic value", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "x",
		});
		const tampered = {
			...envelope,
			magic: "NOT_GG_BACKUP",
		} as unknown as typeof envelope;
		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toMatchObject({ code: "BACKUP_INVALID_ENVELOPE" });
	});

	it("rejects an envelope with an unrecognized format version", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "x",
		});
		const tampered = {
			...envelope,
			formatVersion: "V2",
		} as unknown as typeof envelope;
		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toMatchObject({ code: "BACKUP_INVALID_ENVELOPE" });
	});

	it("rejects a malformed envelope missing required fields", async () => {
		await expect(
			decryptBackupPayload({
				envelope: { magic: BACKUP_ENVELOPE_MAGIC } as never,
				key: KEY_A,
			}),
		).rejects.toMatchObject({ code: "BACKUP_INVALID_ENVELOPE" });
	});

	it("exposes envelope keyId for a pre-decrypt comparison against an operator's expected keyId", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "x",
			keyId: "v2",
		});
		expect(envelopeKeyIdMatches(envelope, "v2")).toBe(true);
		expect(envelopeKeyIdMatches(envelope, "v1")).toBe(false);
	});
});

describe("Backup crypto envelope hardening (Phase 18-R1 Section E)", () => {
	it("rejects decryption when keyId is tampered post-encryption (now AAD-bound)", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "keyid aad test",
		});
		const tampered = { ...envelope, keyId: "v-attacker" };
		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("rejects decryption when algorithm is tampered to an unrecognized value (both shape-check AND AAD now reject it)", async () => {
		// `algorithm` currently only ever has one valid value, so
		// `assertEnvelopeShape`'s existing "algorithm not supported" check
		// already rejects ANY tampered value before AAD verification is even
		// reached -- the AAD binding added in this phase is defense-in-depth
		// for a future multi-algorithm world, not independently observable
		// with today's single-algorithm shape check. This test documents that
		// tampering the field is rejected either way.
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "algorithm aad test",
		});
		const tampered = {
			...envelope,
			algorithm: "AES-128-GCM",
		} as unknown as typeof envelope;
		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toMatchObject({ code: "BACKUP_INVALID_ENVELOPE" });
	});

	it("rejects an envelope with an IV that does not decode to exactly 12 bytes", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "iv length test",
		});
		const shortIv = btoa("short"); // 5 raw bytes, not 12
		const tampered = { ...envelope, ivBase64: shortIv };
		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toMatchObject({ code: "BACKUP_INVALID_ENVELOPE" });
	});

	it("rejects an envelope with an empty keyId", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "x",
		});
		const tampered = { ...envelope, keyId: "" };
		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toMatchObject({ code: "BACKUP_INVALID_ENVELOPE" });
	});

	it("rejects an envelope with a keyId exceeding the maximum allowed length", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "x",
		});
		const tampered = { ...envelope, keyId: "v".repeat(65) };
		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toMatchObject({ code: "BACKUP_INVALID_ENVELOPE" });
	});

	it("rejects an envelope with an invalid createdAt timestamp", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "x",
		});
		const tampered = { ...envelope, createdAt: "not-a-real-timestamp" };
		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toMatchObject({ code: "BACKUP_INVALID_ENVELOPE" });
	});

	it("rejects an envelope with a malformed backupId (not an 8-digit YYYYMMDD)", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "x",
		});
		const tampered = { ...envelope, backupId: "2026-09-07" };
		await expect(
			decryptBackupPayload({ envelope: tampered, key: KEY_A }),
		).rejects.toMatchObject({ code: "BACKUP_INVALID_ENVELOPE" });
	});

	it("rejects an envelope carrying an extra, unexpected top-level key", async () => {
		const envelope = await encryptBackupPayload({
			...BASE_PARAMS,
			plaintext: "x",
		});
		const tampered = {
			...envelope,
			extraSmuggledField: "should not be allowed",
		};
		await expect(
			decryptBackupPayload({
				envelope: tampered as unknown as typeof envelope,
				key: KEY_A,
			}),
		).rejects.toMatchObject({ code: "BACKUP_INVALID_ENVELOPE" });
	});
});

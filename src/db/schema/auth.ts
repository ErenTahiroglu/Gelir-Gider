import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	customType,
	index,
	pgTable,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

// Custom bytea column definition for binary storage (WebAuthn public key) using standard web platform Uint8Array
const bytea = customType<{ data: Uint8Array }>({
	dataType() {
		return "bytea";
	},
});

export const users = pgTable(
	"users",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		singletonKey: boolean("singleton_key").default(true).notNull().unique(),
		displayName: text("display_name").notNull(),
		timezone: text("timezone").default("Europe/Istanbul").notNull(),
		currency: varchar("currency", { length: 3 }).default("TRY").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check("users_singleton_key_check", sql`${table.singletonKey} = true`),
	],
);

export const webauthnCredentials = pgTable(
	"webauthn_credentials",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		credentialId: text("credential_id").notNull().unique(),
		publicKey: bytea("public_key").notNull(),
		signCount: bigint("sign_count", { mode: "number" }).default(0).notNull(),
		deviceName: text("device_name").notNull(),
		deviceType: text("device_type"),
		transports: text("transports").array(),
		backedUp: boolean("backed_up").default(false).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
		revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [
		check(
			"webauthn_credentials_sign_count_check",
			sql`${table.signCount} >= 0`,
		),
		check(
			"webauthn_credentials_revoked_at_check",
			sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
		),
		index("webauthn_credentials_user_id_idx").on(table.userId),
	],
);

export const sessions = pgTable(
	"sessions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull().unique(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
		revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [
		check(
			"sessions_expires_at_check",
			sql`${table.expiresAt} > ${table.createdAt}`,
		),
		check(
			"sessions_revoked_at_check",
			sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
		),
		index("sessions_user_id_idx").on(table.userId),
		index("sessions_expires_at_idx").on(table.expiresAt),
	],
);

export const webauthnChallenges = pgTable(
	"webauthn_challenges",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		purpose: text("purpose").notNull(),
		challenge: text("challenge").notNull().unique(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [
		check(
			"webauthn_challenges_purpose_check",
			sql`${table.purpose} IN ('REGISTRATION', 'AUTHENTICATION')`,
		),
		check(
			"webauthn_challenges_expires_at_check",
			sql`${table.expiresAt} > ${table.createdAt}`,
		),
		check(
			"webauthn_challenges_consumed_at_check",
			sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`,
		),
		index("webauthn_challenges_user_purpose_idx").on(
			table.userId,
			table.purpose,
		),
		index("webauthn_challenges_expires_at_idx").on(table.expiresAt),
	],
);

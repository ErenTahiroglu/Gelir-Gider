ALTER TABLE "webauthn_credentials" ADD COLUMN "transports" text[];--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD COLUMN "backed_up" boolean DEFAULT false NOT NULL;
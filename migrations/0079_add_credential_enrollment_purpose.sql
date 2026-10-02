ALTER TABLE "auth_enrollment_grants" DROP CONSTRAINT "auth_enrollment_grants_purpose_check";
--> statement-breakpoint
ALTER TABLE "auth_enrollment_grants" ADD CONSTRAINT "auth_enrollment_grants_purpose_check" CHECK ("auth_enrollment_grants"."purpose" IN ('BOOTSTRAP', 'RECOVERY', 'ADD_CREDENTIAL'));
--> statement-breakpoint
ALTER TABLE "auth_enrollment_grants" DROP CONSTRAINT "auth_enrollment_grants_purpose_recovery_relation_check";
--> statement-breakpoint
ALTER TABLE "auth_enrollment_grants" ADD CONSTRAINT "auth_enrollment_grants_purpose_recovery_relation_check" CHECK (("auth_enrollment_grants"."purpose" IN ('BOOTSTRAP', 'ADD_CREDENTIAL') AND "auth_enrollment_grants"."recovery_code_id" IS NULL) OR ("auth_enrollment_grants"."purpose" = 'RECOVERY' AND "auth_enrollment_grants"."recovery_code_id" IS NOT NULL));

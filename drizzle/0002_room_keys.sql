ALTER TABLE "users" ADD COLUMN "room_keys" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "room_keys_updated_at" timestamp with time zone DEFAULT now() NOT NULL;
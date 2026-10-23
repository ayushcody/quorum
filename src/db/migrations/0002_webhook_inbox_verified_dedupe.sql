ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_paypal_event_id_unique";--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "transmission_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_verified_event" ON "webhook_events" USING btree ("paypal_event_id") WHERE "webhook_events"."verified";
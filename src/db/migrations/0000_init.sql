CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"round_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pledge_id" uuid NOT NULL,
	"paypal_authorization_id" text NOT NULL,
	"parent_authorization_id" uuid,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"status" text NOT NULL,
	"paypal_expires_at" timestamp with time zone NOT NULL,
	"honor_ends_at" timestamp with time zone NOT NULL,
	"paypal_capture_id" text,
	"captured_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorizations_paypal_authorization_id_unique" UNIQUE("paypal_authorization_id"),
	CONSTRAINT "authorizations_paypal_capture_id_unique" UNIQUE("paypal_capture_id"),
	CONSTRAINT "authorizations_status" CHECK ("authorizations"."status" in ('created', 'captured', 'voided', 'expired', 'denied', 'reauthorized')),
	CONSTRAINT "authorizations_currency" CHECK ("authorizations"."currency" = 'USD'),
	CONSTRAINT "authorizations_amount" CHECK ("authorizations"."amount_cents" > 0),
	CONSTRAINT "authorizations_captured_le_amount" CHECK ("authorizations"."captured_cents" is null or ("authorizations"."captured_cents" >= 0 and "authorizations"."captured_cents" <= "authorizations"."amount_cents"))
);
--> statement-breakpoint
CREATE TABLE "benchmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"query" text NOT NULL,
	"best_unit_price_cents" bigint NOT NULL,
	"retailer" text NOT NULL,
	"url" text NOT NULL,
	"raw" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benchmarks_price" CHECK ("benchmarks"."best_unit_price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "demo_signing_keys" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"private_key_jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"paypal_invoice_id" text,
	"invoice_amount_cents" bigint,
	"invoice_status" text,
	"payout_batch_id" text,
	"payout_item_id" text,
	"payout_status" text,
	"carrier" text,
	"tracking_number" text,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillments_round_id_unique" UNIQUE("round_id"),
	CONSTRAINT "fulfillments_paypal_invoice_id_unique" UNIQUE("paypal_invoice_id"),
	CONSTRAINT "fulfillments_payout_batch_id_unique" UNIQUE("payout_batch_id"),
	CONSTRAINT "fulfillments_payout_item_id_unique" UNIQUE("payout_item_id"),
	CONSTRAINT "fulfillments_invoice_amount" CHECK ("fulfillments"."invoice_amount_cents" is null or "fulfillments"."invoice_amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"max_unit_price_cents" bigint NOT NULL,
	"qty_min" integer NOT NULL,
	"qty_max" integer NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"canonical_json" text NOT NULL,
	"hash" char(64) NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandates_hash_unique" UNIQUE("hash"),
	CONSTRAINT "mandates_round_member" UNIQUE("round_id","member_id"),
	CONSTRAINT "mandates_max_price" CHECK ("mandates"."max_unit_price_cents" > 0),
	CONSTRAINT "mandates_qty" CHECK ("mandates"."qty_min" > 0 and "mandates"."qty_max" >= "mandates"."qty_min")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"business_name" text NOT NULL,
	"kind" text NOT NULL,
	"public_key_jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_kind" CHECK ("members"."kind" in ('human', 'bot'))
);
--> statement-breakpoint
CREATE TABLE "negotiation_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"side" text NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"qty" integer NOT NULL,
	"message" text NOT NULL,
	"intent" text,
	"policy_verdict" text,
	"verdict_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "negotiation_turns_round_seq" UNIQUE("round_id","seq"),
	CONSTRAINT "negotiation_turns_side" CHECK ("negotiation_turns"."side" in ('buyer', 'supplier')),
	CONSTRAINT "negotiation_turns_price" CHECK ("negotiation_turns"."unit_price_cents" > 0),
	CONSTRAINT "negotiation_turns_qty" CHECK ("negotiation_turns"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "paypal_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_key" text NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"round_id" uuid,
	"pledge_id" uuid,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"http_status" integer,
	"response" jsonb,
	"error_name" text,
	"paypal_debug_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_ops_business_key_unique" UNIQUE("business_key"),
	CONSTRAINT "paypal_ops_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "paypal_ops_kind" CHECK ("paypal_ops"."kind" in ('create_order', 'authorize_order', 'client_token', 'get_order', 'get_authorization', 'get_capture', 'capture', 'void', 'reauthorize', 'refund', 'payout', 'get_payout')),
	CONSTRAINT "paypal_ops_mode" CHECK ("paypal_ops"."mode" in ('inline', 'deferred')),
	CONSTRAINT "paypal_ops_status" CHECK ("paypal_ops"."status" in ('pending', 'in_flight', 'succeeded', 'failed_retryable', 'failed_terminal', 'unknown')),
	CONSTRAINT "paypal_ops_attempts" CHECK ("paypal_ops"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pledges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandate_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"funding" text NOT NULL,
	"status" text DEFAULT 'order_pending' NOT NULL,
	"paypal_order_id" text,
	"max_exposure_cents" bigint NOT NULL,
	"allocated_qty" integer,
	"capture_amount_cents" bigint,
	"released_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pledges_mandate_id_unique" UNIQUE("mandate_id"),
	CONSTRAINT "pledges_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "pledges_funding" CHECK ("pledges"."funding" in ('paypal_wallet', 'demo_card')),
	CONSTRAINT "pledges_status" CHECK ("pledges"."status" in ('order_pending', 'order_created', 'authorized', 'reauthorizing', 'capture_pending', 'captured', 'void_pending', 'voided', 'refund_pending', 'refunded', 'abandoned')),
	CONSTRAINT "pledges_max_exposure" CHECK ("pledges"."max_exposure_cents" > 0),
	CONSTRAINT "pledges_allocated_qty" CHECK ("pledges"."allocated_qty" is null or "pledges"."allocated_qty" >= 0),
	CONSTRAINT "pledges_capture_le_exposure" CHECK ("pledges"."capture_amount_cents" is null or ("pledges"."capture_amount_cents" >= 0 and "pledges"."capture_amount_cents" <= "pledges"."max_exposure_cents"))
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"sku" text NOT NULL,
	"unit" text NOT NULL,
	"target_qty" integer NOT NULL,
	"min_members" integer NOT NULL,
	"pledge_deadline_at" timestamp with time zone NOT NULL,
	"delivery_by" date NOT NULL,
	"supplier_ref" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"final_unit_price_cents" bigint,
	"benchmark_unit_price_cents" bigint,
	"benchmark_source" jsonb,
	"next_tick_at" timestamp with time zone,
	"negotiation_step" integer DEFAULT 0 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rounds_status" CHECK ("rounds"."status" in ('draft', 'open', 'locked', 'settling', 'settled', 'invoiced', 'paid_out', 'fulfilled', 'voiding', 'voided', 'unwinding', 'failed')),
	CONSTRAINT "rounds_target_qty" CHECK ("rounds"."target_qty" > 0),
	CONSTRAINT "rounds_min_members" CHECK ("rounds"."min_members" >= 2),
	CONSTRAINT "rounds_final_price" CHECK ("rounds"."final_unit_price_cents" is null or "rounds"."final_unit_price_cents" > 0),
	CONSTRAINT "rounds_benchmark_price" CHECK ("rounds"."benchmark_unit_price_cents" is null or "rounds"."benchmark_unit_price_cents" > 0),
	CONSTRAINT "rounds_negotiation_step" CHECK ("rounds"."negotiation_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paypal_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text,
	"payload" jsonb NOT NULL,
	"verified" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "webhook_events_paypal_event_id_unique" UNIQUE("paypal_event_id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_pledge_id_pledges_id_fk" FOREIGN KEY ("pledge_id") REFERENCES "public"."pledges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_parent_authorization_id_authorizations_id_fk" FOREIGN KEY ("parent_authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_signing_keys" ADD CONSTRAINT "demo_signing_keys_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiation_turns" ADD CONSTRAINT "negotiation_turns_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_ops" ADD CONSTRAINT "paypal_ops_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_ops" ADD CONSTRAINT "paypal_ops_pledge_id_pledges_id_fk" FOREIGN KEY ("pledge_id") REFERENCES "public"."pledges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_round" ON "audit_log" USING btree ("round_id","id");--> statement-breakpoint
CREATE INDEX "authorizations_pledge" ON "authorizations" USING btree ("pledge_id");--> statement-breakpoint
CREATE INDEX "authorizations_parent" ON "authorizations" USING btree ("parent_authorization_id");--> statement-breakpoint
CREATE INDEX "benchmarks_sku" ON "benchmarks" USING btree ("sku","fetched_at");--> statement-breakpoint
CREATE INDEX "mandates_member" ON "mandates" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "paypal_ops_due" ON "paypal_ops" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "paypal_ops_round" ON "paypal_ops" USING btree ("round_id");--> statement-breakpoint
CREATE INDEX "paypal_ops_pledge" ON "paypal_ops" USING btree ("pledge_id");--> statement-breakpoint
CREATE INDEX "pledges_round_status" ON "pledges" USING btree ("round_id","status");--> statement-breakpoint
CREATE INDEX "pledges_member" ON "pledges" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "rounds_status_next_tick" ON "rounds" USING btree ("status","next_tick_at");
CREATE TABLE "circles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"memberIds" text NOT NULL,
	CONSTRAINT "circles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "dues" (
	"id" serial PRIMARY KEY NOT NULL,
	"personId" integer NOT NULL,
	"amount" integer NOT NULL,
	"note" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"txnId" integer
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "people_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "txns" DROP COLUMN "splitwiseId";
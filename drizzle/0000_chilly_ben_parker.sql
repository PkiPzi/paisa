CREATE TABLE "bills" (
	"emailId" text PRIMARY KEY NOT NULL,
	"card" text NOT NULL,
	"amount" integer NOT NULL,
	"dueDate" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" text PRIMARY KEY NOT NULL,
	"sender" text NOT NULL,
	"subject" text NOT NULL,
	"receivedAt" timestamp with time zone NOT NULL,
	"body" text NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"key" text PRIMARY KEY NOT NULL,
	"category" text,
	"splitTarget" text,
	"splitLabel" text
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"emailId" text PRIMARY KEY NOT NULL,
	"merchant" text NOT NULL,
	"category" text NOT NULL,
	"amount" integer NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "txns" (
	"id" serial PRIMARY KEY NOT NULL,
	"emailId" text,
	"at" timestamp with time zone NOT NULL,
	"amount" integer NOT NULL,
	"direction" text NOT NULL,
	"account" text NOT NULL,
	"payee" text NOT NULL,
	"payeeKey" text NOT NULL,
	"category" text,
	"source" text,
	"myShare" integer,
	"splitwiseId" text,
	"splitWith" text,
	"tgMessageId" integer,
	CONSTRAINT "txns_emailId_unique" UNIQUE("emailId")
);

CREATE TABLE "holdings" (
	"isin" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"assetClass" text NOT NULL,
	"category" text NOT NULL,
	"symbol" text,
	"units" double precision NOT NULL,
	"invested" integer NOT NULL,
	"price" double precision,
	"priceAt" text,
	"importedAt" timestamp with time zone DEFAULT now() NOT NULL
);

-- Per-creator AI profile (persona/tone/SOP). Named agents are rows, not services.

CREATE TABLE IF NOT EXISTS ai_creator_profiles (
  "creatorId" UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  persona TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  languages TEXT[] NOT NULL DEFAULT '{}',
  biography TEXT NOT NULL DEFAULT '',
  "preferredTerminology" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "prohibitedClaims" TEXT[] NOT NULL DEFAULT '{}',
  "salesStyle" TEXT NOT NULL DEFAULT '',
  "platformRules" JSONB NOT NULL DEFAULT '{}'::jsonb,
  instructions TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  "updatedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

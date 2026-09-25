-- Postgres translation of the SQLite schema in app/lib/db.ts, including the
-- COLUMN_MIGRATIONS additive columns already folded in as native columns.
-- This is a schema only: no data migration, no application code change.
-- See deploy/postgres/README.md for the differences a real port must handle
-- and docs/DEPLOY.md Option C for the honest cost of switching the app to
-- use this. Not applied anywhere; written for review.

-- ---------------------------------------------------------------------
-- Multi-bank scaffolding (commented out, off by default). If this app is
-- ever resold to a second bank sharing one Postgres database, every table
-- gets a workspace_id column and row-level security policies keyed on it,
-- so one bank's rows are invisible to another bank's connection even if a
-- query forgets a WHERE clause. Left commented because the current app
-- has no concept of workspace_id yet; wiring it in is part of the Option C
-- rewrite, not a schema-only change.
-- ---------------------------------------------------------------------
-- CREATE TABLE workspaces (
--   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   name text NOT NULL,
--   created_at timestamptz NOT NULL DEFAULT now()
-- );
-- -- every table below would additionally get:
-- --   workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
-- -- and every table below would additionally run:
-- --   ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
-- --   CREATE POLICY <table>_isolation ON <table>
-- --     USING (workspace_id = current_setting('app.current_workspace_id')::uuid);
-- -- with the app setting app.current_workspace_id once per connection/session
-- -- right after authenticating the request, before running any query.

CREATE ROLE app_role NOLOGIN;
-- The actual application connects as a login role that is a MEMBER of
-- app_role (e.g. CREATE ROLE app_user LOGIN PASSWORD '...' IN ROLE app_role;),
-- so the REVOKE at the bottom of this file actually restricts what the
-- running app can do to audit_log.

CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','principal','member')),
  password_hash text NOT NULL,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  domain        text,
  segment_id    text NOT NULL DEFAULT 'owners',
  industry      text,
  city          text,
  state         text,
  employees     integer,
  revenue_band  text,
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','apollo','signal-engine','import')),
  signal_score  double precision NOT NULL DEFAULT 0,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Partial unique index: same behaviour as SQLite's "WHERE domain IS NOT NULL",
-- multiple NULL domains are allowed, duplicate non-null domains are not.
CREATE UNIQUE INDEX companies_domain ON companies (domain) WHERE domain IS NOT NULL;

CREATE TABLE contacts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint REFERENCES companies(id) ON DELETE SET NULL,
  first_name    text,
  last_name     text,
  title         text,
  email         text,
  email_status  text CHECK (email_status IS NULL OR email_status IN ('valid','accept-all','mx-only','no-mx','unknown')),
  phone         text,
  linkedin_url  text,
  source        text NOT NULL DEFAULT 'manual',
  apollo_id     text,
  do_not_contact boolean NOT NULL DEFAULT false,
  enriched_at     timestamptz,
  unsubscribed_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_email ON contacts (email) WHERE email IS NOT NULL;

CREATE TABLE deals (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  primary_contact_id  bigint REFERENCES contacts(id) ON DELETE SET NULL,
  title               text NOT NULL,
  stage               text NOT NULL DEFAULT 'Sourced',
  situation           text CHECK (situation IS NULL OR situation IN ('growth-partner','succession','strategic-transition','other')),
  next_step           text,
  next_step_due       timestamptz,
  owner_user_id       bigint REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       text NOT NULL,
  due         timestamptz,
  done        boolean NOT NULL DEFAULT false,
  deal_id     bigint REFERENCES deals(id) ON DELETE CASCADE,
  contact_id  bigint REFERENCES contacts(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activities (  -- the timeline
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('note','call','email-out','email-in','stage-change','signal','import')),
  body        text,
  company_id  bigint REFERENCES companies(id) ON DELETE CASCADE,
  contact_id  bigint REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id     bigint REFERENCES deals(id) ON DELETE CASCADE,
  user_id     bigint REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE signals (  -- from the Python signal engine
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   bigint REFERENCES companies(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('hiring','news','filing','contract','recall','other')),
  title        text NOT NULL,
  url          text,
  observed_at  timestamptz,
  weight       double precision NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- OUTBOUND. Compliance model: content is approved by a PRINCIPAL, and the
-- approval is bound to a content hash. Any edit changes the hash and voids it.
CREATE TABLE templates (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                  text NOT NULL,
  segment_id            text NOT NULL,
  subject               text NOT NULL,
  body                  text NOT NULL,  -- may contain {{merge_fields}}
  allowed_merge_fields  jsonb NOT NULL DEFAULT '["first_name","company_name"]'::jsonb,
  content_hash          text NOT NULL,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected','retired')),
  approved_by           bigint REFERENCES users(id),
  approved_at           timestamptz,
  review_note           text,
  created_by            bigint REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbound_messages (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id        bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  template_id       bigint NOT NULL REFERENCES templates(id),
  template_hash     text NOT NULL,  -- hash of the template at queue time
  merge_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
  rendered_subject  text NOT NULL,
  rendered_body     text NOT NULL,
  lint_json         jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','held','sent','failed','cancelled')),
  mailbox           text,
  scheduled_for     timestamptz,
  sent_at           timestamptz,
  provider_id       text,
  error             text,
  unsubscribe_token text,
  rendered_footer   text,
  replied_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outbound_unsub_token ON outbound_messages (unsubscribe_token) WHERE unsubscribe_token IS NOT NULL;

CREATE TABLE mailboxes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address         text NOT NULL UNIQUE,
  provider        text NOT NULL DEFAULT 'apollo',
  warmup_started  date,  -- date warmup began; null = not started
  paused          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE suppression (
  email       text PRIMARY KEY,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Replies, bounces and unsubscribes read back from the sending provider.
CREATE TABLE inbound_replies (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id  text UNIQUE,  -- provider's message id; makes the sync idempotent
  message_id   bigint REFERENCES outbound_messages(id) ON DELETE SET NULL,
  contact_id   bigint REFERENCES contacts(id) ON DELETE SET NULL,
  from_email   text NOT NULL,
  subject      text,
  snippet      text,
  kind         text NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','bounce','unsubscribe','auto-reply')),
  handled      boolean NOT NULL DEFAULT false,
  received_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Rate limiting that survives restarts and multiple instances. In Postgres
-- this table is also what makes multiple app instances safe to run at once
-- for this specific concern, unlike the SQLite file itself.
CREATE TABLE login_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_bucket ON login_attempts (bucket, created_at);

-- Append-only. No UPDATE or DELETE is ever issued against this table by the
-- application, and the REVOKE below makes that a database-enforced rule
-- instead of just a convention the code has to honor.
CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id   bigint,
  actor_label     text,
  action          text NOT NULL,  -- template.submit | template.approve | template.reject | message.queue | message.send | message.block | login | import ...
  entity          text,
  entity_id       bigint,
  detail_json     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Grants and the append-only enforcement for audit_log.
-- Adjust "app_role" to whatever role the running application actually
-- connects as (directly, or as a member of this role).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, companies, contacts, deals, tasks, activities, signals,
  templates, outbound_messages, mailboxes, suppression, inbound_replies,
  login_attempts
TO app_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_role;

-- audit_log: INSERT and SELECT only. The application never updates or
-- deletes an audit row, so the database refuses it outright even if a bug
-- or a future change tries to.
GRANT SELECT, INSERT ON audit_log TO app_role;
REVOKE UPDATE, DELETE ON audit_log FROM app_role;

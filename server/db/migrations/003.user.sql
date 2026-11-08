-- Travellers who can log in and book.

CREATE TABLE users (
  id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          text NOT NULL,
  password_hash  text NOT NULL,                 -- bcrypt hash, never the password itself
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- "Same email regardless of capitals": Alice@X.com and alice@x.com are one account.
-- A unique index on lower(email) enforces it in the database, even if two sign-ups race.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

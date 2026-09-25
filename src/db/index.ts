import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";

export type Db = PGlite;

/**
 * Embedded Postgres (PGlite). dir=undefined => in-memory (tests).
 * SQL standard Postgres hai, baad mein real Postgres pe shift karna aasan rahega.
 */
export async function openDb(dir?: string): Promise<Db> {
  if (dir) mkdirSync(dirname(dir), { recursive: true });
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  await migrate(db);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id             SERIAL PRIMARY KEY,
  slug           TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  supply         INTEGER NOT NULL CHECK (supply > 0),
  price_zats     BIGINT  NOT NULL CHECK (price_zats > 0),
  max_per_wallet INTEGER NOT NULL CHECK (max_per_wallet > 0),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','ended')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Har order ko ek naya, kabhi repeat na hone wala address index milta hai
CREATE SEQUENCE IF NOT EXISTS pay_address_index_seq START WITH 0 MINVALUE 0;

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  collection_id  INTEGER NOT NULL REFERENCES collections(id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  buyer_address  TEXT NOT NULL,
  pay_address    TEXT NOT NULL UNIQUE,
  address_index  INTEGER NOT NULL UNIQUE,
  amount_zats    BIGINT NOT NULL CHECK (amount_zats > 0),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','paid','minted','expired','refund_needed','refunded')),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS orders_buyer_idx  ON orders(collection_id, buyer_address);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS received_zats   BIGINT  NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_due_zats BIGINT  NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS funded          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at         TIMESTAMPTZ;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS minted_at TIMESTAMPTZ;
-- Kitna paisa (gross) refund mein plan/bheja ja chuka hai. Baaki = refund_due_zats - refunded_zats
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_zats BIGINT NOT NULL DEFAULT 0;

-- Minted NFTs. (collection_id, token_number) UNIQUE => ek token do logon ko kabhi nahi mil sakta
CREATE TABLE IF NOT EXISTS tokens (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  token_number  INTEGER NOT NULL CHECK (token_number > 0),
  owner_address TEXT NOT NULL,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  minted_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (collection_id, token_number)
);
CREATE INDEX IF NOT EXISTS tokens_owner_idx ON tokens(collection_id, owner_address);
CREATE INDEX IF NOT EXISTS tokens_order_idx ON tokens(order_id);

-- Blockchain pe dikhe hue incoming payments (txid+vout unique => dobara dikhne pe duplicate nahi banta)
CREATE TABLE IF NOT EXISTS payments (
  id            SERIAL PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  txid          TEXT NOT NULL,
  vout          INTEGER NOT NULL,
  amount_zats   BIGINT NOT NULL CHECK (amount_zats > 0),
  confirmations INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL,
  dropped       BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (txid, vout)
);
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments(order_id);

-- Refunds. amount_zats = gross (fee isi mein se kat ke buyer ko net milta hai).
CREATE TABLE IF NOT EXISTS refunds (
  id           SERIAL PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  to_address   TEXT NOT NULL,
  amount_zats  BIGINT NOT NULL CHECK (amount_zats > 0),
  fee_zats     BIGINT NOT NULL CHECK (fee_zats >= 0),
  outputs_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','sent','cancelled')),
  txid         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refunds_order_idx ON refunds(order_id);

-- payments ko refund ke liye "reserve" karna: ek input do refunds mein kabhi nahi ja sakta
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_id INTEGER REFERENCES refunds(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS spent_txid TEXT;

-- Audit log: har status change yahan likha jaata hai (paise ka mamla hai, history zaroori hai)
CREATE TABLE IF NOT EXISTS order_events (
  id         SERIAL PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  event      TEXT NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const SCHEMA_V6 = `
-- Creator / fee / escrow settings (har collection ke)
ALTER TABLE collections ADD COLUMN IF NOT EXISTS creator_address TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS fee_bps       INTEGER NOT NULL DEFAULT 100;   -- 100 = 1%
ALTER TABLE collections ADD COLUMN IF NOT EXISTS hold_hours    INTEGER NOT NULL DEFAULT 72;    -- settlement ke baad kitne ghante paisa ruka rahe
ALTER TABLE collections ADD COLUMN IF NOT EXISTS advance_bps   INTEGER NOT NULL DEFAULT 0;     -- trusted creator ko turant kitna % (0 = kuch nahi)
ALTER TABLE collections ADD COLUMN IF NOT EXISTS payout_frozen BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS frozen_reason TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS settled_at    TIMESTAMPTZ;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS ended_at      TIMESTAMPTZ;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS cancelled_at  TIMESTAMPTZ;
-- NOTE: status CHECK constraint yahan dobara nahi likhna (neeche final/wide version hai). Ek hi jagah
-- se manage hona chahiye, warna purani (sankuchit) wali baad ke states (jaise 'pending_review') ko
-- reject kar degi aur HAR restart pe crash degi agar koi row us naye status mein pehle se ho.

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

-- Har minted order ki sale ka hisaab: gross = platform fee + creator ka hissa (ek zat idhar-udhar nahi)
CREATE TABLE IF NOT EXISTS sales (
  id                SERIAL PRIMARY KEY,
  order_id          TEXT NOT NULL UNIQUE REFERENCES orders(id),
  collection_id     INTEGER NOT NULL REFERENCES collections(id),
  gross_zats        BIGINT NOT NULL CHECK (gross_zats > 0),
  platform_fee_zats BIGINT NOT NULL CHECK (platform_fee_zats >= 0),
  creator_net_zats  BIGINT NOT NULL CHECK (creator_net_zats >= 0),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (gross_zats = platform_fee_zats + creator_net_zats)
);
CREATE INDEX IF NOT EXISTS sales_collection_idx ON sales(collection_id);

-- Creator ko dene layak paisa ke "requests". Asli transaction payout engine (baad ke step) banayega.
CREATE TABLE IF NOT EXISTS payout_requests (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  address       TEXT NOT NULL,
  amount_zats   BIGINT NOT NULL CHECK (amount_zats > 0),
  kind          TEXT NOT NULL CHECK (kind IN ('advance','final')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled')),
  txid          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payout_requests_col_idx ON payout_requests(collection_id);

CREATE TABLE IF NOT EXISTS collection_events (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  event         TEXT NOT NULL,
  detail        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Buyers ki reports (ek address ek collection pe ek hi baar)
CREATE TABLE IF NOT EXISTS reports (
  id               SERIAL PRIMARY KEY,
  collection_id    INTEGER NOT NULL REFERENCES collections(id),
  reporter_address TEXT NOT NULL,
  reason           TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (collection_id, reporter_address)
);

-- Refund tracking: broadcast ke baad chain se confirm hone tak / expire hone tak
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS expiry_height    INTEGER;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS confirmed_height INTEGER;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS sent_at          TIMESTAMPTZ;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS alerted          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check CHECK (status IN ('planned','sent','confirmed','failed','cancelled'));

-- Order banate waqt chain ka tip. Isse pehle mined payments is order ke nahi ginte.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS start_height INTEGER;

-- Images / metadata. token_number 0 = collection ka cover (hamesha public).
ALTER TABLE collections ADD COLUMN IF NOT EXISTS reveal_mode     TEXT NOT NULL DEFAULT 'instant' CHECK (reveal_mode IN ('instant','after_soldout'));
ALTER TABLE collections ADD COLUMN IF NOT EXISTS provenance_hash TEXT;

CREATE TABLE IF NOT EXISTS assets (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  token_number  INTEGER NOT NULL CHECK (token_number >= 0),
  file          TEXT NOT NULL,
  mime          TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp','image/gif')),
  sha256        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  attributes    TEXT NOT NULL DEFAULT '[]',
  UNIQUE (collection_id, token_number)
);

-- Collection branding is separate from token artwork so profile/banner files never count as NFTs.
CREATE TABLE IF NOT EXISTS collection_media (
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  kind          TEXT NOT NULL CHECK (kind IN ('profile','banner')),
  file          TEXT NOT NULL,
  mime          TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp','image/gif')),
  sha256        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  PRIMARY KEY (collection_id, kind)
);

-- ============== MARKETPLACE / DISCOVERY / CREATOR UPLOAD (v7) ==============

-- Resale listings. Ek token ka ek waqt me sirf EK active/pending listing (unique index neeche).
CREATE TABLE IF NOT EXISTS listings (
  id             SERIAL PRIMARY KEY,
  collection_id  INTEGER NOT NULL REFERENCES collections(id),
  token_number   INTEGER NOT NULL,
  seller_address TEXT NOT NULL,
  price_zats     BIGINT NOT NULL CHECK (price_zats > 0),
  fee_bps        INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','sold','cancelled')),
  order_id       TEXT REFERENCES orders(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS listings_one_active_per_token
  ON listings(collection_id, token_number) WHERE status IN ('active','pending');
CREATE INDEX IF NOT EXISTS listings_collection_idx ON listings(collection_id, status);

-- Orders ab launchpad mint AUR marketplace purchase dono ke liye use hote hain.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS kind       TEXT NOT NULL DEFAULT 'mint' CHECK (kind IN ('mint','buy','airdrop','offer'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS listing_id INTEGER REFERENCES listings(id);

-- Sales ledger: primary (mint) vs resale, dono ka volume verified-badge/trending mein ginta hai.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary','resale'));

-- Blocklist: chori/report hui NFT ko trade hone se roko (owner apne wallet me dekh sakta hai, list nahi kar sakta).
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS blocked        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

-- Verified badge: NULL = automatic (volume >= threshold), true/false = admin override.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS verified_override BOOLEAN;

-- Creator self-upload: 'pending_review' status collections list/API me nahi dikhti, sirf admin review queue me.
ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_status_check;
ALTER TABLE collections ADD CONSTRAINT collections_status_check CHECK (status IN ('draft','pending_review','live','ended','cancelled'));
ALTER TABLE collections ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS reject_reason TEXT;

-- Unified activity feed (mints, resales, listings) -- discovery ke liye.
CREATE TABLE IF NOT EXISTS activity (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('mint','list','cancel_list','sale','airdrop','offer_made','offer_accepted','offer_rejected')),
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  token_number  INTEGER,
  amount_zats   BIGINT,
  address       TEXT,
  detail        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_time_idx ON activity(created_at DESC);
CREATE INDEX IF NOT EXISTS activity_collection_idx ON activity(collection_id, created_at DESC);

-- Runtime settings (admin se badal sakte hain, restart ki zaroorat nahi). Jaise currency rates.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Bade uploads (drag-drop folder): har file seedhe disk pe stream hoti hai, isliye RAM me poora
-- collection kabhi nahi aata (10 GB ho ya 200 MB, farak nahi padta). Session me sirf form-fields
-- aur ab tak ka total size record hota hai; files ASSETS_DIR/_uploads/<id>/ me hoti hain.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id          TEXT PRIMARY KEY,
  fields_json TEXT NOT NULL,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin dashboard login (password ka SHA-256 .env me; yahan sirf session tokens, expiry ke saath)
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Scheduled launch: collection approve ho jaaye lekin mint us waqt tak band rahe. NULL = turant chalu.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;

-- Creator-facing collection profile metadata. URLs are validated at submission time;
-- preview/cover remains an uploaded local asset, not an arbitrary remote URL.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE collections ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS x_url TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS metadata_json TEXT;

-- Thumbnails: gallery me chhoti (compressed) image dikhane ke liye, taaki bade collection ki gallery
-- fast load ho. NULL matlab thumbnail nahi bani (purana import, ya generation fail hua) -- tab full
-- image hi fallback ban jaati hai.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS thumb_file TEXT;

-- Offers: kisi bhi MINTED token (listed ho ya na ho) pe offer. Buyer pehle hi pay karta hai (escrow,
-- kyunki hum custodial hain), phir owner Accept/Reject kare. Ek token pe ek saath kai offers ho sakte hain.
CREATE TABLE IF NOT EXISTS offers (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  token_number  INTEGER NOT NULL,
  buyer_address TEXT NOT NULL,
  price_zats    BIGINT NOT NULL CHECK (price_zats > 0),
  fee_bps       INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','active','accepted','rejected','cancelled','expired')),
  order_id      TEXT REFERENCES orders(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offers_token_idx ON offers(collection_id, token_number, status);
CREATE INDEX IF NOT EXISTS offers_buyer_idx ON offers(buyer_address, status);

-- Watchlist (per-wallet). Chhota hai, server-side isliye rakha taaki dusre device se bhi dikhe.
CREATE TABLE IF NOT EXISTS watchlist (
  address       TEXT NOT NULL,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (address, collection_id)
);

-- Purane (ledger se pehle ke) minted orders ka hisaab bhar do
INSERT INTO sales (order_id, collection_id, gross_zats, platform_fee_zats, creator_net_zats)
SELECT o.id, o.collection_id, o.amount_zats,
       (o.amount_zats * c.fee_bps / 10000),
       o.amount_zats - (o.amount_zats * c.fee_bps / 10000)
FROM orders o JOIN collections c ON c.id = o.collection_id
WHERE o.status = 'minted'
ON CONFLICT (order_id) DO NOTHING;
`;

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA);
  await db.exec(SCHEMA_V6);
}

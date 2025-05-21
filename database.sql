-- Drop existing tables if they exist (or handle alterations carefully in a migration tool)
-- For development, dropping and recreating is often simpler.
-- WARNING: This will delete all existing data. Backup if needed.
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS draft_nfts CASCADE;
DROP TABLE IF EXISTS nfts CASCADE;
DROP TABLE IF EXISTS user_wallets CASCADE; -- New table, drop if re-running
DROP TABLE IF EXISTS users CASCADE;

-- Users Table (Revised for Email/Password Auth + 2FA)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    hashed_password TEXT NOT NULL,
    username VARCHAR(50) UNIQUE, -- Optional, can be set after registration
    profile_picture_url TEXT,
    phone_number VARCHAR(25), -- For 2FA, ensure it's stored securely/validated
    is_2fa_enabled BOOLEAN DEFAULT FALSE,
    -- wallet_address VARCHAR(255) UNIQUE, -- This was the old primary link, now managed by user_wallets. Can be a primary contact wallet.
    -- Let's make it nullable and not unique here, true uniqueness is in user_wallets
    contact_wallet_address VARCHAR(255) NULL,
    two_factor_code TEXT NULL, -- To store the 6-digit code for 2FA verification
    two_factor_code_expires_at TIMESTAMP WITH TIME ZONE NULL, -- Expiry for the 2FA code
    phone_number_pending_verification TEXT NULL, -- Temporary storage for phone number during 2FA setup
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- User Wallets Table (Many-to-Many link between users and their Solana wallets)
CREATE TABLE user_wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wallet_address VARCHAR(255) UNIQUE NOT NULL, -- Each wallet can only be linked once across all users
    is_primary BOOLEAN DEFAULT FALSE, -- A user might designate one as primary
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_primary_wallet_per_user UNIQUE (user_id, is_primary) -- Ensures only one primary wallet per user (PostgreSQL 15+ for WHERE clause version)
    -- For older PostgreSQL, this constraint might need a trigger or a different approach.
    -- Simpler alternative: just a boolean field, UI/logic ensures only one is true.
);
CREATE INDEX idx_user_wallets_user_id ON user_wallets(user_id);
CREATE INDEX idx_user_wallets_wallet_address ON user_wallets(wallet_address);

-- Draft NFTs Table (Revised Creator Link)
CREATE TABLE draft_nfts (
    id SERIAL PRIMARY KEY,
    creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    symbol VARCHAR(10),
    description TEXT,
    image_url TEXT NOT NULL,
    metadata_json_url TEXT NOT NULL,
    price DECIMAL(20, 9),
    attributes JSONB,
    collection_name VARCHAR(255),
    status VARCHAR(20) DEFAULT 'draft',
    mint_address TEXT NULL, -- To store the actual mint address once finalized
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_draft_nfts_creator_user_id ON draft_nfts(creator_user_id); -- New index
CREATE INDEX idx_draft_nfts_status ON draft_nfts(status);

-- NFTs Table (Revised Ownership)
CREATE TABLE nfts (
    id SERIAL PRIMARY KEY,
    mint_address VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    symbol VARCHAR(10),
    image_url TEXT,
    metadata_url TEXT,
    description TEXT,
    owner_wallet_address VARCHAR(255), -- Actual on-chain owner. No direct FK to users.
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- Link to platform user if known
    price DECIMAL(20, 9),
    is_listed BOOLEAN DEFAULT FALSE,
    attributes JSONB,
    collection_name VARCHAR(255),
    source_draft_id INTEGER REFERENCES draft_nfts(id) ON DELETE SET NULL, -- Link to the original draft if applicable
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_nfts_owner_wallet_address ON nfts(owner_wallet_address); -- New index
CREATE INDEX idx_nfts_owner_user_id ON nfts(owner_user_id);
CREATE INDEX idx_nfts_is_listed ON nfts(is_listed);


-- Transactions Table (No changes for now, but consider linking to user_id later)
CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    nft_id INTEGER REFERENCES nfts(id) NOT NULL,
    seller_wallet_address VARCHAR(255) NOT NULL,
    buyer_wallet_address VARCHAR(255) NOT NULL,
    price DECIMAL(20, 9) NOT NULL,
    transaction_signature VARCHAR(255) UNIQUE NOT NULL,
    transaction_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP -- Renamed from created_at for clarity
);
CREATE INDEX idx_transactions_nft_id ON transactions(nft_id);
CREATE INDEX idx_transactions_buyer ON transactions(buyer_wallet_address);
CREATE INDEX idx_transactions_seller ON transactions(seller_wallet_address);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to automatically update updated_at columns
CREATE TRIGGER set_timestamp_users
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

CREATE TRIGGER set_timestamp_nfts
BEFORE UPDATE ON nfts
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

CREATE TRIGGER set_timestamp_draft_nfts
BEFORE UPDATE ON draft_nfts
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp(); 
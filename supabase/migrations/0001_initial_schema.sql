-- HNPL Initial Schema
-- Healthcare pay-later platform for South Africa

CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id),
    role TEXT CHECK (role IN ('patient', 'practice_admin', 'practice_staff', 'admin')),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    sa_id_number TEXT,
    sa_id_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE practices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES profiles(id),
    name TEXT NOT NULL,
    specialty TEXT NOT NULL,
    hpcsa_number TEXT,
    email TEXT NOT NULL,
    phone TEXT,
    address JSONB,
    bank_name TEXT,
    bank_account_number TEXT,
    branch_code TEXT,
    status TEXT CHECK (status IN ('pending', 'approved', 'suspended', 'inactive')) DEFAULT 'pending',
    fee_percent NUMERIC(5,2) DEFAULT 6.00,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE practice_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    practice_id UUID REFERENCES practices(id),
    user_id UUID REFERENCES profiles(id),
    role TEXT CHECK (role IN ('admin', 'staff')),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (practice_id, user_id)
);

CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES profiles(id),
    practice_id UUID REFERENCES practices(id),
    bill_amount NUMERIC(10,2) NOT NULL,
    bill_reference TEXT,
    plan_type INTEGER CHECK (plan_type IN (2, 3)) NOT NULL,
    status TEXT CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')) DEFAULT 'pending',
    rejection_reason TEXT,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID REFERENCES applications(id),
    patient_id UUID REFERENCES profiles(id),
    practice_id UUID REFERENCES practices(id),
    total_amount NUMERIC(10,2) NOT NULL,
    plan_type INTEGER NOT NULL,
    instalment_amount NUMERIC(10,2) NOT NULL,
    status TEXT CHECK (status IN ('active', 'completed', 'defaulted', 'cancelled')) DEFAULT 'active',
    mandate_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID REFERENCES plans(id),
    patient_id UUID REFERENCES profiles(id),
    instalment_number INTEGER NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    due_date DATE NOT NULL,
    status TEXT CHECK (status IN ('scheduled', 'processing', 'collected', 'failed', 'retried', 'written_off')) DEFAULT 'scheduled',
    peach_payment_id TEXT,
    collected_at TIMESTAMPTZ,
    failure_reason TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    practice_id UUID REFERENCES practices(id),
    plan_id UUID REFERENCES plans(id),
    gross_amount NUMERIC(10,2) NOT NULL,
    fee_amount NUMERIC(10,2) NOT NULL,
    net_amount NUMERIC(10,2) NOT NULL,
    status TEXT CHECK (status IN ('pending', 'processing', 'paid', 'failed')) DEFAULT 'pending',
    peach_payout_id TEXT,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes on foreign keys
CREATE INDEX ON practices (owner_id);
CREATE INDEX ON practice_members (practice_id);
CREATE INDEX ON practice_members (user_id);
CREATE INDEX ON applications (patient_id);
CREATE INDEX ON applications (practice_id);
CREATE INDEX ON plans (application_id);
CREATE INDEX ON plans (patient_id);
CREATE INDEX ON plans (practice_id);
CREATE INDEX ON payments (plan_id);
CREATE INDEX ON payments (patient_id);
CREATE INDEX ON payouts (practice_id);
CREATE INDEX ON payouts (plan_id);

-- Indexes on status and date columns
CREATE INDEX ON payments (status);
CREATE INDEX ON payments (due_date);
CREATE INDEX ON applications (status);
CREATE INDEX ON practices (status);

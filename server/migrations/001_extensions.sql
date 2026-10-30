-- gen_random_uuid() 需要 pgcrypto；Postgres 16 也可以改用内置的 gen_random_uuid()，
-- 但显式装扩展能兼容更旧的实例。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

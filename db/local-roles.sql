-- LOCAL/CI ONLY: set passwords for the roles created in schema.sql so .env.example URLs work.
-- In dev/staging/prod passwords come from AWS Secrets Manager (or IAM auth) — never from this file.
ALTER ROLE stockos_app       PASSWORD 'stockos_app';
ALTER ROLE stockos_platform  PASSWORD 'stockos_platform';
ALTER ROLE stockos_readonly  PASSWORD 'stockos_readonly';

-- A tenant is an app or product: its logo, shown in the operator console. A small image as a data: URL (PNG, JPEG or WebP, at most 48 KB).
ALTER TABLE tenants ADD COLUMN logo TEXT;

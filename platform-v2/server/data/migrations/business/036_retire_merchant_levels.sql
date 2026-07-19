ALTER TABLE core.merchants
    ALTER COLUMN level DROP NOT NULL;

ALTER TABLE core.merchants
    DROP CONSTRAINT IF EXISTS merchants_level_check;

ALTER TABLE core.merchants
    ADD CONSTRAINT merchants_level_compat_check CHECK (
        level IS NULL OR level IN ('V1', 'V2', 'V3', 'V4', 'V5')
    );

ALTER TABLE core.takeover_assignments
    ALTER COLUMN replacement_level DROP NOT NULL;

ALTER TABLE core.takeover_assignments
    DROP CONSTRAINT IF EXISTS takeover_assignments_replacement_level_check;

ALTER TABLE core.takeover_assignments
    ADD CONSTRAINT takeover_assignments_replacement_level_compat_check CHECK (
        replacement_level IS NULL OR replacement_level IN ('V1', 'V2', 'V3', 'V4', 'V5')
    );

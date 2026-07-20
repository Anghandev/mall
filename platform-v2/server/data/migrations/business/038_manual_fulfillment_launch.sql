ALTER TABLE core.administrative_regions
    DROP CONSTRAINT administrative_regions_source_check,
    ADD CONSTRAINT administrative_regions_source_check CHECK (
        source IN ('AMAP', 'GOVERNED_IMPORT', 'BUYER_DECLARED')
    );

CREATE FUNCTION core.protect_administrative_region_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
        AND OLD.region_code = NEW.region_code
        AND OLD.source = 'BUYER_DECLARED'
        AND NEW.source IN ('AMAP', 'GOVERNED_IMPORT')
        AND OLD.status = 'ACTIVE'
        AND NEW.status = 'ACTIVE'
        AND OLD.recorded_at = NEW.recorded_at
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ImmutableRecord' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER administrative_regions_no_mutation ON core.administrative_regions;
CREATE TRIGGER administrative_regions_authority_only
    BEFORE UPDATE OR DELETE ON core.administrative_regions
    FOR EACH ROW EXECUTE FUNCTION core.protect_administrative_region_authority();

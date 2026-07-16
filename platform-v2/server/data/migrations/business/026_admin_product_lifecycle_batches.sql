ALTER TABLE core.admin_batch_operations
    DROP CONSTRAINT admin_batch_operations_operation_type_check;

ALTER TABLE core.admin_batch_operations
    ADD CONSTRAINT admin_batch_operations_operation_type_check CHECK (operation_type IN (
        'EXPORT_CSV',
        'EXPORT_EXCEL',
        'BATCH_ADD_PRODUCT_TAGS',
        'BATCH_PRODUCT_LIFECYCLE'
    ));

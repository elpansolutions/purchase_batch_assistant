import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

CUSTOM_FIELDS = {
    "Purchase Invoice Item": [
        {
            "fieldname": "custom_free_qty",
            "label": "Free Qty",
            "fieldtype": "Float",
            "insert_after": "qty",
            "in_list_view": 1,
            "columns": 1,
            "description": "Free / Scheme units received with this item line",
        },
        {
            "fieldname": "custom_billed_qty",
            "label": "Billed Qty",
            "fieldtype": "Float",
            "insert_after": "custom_free_qty",
            "description": "Purchased / billed quantity excluding free units",
        },
        {
            "fieldname": "custom_billed_rate",
            "label": "Billed Rate",
            "fieldtype": "Currency",
            "insert_after": "rate",
            "options": "Company:company:default_currency",
            "description": "Original purchase rate before scheme / free unit adjustment",
        },
    ]
}

def setup_custom_fields():
    create_custom_fields(CUSTOM_FIELDS, ignore_validate=True)
    
    # 1. Ensure Batch MRP custom fields are NOT mandatory (reqd = 0)
    for cf_name in ["Batch-custom_custom_mrp", "Batch-custom_mrp"]:
        if frappe.db.exists("Custom Field", cf_name):
            frappe.db.set_value("Custom Field", cf_name, "reqd", 0)
    
    frappe.db.sql("""
        UPDATE `tabCustom Field` 
        SET reqd = 0 
        WHERE dt = 'Batch' AND fieldname IN ('custom_custom_mrp', 'custom_mrp', 'mrp')
    """)

    # 2. Remove obsolete legacy Server Script if present
    if frappe.db.exists("Server Script", "Batch Update"):
        frappe.delete_doc("Server Script", "Batch Update", ignore_permissions=True, force=True)
    frappe.db.sql("""DELETE FROM `tabServer Script` WHERE name = 'Batch Update'""")

    # 3. Remove obsolete legacy Client Script if present
    if frappe.db.exists("Client Script", "Batch Creation"):
        frappe.delete_doc("Client Script", "Batch Creation", ignore_permissions=True, force=True)
    frappe.db.sql("""DELETE FROM `tabClient Script` WHERE name = 'Batch Creation'""")

    frappe.db.commit()

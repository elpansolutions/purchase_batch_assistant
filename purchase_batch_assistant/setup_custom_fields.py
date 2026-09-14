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

app_name = "purchase_batch_assistant"
app_title = "Purchase Batch Assistant"
app_publisher = "Custom"
app_description = "Purchase Invoice Batch & Serial Assistant with intelligent auto-discovery, MRP, Expiry, and Serial tracking"
app_email = "admin@example.com"
app_license = "mit"

# Includes in <head>
# ------------------
doctype_js = {
    "Purchase Invoice": "public/js/purchase_invoice_batch.js"
}

app_include_css = "/assets/purchase_batch_assistant/css/purchase_invoice_batch.css"

# Document Events
# ---------------
doc_events = {
    "Purchase Invoice": {
        "validate": "purchase_batch_assistant.api.validate_purchase_invoice"
    }
}

# Installation & Migration Hooks
# ------------------------------
after_install = "purchase_batch_assistant.setup_custom_fields.setup_custom_fields"
after_migrate = "purchase_batch_assistant.setup_custom_fields.setup_custom_fields"

# Fixtures
# --------
fixtures = [
    {
        "dt": "Server Script",
        "filters": [
            ["name", "in", ["Batch Update"]]
        ]
    },
    {
        "dt": "Client Script",
        "filters": [
            ["name", "in", ["tax category autoset purchase invoice"]]
        ]
    }
]


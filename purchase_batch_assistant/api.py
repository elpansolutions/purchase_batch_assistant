import frappe
from frappe import _
from frappe.utils import getdate, format_date, flt, cint

def get_field_mappings():
    """
    Intelligently discover custom or standard field names in Purchase Invoice Item and Batch,
    allowing seamless compatibility across Dev and Prod environments.
    """
    settings = {}
    if frappe.db.exists("DocType", "Purchase Batch Settings"):
        settings = frappe.get_single("Purchase Batch Settings").as_dict() or {}

    pii_meta = frappe.get_meta("Purchase Invoice Item")
    batch_meta = frappe.get_meta("Batch")

    def find_field(meta, candidates, override_key=None):
        if override_key and settings.get(override_key):
            override = settings[override_key].strip()
            if meta.has_field(override):
                return override
        for c in candidates:
            if meta.has_field(c):
                return c
        return None

    # Purchase Invoice Item field resolution
    batch_field = find_field(pii_meta, ["custom_batch_number", "batch_no"], "batch_number_field")
    rate_field = find_field(pii_meta, ["rate"], "rate_field") or "rate"
    mrp_field = find_field(pii_meta, ["custom_mrp", "custom_custom_mrp", "mrp"], "batch_mrp_field")
    expiry_field = find_field(pii_meta, ["custom_expiry_date", "expiry_date"], "batch_expiry_field")
    min_price_field = find_field(pii_meta, ["custom_minimum_selling_price", "minimum_selling_price", "min_selling_price"], "minimum_selling_price_field")
    serial_field = find_field(pii_meta, ["custom_serial_no", "custom_serial_number", "serial_no"], "serial_number_field")

    # Expiry field type on Purchase Invoice Item (Data vs Date)
    expiry_fieldtype = "Data"
    if expiry_field:
        df = pii_meta.get_field(expiry_field)
        if df:
            expiry_fieldtype = df.fieldtype

    # Batch DocType field resolution
    batch_mrp_field = find_field(batch_meta, ["custom_custom_mrp", "custom_mrp", "mrp"])
    batch_min_price_field = find_field(batch_meta, ["custom_minimum_selling_price", "minimum_selling_price"])

    return {
        "batch_field": batch_field or "batch_no",
        "rate_field": rate_field,
        "mrp_field": mrp_field,
        "expiry_field": expiry_field,
        "expiry_fieldtype": expiry_fieldtype,
        "min_price_field": min_price_field,
        "serial_field": serial_field or "serial_no",
        "batch_mrp_field": batch_mrp_field,
        "batch_min_price_field": batch_min_price_field,
        "enable_assistant": cint(settings.get("enable_assistant", 1)),
        "trigger_mode": settings.get("trigger_mode", "Item and Quantity")
    }


def parse_mm_yy_to_date(mm_yy_str):
    """
    Converts MM-YY string (e.g. '04-28' or '08-27') to YYYY-MM-DD matching the last day of the month.
    """
    if not mm_yy_str:
        return None
    
    parts = mm_yy_str.strip().split("-")
    if len(parts) != 2:
        return None

    month_text, year_text = parts[0], parts[1]
    if not (month_text.isdigit() and year_text.isdigit()):
        return None

    month = int(month_text)
    year = 2000 + int(year_text) if len(year_text) == 2 else int(year_text)

    if month < 1 or month > 12:
        return None

    # Determine last day of the month
    if month in [1, 3, 5, 7, 8, 10, 12]:
        last_day = 31
    elif month in [4, 6, 9, 11]:
        last_day = 30
    else:
        is_leap = (year % 400 == 0) or (year % 4 == 0 and year % 100 != 0)
        last_day = 29 if is_leap else 28

    return f"{year:04d}-{month:02d}-{last_day:02d}"


def format_date_to_mm_yy(date_val):
    """
    Converts YYYY-MM-DD or date object to MM-YY string.
    """
    if not date_val:
        return ""
    try:
        d = getdate(date_val)
        return f"{d.month:02d}-{str(d.year)[-2:]}"
    except Exception:
        return ""


@frappe.whitelist()
def get_item_batch_details(item_code, company=None):
    """
    Fetches comprehensive batch, serial, pricing, and schema metadata for item_code.
    """
    if not item_code:
        return {}

    field_map = get_field_mappings()

    # Fetch Item Master info
    item = frappe.get_cached_value(
        "Item",
        item_code,
        ["item_name", "stock_uom", "has_batch_no", "has_serial_no", "create_new_batch", "standard_rate", "valuation_rate"],
        as_dict=True
    ) or {}

    min_selling_price = 0.0
    if frappe.db.has_column("Item", "minimum_selling_price"):
        min_selling_price = flt(frappe.db.get_value("Item", item_code, "minimum_selling_price")) or 0.0

    item["minimum_selling_price"] = min_selling_price

    # Query last purchase rate for this item from any submitted Purchase Invoice
    item_last_purchase_rate = 0.0
    last_pi = frappe.db.sql("""
        SELECT pii.rate
        FROM `tabPurchase Invoice Item` pii
        INNER JOIN `tabPurchase Invoice` pi ON pii.parent = pi.name
        WHERE pi.docstatus = 1 AND pii.item_code = %(item_code)s
        ORDER BY pi.posting_date DESC, pi.creation DESC
        LIMIT 1
    """, {"item_code": item_code}, as_dict=True)
    if last_pi:
        item_last_purchase_rate = flt(last_pi[0].rate)
    item["last_purchase_rate"] = item_last_purchase_rate

    # Query all active batches for this item
    batches = []
    has_batch_tracking = bool(item.get("has_batch_no"))
    
    batch_records = frappe.db.sql("""
        SELECT 
            b.name,
            b.batch_id,
            b.expiry_date,
            b.manufacturing_date,
            b.batch_qty,
            b.disabled
        FROM `tabBatch` b
        WHERE b.item = %(item_code)s AND b.disabled = 0
        ORDER BY b.creation DESC
    """, {"item_code": item_code}, as_dict=True)

    batch_mrp_col = field_map.get("batch_mrp_field")
    batch_min_col = field_map.get("batch_min_price_field")

    for b in batch_records:
        batch_id = b.batch_id or b.name
        expiry_date = b.expiry_date
        expiry_mm_yy = format_date_to_mm_yy(expiry_date)
        expiry_formatted = format_date(expiry_date) if expiry_date else ""

        # Batch MRP
        mrp = 0.0
        if batch_mrp_col and frappe.db.has_column("Batch", batch_mrp_col):
            mrp = flt(frappe.db.get_value("Batch", b.name, batch_mrp_col)) or 0.0

        # Batch Min Selling Price
        b_min_price = min_selling_price
        if batch_min_col and frappe.db.has_column("Batch", batch_min_col):
            val = flt(frappe.db.get_value("Batch", b.name, batch_min_col))
            if val > 0:
                b_min_price = val

        # If MRP is not in Batch record, check last Purchase Invoice Item
        last_purchase_rate = 0.0
        pi_match = frappe.db.sql("""
            SELECT pii.rate, pii.custom_mrp, pi.name AS voucher_no, pi.posting_date
            FROM `tabPurchase Invoice Item` pii
            INNER JOIN `tabPurchase Invoice` pi ON pii.parent = pi.name
            WHERE pi.docstatus = 1
              AND pii.item_code = %(item_code)s
              AND (pii.batch_no = %(batch_no)s OR pii.custom_batch_number = %(batch_id)s)
            ORDER BY pi.posting_date DESC, pi.creation DESC
            LIMIT 1
        """, {"item_code": item_code, "batch_no": b.name, "batch_id": batch_id}, as_dict=True)

        if pi_match:
            last_purchase_rate = flt(pi_match[0].rate)
            if mrp <= 0 and pi_match[0].get("custom_mrp"):
                mrp = flt(pi_match[0].custom_mrp)

        if last_purchase_rate <= 0 and item_last_purchase_rate > 0:
            last_purchase_rate = item_last_purchase_rate

        # Check expired
        today_date = getdate()
        is_expired = bool(expiry_date and getdate(expiry_date) < today_date)

        batches.append({
            "name": b.name,
            "batch_id": batch_id,
            "expiry_date": str(expiry_date) if expiry_date else "",
            "expiry_mm_yy": expiry_mm_yy,
            "expiry_formatted": expiry_formatted,
            "is_expired": is_expired,
            "mrp": mrp,
            "minimum_selling_price": b_min_price,
            "batch_qty": flt(b.batch_qty),
            "last_purchase_rate": last_purchase_rate,
            "manufacturing_date": str(b.manufacturing_date) if b.manufacturing_date else ""
        })

    return {
        "item": item,
        "has_batch_tracking": has_batch_tracking or (len(batches) > 0),
        "has_serial_tracking": bool(item.get("has_serial_no")),
        "batches": batches,
        "field_mapping": field_map,
        "current_date": str(getdate()),
        "current_mm_yy": format_date_to_mm_yy(getdate())
    }


@frappe.whitelist()
def create_or_get_batch(item_code, batch_id, expiry_date=None, expiry_mm_yy=None, mrp=None, min_selling_price=None):
    """
    Creates a new Batch or fetches an existing one, updating MRP and Expiry as appropriate.
    Handles MM-YY conversions automatically.
    """
    if not item_code or not batch_id:
        frappe.throw(_("Item Code and Batch Number are required."))

    batch_id = batch_id.strip()

    # Resolve Expiry Date
    if expiry_mm_yy and not expiry_date:
        expiry_date = parse_mm_yy_to_date(expiry_mm_yy)
        if not expiry_date:
            frappe.throw(_("Invalid Expiry Date '{0}'. Must be in MM-YY format (e.g. 08-27).").format(expiry_mm_yy))
    elif expiry_date and not expiry_mm_yy:
        expiry_mm_yy = format_date_to_mm_yy(expiry_date)

    field_map = get_field_mappings()
    batch_mrp_col = field_map.get("batch_mrp_field")
    batch_min_col = field_map.get("batch_min_price_field")

    # Check if Batch already exists by batch_id or name
    existing_name = frappe.db.get_value("Batch", {"batch_id": batch_id}, "name")
    if not existing_name and frappe.db.exists("Batch", batch_id):
        existing_name = batch_id

    if existing_name:
        batch = frappe.get_doc("Batch", existing_name)
        if batch.item != item_code:
            frappe.throw(_("Batch '{0}' already exists for Item '{1}', but you selected Item '{2}'.").format(
                batch_id, batch.item, item_code
            ))
        
        # If existing batch lacks expiry or MRP, update them
        updated = False
        if expiry_date and not batch.expiry_date:
            batch.expiry_date = expiry_date
            updated = True
        
        if mrp and batch_mrp_col and flt(batch.get(batch_mrp_col)) <= 0:
            batch.set(batch_mrp_col, flt(mrp))
            updated = True

        if min_selling_price and batch_min_col and flt(batch.get(batch_min_col)) <= 0:
            batch.set(batch_min_col, flt(min_selling_price))
            updated = True

        if updated:
            batch.save(ignore_permissions=True)

        batch_name = batch.name
    else:
        # Create brand-new Batch
        batch = frappe.new_doc("Batch")
        batch.batch_id = batch_id
        batch.item = item_code
        if expiry_date:
            batch.expiry_date = expiry_date
        if mrp and batch_mrp_col:
            batch.set(batch_mrp_col, flt(mrp))
        if min_selling_price and batch_min_col:
            batch.set(batch_min_col, flt(min_selling_price))
        
        batch.insert(ignore_permissions=True)
        batch_name = batch.name

    return {
        "name": batch_name,
        "batch_id": batch_id,
        "expiry_date": str(batch.expiry_date) if batch.expiry_date else (expiry_date or ""),
        "expiry_mm_yy": expiry_mm_yy or format_date_to_mm_yy(batch.expiry_date),
        "mrp": flt(mrp),
        "minimum_selling_price": flt(min_selling_price)
    }


@frappe.whitelist()
def validate_serials(item_code, serial_nos):
    """
    Validates serial numbers for Purchase Invoice.
    Checks for duplicates in input and against existing Serial No records.
    """
    if isinstance(serial_nos, str):
        lines = [s.strip() for s in serial_nos.replace(",", "\n").split("\n") if s.strip()]
    else:
        lines = [str(s).strip() for s in serial_nos if str(s).strip()]

    duplicates = []
    seen = set()
    for s in lines:
        if s in seen:
            duplicates.append(s)
        seen.add(s)

    existing = []
    if lines and frappe.db.exists("DocType", "Serial No"):
        existing_records = frappe.db.get_list(
            "Serial No",
            filters={"name": ["in", lines]},
            pluck="name"
        )
        existing = existing_records

    return {
        "valid": len(duplicates) == 0,
        "total_count": len(lines),
        "duplicates_in_input": duplicates,
        "existing_in_database": existing,
        "cleaned_serials": lines
    }


def validate_purchase_invoice(doc, method=None):
    """
    Server-side validation for Purchase Invoice:
    Ensures Billing / Purchase Rate is strictly less than MRP (< MRP) for all items.
    """
    field_map = get_field_mappings()
    mrp_field = field_map.get("mrp_field") or "custom_mrp"
    rate_field = field_map.get("rate_field") or "rate"
    currency = doc.get("currency") or "₹"

    for row in doc.get("items", []):
        if not row.get("item_code"):
            continue
        rate = flt(row.get(rate_field) if row.get(rate_field) is not None else row.get("rate"))
        mrp = flt(row.get(mrp_field) if row.get(mrp_field) is not None else row.get("mrp"))
        if rate > 0 and mrp > 0 and rate >= mrp:
            frappe.throw(
                _("Row #{0} ({1}): Billing / Purchase Rate ({2} {3}) must be strictly less than Batch MRP ({2} {4}). Rate cannot be equal to or greater than MRP.").format(
                    row.idx, row.item_code, currency, rate, mrp
                ),
                title=_("Rate Exceeds or Equals MRP")
            )


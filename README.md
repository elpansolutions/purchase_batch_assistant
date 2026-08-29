# Purchase Invoice Batch & Serial Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Frappe Framework](https://img.shields.io/badge/Frappe-v14%20%7C%20v15%20%7C%20v16-orange.svg)](https://frappeframework.com)
[![ERPNext](https://img.shields.io/badge/ERPNext-Compatible-green.svg)](https://erpnext.com)

**Purchase Batch Assistant** (`purchase_batch_assistant`) is an enterprise-grade Frappe / ERPNext application designed to streamline Purchase Invoices. Whenever an item and quantity are entered, an interactive, unified assistant pops up to let users pick an existing batch with 1-click or enter new batch details without errors.

It prevents data entry mismatches, blocks expired stock, manages serial numbers, defers database batch creation until actual invoice submission, and works seamlessly across Development and Production environments without code modifications.

---

## 🚀 Key Features

### 1. Unified Single-Screen Modal
- **No tab switching**: Displays both the **Existing Batches Quick-Pick Table** and the **Direct Details Form** together on the same screen.
- Clicking any existing batch row instantly populates the form below with 1 click.
- For new batches, users can directly enter the details in the form on the same page.

### 2. Zero-Discrepancy Existing Batch Selection
- Displays all active batches for the selected item with Batch Number, MRP, Expiry Date (`MM-YY` badge + readable date), and Current Stock.
- Modern **"Use This"** action button highlights selected rows and populates custom fields (`custom_batch_number`, `custom_mrp`, `custom_expiry_date`, etc.).
- Pre-populating verified batch details ensures strict compliance with server scripts that reject mismatched MRP or Expiry.

### 3. Strict Past-Date Expiry Validation
- Validates the entered `MM-YY` string (e.g. `08-27`).
- Automatically computes the last day of the expiration month and compares against the system date.
- **Blocks Expired Stock**: If the expiry date is in the past (e.g., `01-24`), the form alerts the user and prevents submission.
- Expired batches in the existing list are marked with a disabled **"Expired"** badge to prevent purchasing expired inventory.
- Features bidirectional synchronization between the `MM-YY` text field and the visual date picker.

### 4. Delayed Batch Creation (Saved Only on Invoice Submission)
- The modal **does not prematurely create batch documents** in `tabBatch` while drafting rows.
- It populates the Purchase Invoice Item row fields, allowing standard ERPNext batch creation or your custom server scripts to insert the batch record only when the invoice is validated and submitted.

### 5. Smart Serial Number Handling
- **Quantity = 1**: Displays a clean single-line serial number input field.
- **Quantity > 1**: Displays a multi-line textarea with a live counter (`N / Qty entered`) showing green when exact count matches.
- **Auto-Generator Tool**: Allows generating sequential serials in seconds by specifying a prefix (`SN-`) and start number (`1001`).

### 6. Multi-Environment Resilience (Dev vs. Prod)
- Automatically detects custom or standard field names in both `Purchase Invoice Item` and `Batch`:
  - **Batch**: `custom_batch_number` &rarr; falls back to `batch_no`
  - **MRP**: `custom_mrp` &rarr; `custom_custom_mrp` &rarr; `mrp`
  - **Expiry**: `custom_expiry_date` (Data/`MM-YY`) &rarr; `expiry_date` (Date)
  - **Min Selling Price**: `custom_minimum_selling_price` &rarr; `minimum_selling_price`
  - **Serial No**: `custom_serial_no` &rarr; `serial_no`
- **Purchase Batch Settings**: Includes a Single DocType in Desk allowing administrators to override field names if Prod uses custom nomenclature.

---

## 📋 Requirements & Prerequisites

- **Frappe Framework**: Version 14, 15, or 16
- **ERPNext**: Version 14, 15, or 16
- **Python**: `>= 3.10`
- **Node.js**: `>= 18`

---

## 🛠️ Installation Steps

### Step 1: Fetch the App
From your `frappe-bench` directory:
```bash
bench get-app https://github.com/elpansolutions/purchase_batch_assistant.git
```

*(Or if using a local directory: `bench get-app purchase_batch_assistant`)*

### Step 2: Install App on Your Site
Replace `site1.local` with your site name:
```bash
bench --site site1.local install-app purchase_batch_assistant
```

### Step 3: Run Database Migrations
Ensures settings doctypes and schema updates are synchronized:
```bash
bench --site site1.local migrate
```

### Step 4: Build Assets & Clear Cache
```bash
bench build --app purchase_batch_assistant
bench --site site1.local clear-cache
```

### Step 5: Restart Bench
```bash
bench restart
# or if using supervisor:
sudo supervisorctl restart frappe-bench-frappe-web
```

---

## ⚙️ Configuration & Usage

### 1. Creating a Purchase Invoice
1. Navigate to **Buying > Purchase Invoice > New** (or **Accounting > Purchase Invoice > New**).
2. Select the **Supplier**.
3. In the **Items** table, select an **Item Code** and enter the **Quantity**.
4. The **Batch & Serial Assistant** popup appears automatically:
   - **Pick Existing Batch**: Review existing batches and click **"Use This"** on any active row.
   - **Enter New Batch**: Type the Batch Number, MRP, Expiry Date (`MM-YY`), and optional Minimum Selling Price.
   - **Serial Numbers**: If tracked, enter serials or use the Quick Generator.
5. Click **Apply to Row**.
6. The child row fields are populated instantly.
7. Save and Submit the invoice when ready.

### 2. Admin Settings (Optional)
If your environment uses custom field names, navigate to:
**Desk > Search: "Purchase Batch Settings"**
- Configure custom field names for batch, MRP, expiry, minimum price, or serials.
- Toggle automatic popup trigger on/off.
- Leave fields blank to let the built-in auto-discovery handle everything.

---

## 📁 Repository Structure

```text
purchase_batch_assistant/
├── pyproject.toml
├── README.md
├── license.txt
├── .gitignore
└── purchase_batch_assistant/
    ├── __init__.py
    ├── hooks.py
    ├── modules.txt
    ├── patches.txt
    ├── api.py                          # Backend schema discovery & batch queries
    ├── purchase_batch_assistant/
    │   ├── __init__.py
    │   └── doctype/
    │       └── purchase_batch_settings/  # Single Settings DocType
    │           ├── purchase_batch_settings.json
    │           └── purchase_batch_settings.py
    └── public/
        ├── css/
        │   └── purchase_invoice_batch.css  # Modern UI & button styles
        └── js/
            └── purchase_invoice_batch.js  # Form event hooks & modal controller
```

---

## 📄 License

This application is distributed under the [MIT License](LICENSE).

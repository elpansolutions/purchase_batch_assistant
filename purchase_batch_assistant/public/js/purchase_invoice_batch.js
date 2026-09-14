// Purchase Invoice Batch & Serial Assistant
// Unified single-page modal for selecting existing batches or entering new ones,
// with past-date expiry prevention, serial number support, free items/replacements, and delayed batch saving.

frappe.ui.form.on('Purchase Invoice', {
    refresh: function(frm) {
        // Form level hooks
    },
    supplier: function(frm) {
        setTimeout(() => auto_set_tax_category_from_address(frm), 800);
    },
    supplier_address: function(frm) {
        setTimeout(() => auto_set_tax_category_from_address(frm), 200);
    },
    validate: function(frm) {
        for (let row of (frm.doc.items || [])) {
            if (!row.item_code) continue;
            let rate = flt(row.rate);
            let mrp = flt(row.custom_mrp || row.mrp);
            if (!row.is_free_item && rate > 0 && mrp > 0 && rate >= mrp) {
                frappe.validated = false;
                frappe.throw({
                    title: __('Rate Exceeds or Equals MRP'),
                    message: __('Row #{0} ({1}): Billing / Purchase Rate (<b>{2}</b>) must be strictly less than Batch MRP (<b>{3}</b>). Rate cannot be equal to or greater than MRP.', [row.idx || '', row.item_code, rate, mrp])
                });
                return false;
            }
        }
    }
});

async function auto_set_tax_category_from_address(frm) {
    if (!frm.doc.supplier_address || frm.doc.docstatus !== 0) return;
    try {
        const result = await frappe.db.get_value('Address', frm.doc.supplier_address, ['gstin', 'gst_state_number', 'gst_state']);
        const address = result?.message || {};
        const gstin = String(address.gstin || '').trim().replace(/\s+/g, '').toUpperCase();
        if (!gstin) return;
        const state_code = gstin.substring(0, 2);
        const tax_category = state_code === '33' ? 'In-State' : 'Out-State';
        if (frm.doc.tax_category !== tax_category) {
            await frm.set_value('tax_category', tax_category);
        }
    } catch (e) {
        // Silently pass if address query fails
    }
}


frappe.ui.form.on('Purchase Invoice Item', {
    item_code: function(frm, cdt, cdn) {
        let row = locals[cdt]?.[cdn];
        if (!row || !row.item_code || row.is_free_item || row.__pba_applying || window.__pba_active_dialog) return;

        row.__pba_handled_key = null;

        // Trigger if quantity is already entered
        if (flt(row.qty) > 0) {
            setTimeout(() => {
                if (row.__pba_applying || window.__pba_active_dialog) return;
                trigger_purchase_batch_assistant(frm, cdt, cdn, false);
            }, 300);
        }
    },

    qty: function(frm, cdt, cdn) {
        let row = locals[cdt]?.[cdn];
        if (!row || !row.item_code || row.is_free_item || row.__pba_applying || window.__pba_active_dialog) return;

        let current_handle_key = `${row.item_code}_${flt(row.qty)}`;
        if (row.__pba_handled_key === current_handle_key) {
            return;
        }

        // Reset handled key when user manually modifies qty
        row.__pba_handled_key = null;

        if (flt(row.qty) > 0) {
            setTimeout(() => {
                if (row.__pba_applying || window.__pba_active_dialog) return;
                trigger_purchase_batch_assistant(frm, cdt, cdn, false);
            }, 300);
        }
    },

    form_render: function(frm, cdt, cdn) {
        let row = locals[cdt]?.[cdn];
        if (!row) return;

        if (frm.fields_dict.items && frm.fields_dict.items.grid && frm.fields_dict.items.grid.open_grid_row) {
            let grid_row = frm.fields_dict.items.grid.open_grid_row;
            if (grid_row && !grid_row.__pba_btn_added) {
                grid_row.__pba_btn_added = true;
                let btn = $(`<button class="btn btn-xs btn-default" style="margin-top: 6px; margin-bottom: 6px;">
                    <i class="fa fa-barcode text-primary"></i> ${__('Select / Enter Batch & Serial')}
                </button>`);
                btn.on('click', function(e) {
                    e.preventDefault();
                    trigger_purchase_batch_assistant(frm, cdt, cdn, true);
                });
                grid_row.wrapper.find('.grid-row-header').append(btn);
            }
        }
    }
});

function trigger_purchase_batch_assistant(frm, cdt, cdn, is_manual) {
    let row = locals[cdt]?.[cdn];
    if (!row || !row.item_code || row.is_free_item || row.__pba_applying) return;

    let qty = flt(row.qty);
    if (qty <= 0) {
        if (is_manual) {
            frappe.msgprint(__('Please specify a valid Quantity greater than 0 first.'));
        }
        return;
    }

    // Avoid infinite loop if already open or handled for this item and qty
    if (window.__pba_active_dialog) return;
    let handle_key = `${row.item_code}_${qty}`;
    if (!is_manual && row.__pba_handled_key === handle_key) {
        return;
    }

    frappe.call({
        method: 'purchase_batch_assistant.api.get_item_batch_details',
        args: {
            item_code: row.item_code,
            company: frm.doc.company || null
        },
        freeze: false,
        callback: function(r) {
            if (!r || !r.message) return;
            let data = r.message;

            if (data.field_mapping && data.field_mapping.enable_assistant === 0) {
                return;
            }

            show_unified_batch_dialog(frm, cdt, cdn, data, is_manual);
        }
    });
}

function show_unified_batch_dialog(frm, cdt, cdn, data, is_manual) {
    let row = locals[cdt]?.[cdn];
    if (!row) return;

    window.__pba_active_dialog = true;

    let currency = frm.doc.currency || '₹';
    let current_qty = flt(row.qty) || 1.0;
    let item_code = row.item_code;
    let item_name = data.item?.item_name || item_code;
    let stock_uom = data.item?.stock_uom || row.uom || 'Nos';
    let batches = data.batches || [];
    let field_map = data.field_mapping || {};
    let system_today = data.current_date || frappe.datetime.get_today();

    // Prefill existing row values if present
    let initial_batch = row[field_map.batch_field] || row.batch_no || '';
    let initial_free_qty = flt(row[field_map.free_qty_field || 'custom_free_qty']) || flt(row.custom_free_qty) || 0;
    
    // Check if legacy companion free row exists
    let batch_field = field_map.batch_field || 'batch_no';
    let legacy_free_row = (frm.doc.items || []).find(r => r.is_free_item && (r.__pba_parent_cdn === cdn || (r.item_code === item_code && initial_batch && r[batch_field] === initial_batch)));
    if (!initial_free_qty && legacy_free_row) {
        initial_free_qty = flt(legacy_free_row.qty);
    }
    let is_free_initially_checked = initial_free_qty > 0;

    // Billed Quantity (excluding free units)
    let initial_billed_qty = flt(row[field_map.billed_qty_field || 'custom_billed_qty']) || (initial_free_qty > 0 ? (flt(row.qty) - initial_free_qty) : flt(row.qty)) || 1.0;
    if (initial_billed_qty <= 0) initial_billed_qty = 1.0;
    current_qty = initial_billed_qty;

    let initial_rate = flt(row[field_map.billed_rate_field || 'custom_billed_rate']) || (field_map.rate_field && flt(row[field_map.rate_field])) || flt(row.rate) || flt(row.price_list_rate) || flt(data.item?.last_purchase_rate) || flt(data.item?.standard_rate) || '';
    let initial_mrp = flt(row[field_map.mrp_field]) || '';
    let initial_expiry = row[field_map.expiry_field] || '';
    let initial_min_price = (field_map.min_price_field ? flt(row[field_map.min_price_field]) : '') || data.item?.minimum_selling_price || '';
    let initial_serials = (field_map.serial_field ? row[field_map.serial_field] : '') || row.serial_no || '';

    let dialog = new frappe.ui.Dialog({
        title: __('Batch & Serial Assistant — {0}', [item_code]),
        size: 'large',
        fields: [
            {
                fieldname: 'main_html',
                fieldtype: 'HTML'
            }
        ],
        primary_action_label: __('Apply to Row (Enter)'),
        primary_action: function() {
            apply_to_row();
        },
        secondary_action_label: __('Cancel / Skip (Esc)'),
        secondary_action: function() {
            row.__pba_handled_key = `${item_code}_${current_qty}`;
            dialog.hide();
        }
    });

    dialog.$wrapper.addClass('pba-dialog');
    dialog.on_hide = function() {
        window.__pba_active_dialog = false;
    };

    // Helper: convert MM-YY to last day YYYY-MM-DD
    function mmyy_to_date_str(mmyy) {
        if (!/^(0[1-9]|1[0-2])-\d{2}$/.test(mmyy)) return null;
        let parts = mmyy.split('-');
        let month = parseInt(parts[0], 10);
        let year = 2000 + parseInt(parts[1], 10);
        let last_day = new Date(year, month, 0).getDate();
        let m_str = month < 10 ? '0' + month : month;
        let d_str = last_day < 10 ? '0' + last_day : last_day;
        return `${year}-${m_str}-${d_str}`;
    }

    // Helper: check if date is strictly expired compared to today
    function is_date_expired(date_str) {
        if (!date_str) return false;
        let d = frappe.datetime.str_to_obj(date_str);
        let today = frappe.datetime.str_to_obj(system_today);
        return d < today;
    }

    // Build Unified Single-Page HTML
    let content_html = `
        <!-- Header Cards -->
        <div class="pba-header-cards">
            <div class="pba-card">
                <div class="pba-card-label">${__('Item')}</div>
                <div class="pba-card-val" style="font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${frappe.utils.escape_html(item_name)}">
                    ${frappe.utils.escape_html(item_name)}
                </div>
            </div>
            <div class="pba-card">
                <div class="pba-card-label">${__('Invoice Billed Qty')}</div>
                <div class="pba-card-val text-primary">${current_qty} <span style="font-size: 11px; font-weight: normal; color: #64748b;">${stock_uom}</span></div>
            </div>
            <div class="pba-card">
                <div class="pba-card-label">${__('System Date')}</div>
                <div class="pba-card-val" style="font-size: 13px; color: #334155;">
                    ${frappe.datetime.str_to_user(system_today)}
                </div>
            </div>
            ${(flt(data.item?.last_purchase_rate) > 0) ? `
            <div class="pba-card">
                <div class="pba-card-label">${__('Last Purchase Rate')}</div>
                <div class="pba-card-val text-primary" style="font-size: 14px;">${currency} ${format_currency(data.item.last_purchase_rate, currency)}</div>
            </div>` : ''}
            ${data.item?.minimum_selling_price ? `
            <div class="pba-card">
                <div class="pba-card-label">${__('Item Min Price')}</div>
                <div class="pba-card-val text-warning" style="font-size: 14px;">${currency} ${format_currency(data.item.minimum_selling_price, currency)}</div>
            </div>` : ''}
        </div>
    `;

    // Existing Batches Quick-Pick Box (on the same screen!)
    if (batches.length > 0) {
        content_html += `
            <div class="pba-existing-box">
                <div class="pba-existing-box-header">
                    <span class="pba-existing-box-title">
                        <i class="fa fa-list text-primary"></i> ${__('Existing Batches for this Item')} (${batches.length})
                    </span>
                    <input type="text" id="pba_search_existing" placeholder="${__('Search batch #, rate, MRP, expiry...')}" style="font-size: 11px; padding: 2px 8px; border: 1px solid #cbd5e1; border-radius: 4px; width: 220px;">
                </div>
                <div class="pba-table-container">
                    <table class="pba-table" id="pba_table_existing">
                        <thead>
                            <tr>
                                <th>${__('Batch Number')}</th>
                                <th>${__('Last Rate')}</th>
                                <th>${__('MRP')}</th>
                                <th>${__('Expiry (MM-YY)')}</th>
                                <th>${__('Available Stock')}</th>
                                <th>${__('Status')}</th>
                                <th style="text-align: right;">${__('Action')}</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        batches.forEach((b, idx) => {
            let rate_str = b.last_purchase_rate > 0 ? `${currency} ${format_currency(b.last_purchase_rate, currency)}` : '—';
            let mrp_str = b.mrp > 0 ? `${currency} ${format_currency(b.mrp, currency)}` : '—';
            let exp_badge = b.expiry_mm_yy ? `<span class="pba-badge ${b.is_expired ? 'pba-badge-red' : 'pba-badge-green'}">${b.expiry_mm_yy}</span>` : '—';
            let status_badge = b.is_expired ? `<span class="pba-badge pba-badge-red">${__('Expired')}</span>` : `<span class="pba-badge pba-badge-green">${__('Active')}</span>`;
            let stock_str = `${b.batch_qty} ${stock_uom}`;

            content_html += `
                <tr class="pba-batch-row ${b.is_expired ? 'pba-row-expired' : ''}" data-index="${idx}">
                    <td><strong>${frappe.utils.escape_html(b.batch_id)}</strong></td>
                    <td style="color: #0284c7; font-weight: 600;">${rate_str}</td>
                    <td style="color: #15803d; font-weight: 600;">${mrp_str}</td>
                    <td>${exp_badge} ${b.expiry_formatted ? `<small style="color:#64748b;">(${b.expiry_formatted})</small>` : ''}</td>
                    <td>${stock_str}</td>
                    <td>${status_badge}</td>
                    <td style="text-align: right;">
                        <button type="button" class="pba-btn-pick ${b.is_expired ? 'pba-btn-pick-disabled' : ''}" data-index="${idx}">
                            ${b.is_expired ? `<i class="fa fa-ban"></i> ${__('Expired')}` : `<i class="fa fa-arrow-down"></i> ${__('Use This')}`}
                        </button>
                    </td>
                </tr>
            `;
        });

        content_html += `
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    // Direct Input Form (Same Screen!)
    content_html += `
        <div class="pba-form-box">
            <div class="pba-form-box-title">
                <span><i class="fa fa-edit text-primary"></i> ${__('Batch & Rate Details to Populate')}</span>
                <span style="font-size: 11px; font-weight: normal; color: #64748b; text-transform: none;">
                    ${__('Select an existing batch above or type new details directly')}
                </span>
            </div>
            <div class="row">
                <div class="col-sm-6">
                    <div class="form-group">
                        <label class="control-label" style="font-weight: 600;">${__('Batch Number')} <span class="text-danger">*</span></label>
                        <input type="text" id="pba_input_batch_id" class="form-control input-sm" value="${frappe.utils.escape_html(initial_batch)}" placeholder="${__('e.g. B-2026-001')}">
                    </div>
                </div>
                <div class="col-sm-6">
                    <div class="form-group">
                        <label class="control-label" style="font-weight: 600;">${__('Expiry Date (MM-YY)')} <span class="text-danger">*</span></label>
                        <input type="text" id="pba_input_expiry_mmyy" class="form-control input-sm" value="${frappe.utils.escape_html(initial_expiry)}" placeholder="MM-YY (e.g. 08-27)" maxlength="5">
                        <div id="pba_expiry_feedback" style="font-size: 11px; margin-top: 3px; color: #64748b;">
                            ${__('Must not be an expired date in the past')}
                        </div>
                    </div>
                </div>
            </div>
            <div class="row" style="margin-top: 6px;">
                <div class="col-sm-4">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="control-label" style="font-weight: 600;">${__('Billing / Purchase Rate ({0})', [currency])} <span class="text-danger">*</span></label>
                        <input type="number" step="0.01" id="pba_input_rate" class="form-control input-sm" value="${initial_rate}" placeholder="${__('Rate billed to us')}">
                    </div>
                </div>
                <div class="col-sm-4">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="control-label" style="font-weight: 600;">${__('Batch MRP ({0})', [currency])} <span class="text-danger">*</span></label>
                        <input type="number" step="0.01" id="pba_input_mrp" class="form-control input-sm" value="${initial_mrp}" placeholder="${__('Maximum Retail Price')}">
                    </div>
                </div>
                <div class="col-sm-4">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="control-label" style="font-weight: 600;">${__('Minimum Selling Price ({0})', [currency])}</label>
                        <input type="number" step="0.01" id="pba_input_min_price" class="form-control input-sm" value="${initial_min_price}" placeholder="${__('Optional floor price')}">
                    </div>
                </div>
            </div>
            <div id="pba_rate_mrp_feedback" style="font-size: 11px; margin-top: 6px; display: none;"></div>

            <!-- Free Item / Scheme / Replacement Section -->
            <div class="pba-free-box ${is_free_initially_checked ? '' : 'is-inactive'}" id="pba_free_container">
                <div style="display: flex; align-items: center; justify-content: space-between;">
                    <label class="pba-checkbox-label" style="display: flex; align-items: center; gap: 8px; margin-bottom: 0;">
                        <input type="checkbox" id="pba_check_free_item" ${is_free_initially_checked ? 'checked' : ''}>
                        <span><i class="fa fa-gift text-primary"></i> ${__('Add Free Item / Scheme / Replacement')}</span>
                    </label>
                    <span id="pba_free_scheme_badge" class="pba-badge pba-badge-blue" style="${is_free_initially_checked ? '' : 'display: none;'}">${__('Scheme Active')}</span>
                </div>
                <div id="pba_free_details_row" style="${is_free_initially_checked ? '' : 'display: none;'} margin-top: 10px; padding-top: 10px; border-top: 1px dashed #cbd5e1;">
                    <div class="row">
                        <div class="col-sm-5">
                            <div class="form-group" style="margin-bottom: 0;">
                                <label class="control-label" style="font-weight: 600; font-size: 11px;">${__('Free Quantity ({0})', [stock_uom])} <span class="text-danger">*</span></label>
                                <input type="number" step="1" min="1" id="pba_input_free_qty" class="form-control input-sm" value="${initial_free_qty || 1}" placeholder="${__('e.g. 5')}">
                            </div>
                        </div>
                        <div class="col-sm-7">
                            <div id="pba_free_summary" style="font-size: 11px; padding: 6px 10px; background: #eff6ff; border-radius: 6px; border: 1px solid #bfdbfe; color: #1e40af; line-height: 1.4;">
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Serial Number Section (Always Accessible on Same Screen) -->
        <div class="pba-serial-box">
            <div class="pba-serial-header">
                <div class="pba-serial-title">
                    <i class="fa fa-barcode text-primary"></i> ${__('Serial Numbers')} (Quantity: <span id="pba_serial_total_qty">${current_qty}</span>)
                </div>
                <span id="pba_serial_badge" class="pba-counter pba-counter-warn">0 / ${current_qty} ${__('entered')}</span>
            </div>
    `;

    if (current_qty === 1) {
        content_html += `
            <div class="form-group" style="margin-bottom: 0;">
                <input type="text" id="pba_input_serial" class="form-control input-sm" value="${frappe.utils.escape_html(initial_serials.trim())}" placeholder="${__('Enter or scan single serial number (optional if not serial tracked)')}">
            </div>
        `;
    } else {
        content_html += `
            <div class="pba-generator-box">
                <span style="font-size: 11px; font-weight: 600; color: #475569;">${__('Quick Generator:')}</span>
                <input type="text" id="pba_gen_prefix" placeholder="${__('Prefix (e.g. SN-')}" style="width: 110px; border: 1px solid #cbd5e1; border-radius: 4px;">
                <input type="number" id="pba_gen_start" placeholder="${__('Start # (e.g. 1001)')}" style="width: 120px; border: 1px solid #cbd5e1; border-radius: 4px;">
                <button type="button" class="btn btn-xs btn-default" id="pba_btn_gen">
                    <i class="fa fa-magic"></i> ${__('Generate Serials')}
                </button>
            </div>
            <div class="form-group" style="margin-bottom: 0;">
                <textarea id="pba_input_serial" class="form-control" rows="3" placeholder="${__('Enter 1 serial number per line or comma-separated')}">${frappe.utils.escape_html(initial_serials)}</textarea>
            </div>
        `;
    }

    content_html += `</div>`;

    dialog.fields_dict.main_html.$wrapper.html(content_html);

    // Form inputs references
    let $batch_input = dialog.$wrapper.find('#pba_input_batch_id');
    let $rate_input = dialog.$wrapper.find('#pba_input_rate');
    let $mrp_input = dialog.$wrapper.find('#pba_input_mrp');
    let $mmyy_input = dialog.$wrapper.find('#pba_input_expiry_mmyy');
    let $min_input = dialog.$wrapper.find('#pba_input_min_price');
    let $expiry_feedback = dialog.$wrapper.find('#pba_expiry_feedback');
    let $serial_input = dialog.$wrapper.find('#pba_input_serial');
    let $serial_badge = dialog.$wrapper.find('#pba_serial_badge');

    // Free items references
    let $free_container = dialog.$wrapper.find('#pba_free_container');
    let $free_check = dialog.$wrapper.find('#pba_check_free_item');
    let $free_details = dialog.$wrapper.find('#pba_free_details_row');
    let $free_badge = dialog.$wrapper.find('#pba_free_scheme_badge');
    let $free_qty_input = dialog.$wrapper.find('#pba_input_free_qty');
    let $free_summary = dialog.$wrapper.find('#pba_free_summary');
    let $serial_total_qty = dialog.$wrapper.find('#pba_serial_total_qty');

    // Live update of Free Scheme Breakdown
    function update_free_summary() {
        let is_checked = $free_check.is(':checked');
        if (!is_checked) {
            $free_container.addClass('is-inactive');
            $free_details.hide();
            $free_badge.hide();
            $serial_total_qty.text(current_qty);
            update_serial_count();
            return;
        }

        $free_container.removeClass('is-inactive');
        $free_details.show();
        $free_badge.show();

        let billed_q = current_qty;
        let free_q = flt($free_qty_input.val()) || 0;
        let rate = flt($rate_input.val()) || 0;
        let total_amount = billed_q * rate;

        let summary_html = `
            <strong>${__('Free Scheme Breakdown:')}</strong><br>
            • ${__('Accepted / Billed Qty:')} <strong>${billed_q} ${stock_uom}</strong> @ ${currency} ${format_currency(rate, currency)} = <strong>${currency} ${format_currency(total_amount, currency)}</strong><br>
            • ${__('Free Quantity Column:')} <strong>+${free_q} Free</strong> (Tracked in Free Qty column, standard rate & amount preserved)<br>
            • <strong>${__('GST & Financials:')}</strong> Tax calculated cleanly on invoice amount <strong>${currency} ${format_currency(total_amount, currency)}</strong> (No rate averaging)
        `;
        $free_summary.html(summary_html);
        $serial_total_qty.text(billed_q + free_q);
        update_serial_count();
    }

    $free_check.on('change', update_free_summary);
    $free_qty_input.on('input', update_free_summary);
    $rate_input.on('input', update_free_summary);
    update_free_summary();

    // Expiry validation function: ensures NOT expired in the past
    function validate_expiry_inputs() {
        let mmyy = $mmyy_input.val().trim();
        if (!mmyy) {
            $expiry_feedback.html(`<span style="color: #64748b;">${__('Enter in MM-YY format (e.g. 08-27)')}</span>`);
            return true;
        }

        if (!/^(0[1-9]|1[0-2])-\d{2}$/.test(mmyy)) {
            $expiry_feedback.html(`<span class="text-danger"><i class="fa fa-times"></i> ${__('Must be in MM-YY format (e.g. 08-27)')}</span>`);
            return false;
        }

        let date_str = mmyy_to_date_str(mmyy);
        if (date_str && is_date_expired(date_str)) {
            $expiry_feedback.html(`<span class="text-danger" style="font-weight: 600;"><i class="fa fa-warning"></i> ${__('Expiry Date is in the past ({0}). Expired products cannot be accepted.', [date_str])}</span>`);
            return false;
        }

        $expiry_feedback.html(`<span class="text-success"><i class="fa fa-check"></i> ${__('Valid Future Expiry: {0}', [date_str])}</span>`);
        return true;
    }

    // Rate vs MRP validation: Rate must strictly be less than MRP (< MRP, not >=)
    function validate_rate_vs_mrp() {
        let r = flt($rate_input.val());
        let m = flt($mrp_input.val());
        let $feedback = dialog.$wrapper.find('#pba_rate_mrp_feedback');

        if ($rate_input.val().trim() !== '' && $mrp_input.val().trim() !== '') {
            if (m > 0 && r >= m) {
                $feedback.show().html(`<span class="text-danger" style="font-weight: 600;"><i class="fa fa-warning"></i> ${__('Billing Rate ({0} {1}) must be strictly less than Batch MRP ({0} {2}). Equal or higher rate is not allowed.', [currency, format_currency(r, currency), format_currency(m, currency)])}</span>`);
                $rate_input.addClass('pba-input-error');
                $mrp_input.addClass('pba-input-error');
                return false;
            } else if (m > 0 && r > 0) {
                let margin_pct = (((m - r) / m) * 100).toFixed(1);
                $feedback.show().html(`<span class="text-success"><i class="fa fa-check"></i> ${__('Valid Rate: Margin is {0}% below MRP.', [margin_pct])}</span>`);
                $rate_input.removeClass('pba-input-error');
                $mrp_input.removeClass('pba-input-error');
                return true;
            }
        }
        $feedback.hide();
        $rate_input.removeClass('pba-input-error');
        $mrp_input.removeClass('pba-input-error');
        return true;
    }

    $rate_input.on('input', validate_rate_vs_mrp);
    $mrp_input.on('input', validate_rate_vs_mrp);

    // Initial check
    validate_rate_vs_mrp();
    validate_expiry_inputs();

    $mmyy_input.on('input', function() {
        validate_expiry_inputs();
    });

    // Existing batches search
    dialog.$wrapper.find('#pba_search_existing').on('input', function() {
        let term = $(this).val().toLowerCase();
        dialog.$wrapper.find('#pba_table_existing tbody tr.pba-batch-row').each(function() {
            let text = $(this).text().toLowerCase();
            $(this).toggle(text.indexOf(term) > -1);
        });
    });

    // Select existing batch row click handler (fills inputs instantly on same page)
    dialog.$wrapper.find('#pba_table_existing .pba-batch-row').on('click', function(e) {
        let idx = cint($(this).attr('data-index'));
        let b = batches[idx];
        if (!b) return;

        if (b.is_expired) {
            frappe.show_alert({
                message: __('Batch <b>{0}</b> is expired ({1}) and cannot be selected for purchase.', [b.batch_id, b.expiry_formatted || b.expiry_date]),
                indicator: 'red'
            }, 4);
            return;
        }

        dialog.$wrapper.find('#pba_table_existing tbody tr').removeClass('selected-row');
        $(this).addClass('selected-row');
        dialog.$wrapper.find('#pba_table_existing .pba-btn-pick').not('.pba-btn-pick-disabled').removeClass('is-selected').html(`<i class="fa fa-arrow-down"></i> ${__('Use This')}`);
        $(this).find('.pba-btn-pick').addClass('is-selected').html(`<i class="fa fa-check"></i> ${__('Selected')}`);

        // Populate fields in direct form on the same page
        $batch_input.val(b.batch_id);
        if (b.last_purchase_rate > 0) $rate_input.val(b.last_purchase_rate);
        if (b.mrp > 0) $mrp_input.val(b.mrp);
        if (b.expiry_mm_yy) {
            $mmyy_input.val(b.expiry_mm_yy);
        } else if (b.expiry_date) {
            let d = new Date(b.expiry_date);
            let m = d.getMonth() + 1;
            let y = d.getFullYear().toString().slice(-2);
            $mmyy_input.val(`${m < 10 ? '0' + m : m}-${y}`);
        }
        if (b.minimum_selling_price > 0) $min_input.val(b.minimum_selling_price);

        validate_expiry_inputs();
        validate_rate_vs_mrp();
        update_free_summary();

        frappe.show_alert({
            message: __('Populated Batch <b>{0}</b> details into form below', [b.batch_id]),
            indicator: 'blue'
        }, 2);
    });

    // Serial counter logic
    function update_serial_count() {
        let is_checked = $free_check.is(':checked');
        let total_units = current_qty + (is_checked ? (flt($free_qty_input.val()) || 0) : 0);
        let raw = $serial_input.val().trim();
        let count = 0;
        if (raw) {
            if (total_units === 1) {
                count = 1;
            } else {
                let lines = raw.replace(/,/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
                count = lines.length;
            }
        }
        $serial_badge.text(`${count} / ${total_units} ${__('entered')}`);
        if (count === total_units) {
            $serial_badge.removeClass('pba-counter-warn').addClass('pba-counter-ok');
        } else {
            $serial_badge.removeClass('pba-counter-ok').addClass('pba-counter-warn');
        }
    }

    $serial_input.on('input', update_serial_count);
    update_serial_count();

    // Auto generator handler
    dialog.$wrapper.find('#pba_btn_gen').on('click', function() {
        let is_checked = $free_check.is(':checked');
        let total_units = current_qty + (is_checked ? (flt($free_qty_input.val()) || 0) : 0);
        let prefix = dialog.$wrapper.find('#pba_gen_prefix').val().trim();
        let start_num = cint(dialog.$wrapper.find('#pba_gen_start').val());
        if (start_num <= 0) start_num = 1;

        let items = [];
        for (let i = 0; i < total_units; i++) {
            items.push(`${prefix}${start_num + i}`);
        }
        $serial_input.val(items.join('\n'));
        update_serial_count();
    });

    // Support keyboard Enter to submit form instantly
    dialog.$wrapper.find('input').on('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            apply_to_row();
        }
    });

    // Apply to Row (NO premature DB insertion! Batch is saved only when invoice is submitted)
    function apply_to_row() {
        row.__pba_applying = true;

        let batch_id = $batch_input.val().trim();
        let rate_val = flt($rate_input.val());
        let mrp = flt($mrp_input.val());
        let mmyy = $mmyy_input.val().trim();
        let min_price = flt($min_input.val());

        if (!batch_id) {
            frappe.msgprint(__('Batch Number is required.'));
            $batch_input.focus();
            row.__pba_applying = false;
            return;
        }

        if ($rate_input.val().trim() !== '' && rate_val < 0) {
            frappe.msgprint(__('Billing / Purchase Rate cannot be negative.'));
            $rate_input.focus();
            row.__pba_applying = false;
            return;
        }

        if (mrp <= 0) {
            frappe.msgprint(__('Batch MRP must be greater than 0.'));
            $mrp_input.focus();
            row.__pba_applying = false;
            return;
        }

        // Strict Validation: Billing Rate must always be strictly less than MRP (cannot be >= MRP)
        if (rate_val > 0 && mrp > 0 && rate_val >= mrp) {
            frappe.msgprint({
                title: __('Rate Exceeds or Equals MRP'),
                indicator: 'red',
                message: __('Billing / Purchase Rate (<b>{0} {1}</b>) must always be <b>strictly less than</b> Batch MRP (<b>{0} {2}</b>).<br><strong>Equal or higher rates are not permitted.</strong>', [currency, format_currency(rate_val, currency), format_currency(mrp, currency)])
            });
            $rate_input.focus();
            row.__pba_applying = false;
            return;
        }

        // Strict Expiry Validation: Cannot be empty, invalid, or expired in the past
        if (!mmyy) {
            frappe.msgprint(__('Expiry Date is required in MM-YY format (e.g. 08-27).'));
            $mmyy_input.focus();
            row.__pba_applying = false;
            return;
        }

        if (!/^(0[1-9]|1[0-2])-\d{2}$/.test(mmyy)) {
            frappe.msgprint(__('Expiry Date must be in valid MM-YY format (Example: 08-27).'));
            $mmyy_input.focus();
            row.__pba_applying = false;
            return;
        }

        let calculated_date = mmyy_to_date_str(mmyy);
        if (is_date_expired(calculated_date)) {
            frappe.msgprint({
                title: __('Expired Date Not Allowed'),
                indicator: 'red',
                message: __('The Expiry Date ({0}) is already expired or in the past.<br><strong>Purchases cannot accept expired products.</strong> Please enter a future expiry date.', [mmyy])
            });
            $mmyy_input.focus();
            row.__pba_applying = false;
            return;
        }

        let is_free_checked = $free_check.is(':checked');
        let free_qty = is_free_checked ? flt($free_qty_input.val()) : 0;
        if (is_free_checked && free_qty <= 0) {
            frappe.msgprint(__('Please specify a valid Free Quantity greater than 0.'));
            $free_qty_input.focus();
            row.__pba_applying = false;
            return;
        }

        let billed_qty = current_qty;
        let total_stock_units = is_free_checked ? (billed_qty + free_qty) : billed_qty;

        // Serial Number Handling
        let raw_serials = $serial_input.val().trim();
        let serials_formatted = '';
        if (raw_serials) {
            let lines = raw_serials.replace(/,/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
            if (data.has_serial_tracking && lines.length !== total_stock_units && lines.length !== billed_qty) {
                frappe.msgprint(__('Entered {0} serial numbers, but quantity is {1}. Please match the serial count.', [lines.length, billed_qty]));
                row.__pba_applying = false;
                return;
            }
            serials_formatted = lines.join('\n');
        } else if (data.has_serial_tracking) {
            frappe.msgprint(__('Serial Numbers are required for this item (Quantity: {0}).', [billed_qty]));
            $serial_input.focus();
            row.__pba_applying = false;
            return;
        }

        // Set handle key before modifying fields to lock out duplicate popup trigger
        row.__pba_handled_key = `${item_code}_${billed_qty}`;

        // Write directly to Purchase Invoice Item row fields
        let batch_field = field_map.batch_field || 'batch_no';
        let rate_field = field_map.rate_field || 'rate';
        let mrp_field = field_map.mrp_field;
        let expiry_field = field_map.expiry_field;
        let expiry_type = field_map.expiry_fieldtype || 'Data';
        let min_field = field_map.min_price_field;
        let serial_field = field_map.serial_field || 'serial_no';
        let free_field = field_map.free_qty_field || 'custom_free_qty';
        let billed_q_field = field_map.billed_qty_field || 'custom_billed_qty';
        let billed_r_field = field_map.billed_rate_field || 'custom_billed_rate';

        // 1. Single-Row Free Quantity & Billed Quantity Columns
        if (free_field && frappe.meta.has_field(cdt, free_field)) {
            frappe.model.set_value(cdt, cdn, free_field, is_free_checked ? free_qty : 0);
        }
        if (billed_q_field && frappe.meta.has_field(cdt, billed_q_field)) {
            frappe.model.set_value(cdt, cdn, billed_q_field, billed_qty);
        }
        if (billed_r_field && frappe.meta.has_field(cdt, billed_r_field) && rate_val > 0) {
            frappe.model.set_value(cdt, cdn, billed_r_field, rate_val);
        }

        // Keep row accepted / billed quantity as exact entered qty (e.g. 20)
        frappe.model.set_value(cdt, cdn, 'qty', billed_qty);

        // 2. Batch Number
        if (batch_field && frappe.meta.has_field(cdt, batch_field)) {
            frappe.model.set_value(cdt, cdn, batch_field, batch_id);
        }
        
        let is_existing_batch = batches.some(b => b.batch_id === batch_id || b.name === batch_id);
        let matched_batch_name = is_existing_batch ? batches.find(b => b.batch_id === batch_id || b.name === batch_id)?.name : null;

        if (is_existing_batch) {
            if (frappe.meta.has_field(cdt, 'batch_no')) {
                frappe.model.set_value(cdt, cdn, 'batch_no', matched_batch_name || batch_id);
            }
        } else if (batch_field === 'batch_no') {
            frappe.model.set_value(cdt, cdn, 'batch_no', batch_id);
        }

        // 3. Billing / Purchase Rate (exact entered purchase rate, NO rate averaging)
        if ($rate_input.val().trim() !== '' && rate_field && frappe.meta.has_field(cdt, rate_field)) {
            frappe.model.set_value(cdt, cdn, rate_field, rate_val);
            if (frappe.meta.has_field(cdt, 'price_list_rate')) {
                frappe.model.set_value(cdt, cdn, 'price_list_rate', rate_val);
            }
        }

        // 4. MRP
        if (mrp_field && frappe.meta.has_field(cdt, mrp_field)) {
            frappe.model.set_value(cdt, cdn, mrp_field, mrp);
        }

        // 5. Expiry Date (MM-YY if Data field, or YYYY-MM-DD if Date field)
        let expiry_val = (expiry_type === 'Date') ? calculated_date : mmyy;
        if (expiry_field && frappe.meta.has_field(cdt, expiry_field)) {
            frappe.model.set_value(cdt, cdn, expiry_field, expiry_val);
        }

        // 6. Minimum Selling Price
        if (min_field && frappe.meta.has_field(cdt, min_field) && min_price > 0) {
            frappe.model.set_value(cdt, cdn, min_field, min_price);
        }

        // 7. Serial Numbers
        if (serials_formatted) {
            if (serial_field && frappe.meta.has_field(cdt, serial_field)) {
                frappe.model.set_value(cdt, cdn, serial_field, serials_formatted);
            }
            if (serial_field !== 'serial_no' && frappe.meta.has_field(cdt, 'serial_no')) {
                frappe.model.set_value(cdt, cdn, 'serial_no', serials_formatted);
            }
        }

        // ERPNext v16 inline serial/batch flag
        if (frappe.meta.has_field(cdt, 'use_serial_batch_fields')) {
            frappe.model.set_value(cdt, cdn, 'use_serial_batch_fields', 1);
        }

        // 8. Clean up any legacy companion free rows so only 1 row exists
        let companion_row = (frm.doc.items || []).find(r => r.is_free_item && (r.__pba_parent_cdn === cdn || (r.item_code === item_code && r[batch_field] === batch_id)));
        if (companion_row) {
            frappe.model.clear_doc(companion_row.doctype, companion_row.name);
            frm.doc.items = (frm.doc.items || []).filter(r => r.name !== companion_row.name);
        }

        // Refresh grid UI so user sees updated values immediately
        if (frm && frm.refresh_field) {
            frm.refresh_field('items');
        }

        let alert_parts = [];
        if (rate_val > 0) {
            alert_parts.push(`Rate: ${currency} ${format_currency(rate_val, currency)}`);
        }
        alert_parts.push(`MRP: ${currency} ${format_currency(mrp, currency)}`);
        alert_parts.push(`Exp: ${mmyy}`);
        if (is_free_checked && free_qty > 0) {
            alert_parts.push(`+${free_qty} Free`);
        }

        frappe.show_alert({
            message: __('Row {0}: Applied Batch <b>{1}</b> ({2})', [row.idx || 1, batch_id, alert_parts.join(', ')]),
            indicator: 'green'
        }, 3);

        window.__pba_active_dialog = false;
        dialog.hide();

        setTimeout(() => {
            row.__pba_applying = false;
        }, 600);

        // Keyboard Navigation: Focus current row's MRP/Rate column without triggering Frappe's auto-add-row
        setTimeout(() => {
            let grid = frm.fields_dict.items?.grid;
            if (grid && row) {
                let grid_row = grid.grid_rows_by_docname[row.name];
                if (grid_row) {
                    if (typeof grid_row.toggle_editable_row === 'function') {
                        grid_row.toggle_editable_row(true);
                    }
                    let $row_wrapper = grid.wrapper.find(`.grid-row[data-name="${row.name}"]`);
                    if ($row_wrapper.length) {
                        let $target = $row_wrapper.find('input[data-fieldname="custom_mrp"], input[data-fieldname="mrp"], input[data-fieldname="rate"]').first();
                        if (!$target.length) {
                            $target = $row_wrapper.find('input:visible:enabled').last();
                        }
                        if ($target.length) {
                            $target.focus().select();
                        }
                    }
                }
            }
        }, 120);
    }

    dialog.show();
}

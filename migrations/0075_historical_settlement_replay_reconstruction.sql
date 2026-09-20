-- Custom SQL migration file, put you code below! --
-- 1. Reconstruct legacy income settlement batch revisions receipt_amount as of batch revision creation time
UPDATE income_settlement_batch_revisions isbr
SET receipt_amount = COALESCE(
  (
    SELECT ir.amount::text
    FROM income_receipt_revisions ir
    JOIN income_settlement_batches isb ON isb.income_receipt_id = ir.income_receipt_id
    WHERE isb.id = isbr.settlement_batch_id
      AND ir.created_at <= isbr.created_at
    ORDER BY ir.revision_no DESC
    LIMIT 1
  ),
  (
    SELECT ir.amount::text
    FROM income_receipt_revisions ir
    JOIN income_settlement_batches isb ON isb.income_receipt_id = ir.income_receipt_id
    WHERE isb.id = isbr.settlement_batch_id
    ORDER BY ir.revision_no ASC
    LIMIT 1
  ),
  '0.00'
);

-- 2. Reconstruct snapshot_allocations with historical as-of entitlementAmount and exact historical outstanding calculation
UPDATE income_settlement_batch_revisions isbr
SET snapshot_allocations = (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'entitlementId', elem->>'entitlementId',
      'allocatedAmount', elem->>'amount',
      'periodMonth', COALESCE(ie.period_month::text, ''),
      'entitlementAmount', COALESCE(hist_ent.amount_text, '0.00'),
      'entitlementOutstandingAfterAllReceipts', (
        GREATEST(
          0.00,
          COALESCE(hist_ent.amount_numeric, 0.00) - COALESCE(alloc_history.total_alloc_as_of, (elem->>'amount')::numeric)
        )::numeric(18,2)
      )::text
    )
  ), '[]'::jsonb)
  FROM jsonb_array_elements(isbr.allocations) elem
  LEFT JOIN income_entitlements ie ON ie.id = (elem->>'entitlementId')::uuid
  LEFT JOIN LATERAL (
    SELECT
      ier.amount::text AS amount_text,
      ier.amount::numeric AS amount_numeric
    FROM income_entitlement_revisions ier
    WHERE ier.entitlement_id = ie.id
      AND ier.created_at <= isbr.created_at
    ORDER BY ier.revision_no DESC
    LIMIT 1
  ) hist_ent ON true
  LEFT JOIN LATERAL (
    WITH prior_active_batches AS (
      SELECT DISTINCT ON (b_rev.settlement_batch_id)
        b_rev.settlement_batch_id,
        b_rev.allocations
      FROM income_settlement_batch_revisions b_rev
      WHERE b_rev.user_id = isbr.user_id
        AND (b_rev.created_at < isbr.created_at OR (b_rev.created_at = isbr.created_at AND b_rev.id <= isbr.id))
      ORDER BY b_rev.settlement_batch_id, b_rev.revision_no DESC
    )
    SELECT SUM((p_elem->>'amount')::numeric) AS total_alloc_as_of
    FROM prior_active_batches pab,
    jsonb_array_elements(pab.allocations) p_elem
    WHERE (p_elem->>'entitlementId') = (elem->>'entitlementId')
  ) alloc_history ON true
);

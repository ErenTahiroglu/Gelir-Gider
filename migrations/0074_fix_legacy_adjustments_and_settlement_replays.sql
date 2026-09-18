-- Custom SQL migration file, put you code below! --
-- 1. Backfill legacy unapplied month close adjustments where remaining_amount was defaulted to 0.00 in 0073
UPDATE month_close_adjustments
SET remaining_amount = adjustment_amount
WHERE applied_in_month_close_id IS NULL AND remaining_amount = 0.00;

-- 2. Backfill legacy income settlement batch revisions where receipt_amount is NULL
UPDATE income_settlement_batch_revisions isbr
SET receipt_amount = (
  SELECT ir.amount
  FROM income_receipt_revisions ir
  JOIN income_settlement_batches isb ON isb.income_receipt_id = ir.income_receipt_id
  WHERE isb.id = isbr.settlement_batch_id
  ORDER BY ir.revision_no ASC
  LIMIT 1
)
WHERE isbr.receipt_amount IS NULL;

-- 3. Backfill legacy income settlement batch revisions where snapshot_allocations is NULL
UPDATE income_settlement_batch_revisions isbr
SET snapshot_allocations = (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'entitlementId', elem->>'entitlementId',
      'allocatedAmount', elem->>'amount',
      'periodMonth', COALESCE(ie.period_month, ''),
      'entitlementAmount', COALESCE(ier.amount, '0.00'),
      'entitlementOutstandingAfterAllReceipts', '0.00'
    )
  ), '[]'::jsonb)
  FROM jsonb_array_elements(isbr.allocations) elem
  LEFT JOIN income_entitlements ie ON ie.id = (elem->>'entitlementId')::uuid
  LEFT JOIN LATERAL (
    SELECT amount FROM income_entitlement_revisions
    WHERE entitlement_id = ie.id
    ORDER BY revision_no DESC
    LIMIT 1
  ) ier ON true
)
WHERE isbr.snapshot_allocations IS NULL;

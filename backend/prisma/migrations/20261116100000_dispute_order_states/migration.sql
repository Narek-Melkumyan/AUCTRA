-- A demo-completed order may be disputed and, if the buyer wins, cancelled. Previously the
-- CHECK only allowed COMPLETED once demoCompletedAt was set, so opening a dispute on a
-- completed demo order failed. The guarantee that a demo completion never implies a real
-- payment (paidAt stays NULL) is unchanged.
ALTER TABLE "orders" DROP CONSTRAINT "orders_demo_completion_chk";
ALTER TABLE "orders" ADD CONSTRAINT "orders_demo_completion_chk" CHECK (
  "demoCompletedAt" IS NULL OR (
    "paidAt" IS NULL AND "status" IN ('COMPLETED', 'DISPUTED', 'CANCELLED')
  )
);

-- At most one active (open or under review) dispute per order, enforced by the database so
-- two concurrent requests cannot both open one.
CREATE UNIQUE INDEX "disputes_one_active_per_order"
  ON "disputes" ("orderId")
  WHERE "status" IN ('OPEN', 'UNDER_REVIEW');

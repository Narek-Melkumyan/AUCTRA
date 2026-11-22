-- A simulated row is exactly a DEMO-provider row, so demo data can never pass for a real charge.
ALTER TABLE "payment_intents"
  ADD CONSTRAINT "payment_intents_simulated_chk" CHECK ("simulated" = ("provider" = 'DEMO'));
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_simulated_chk" CHECK ("simulated" = ("provider" IS NOT DISTINCT FROM 'DEMO'));
-- A demo-completed order is COMPLETED and was never marked paid by a real provider.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_demo_completion_chk" CHECK (
    "demoCompletedAt" IS NULL OR ("status" = 'COMPLETED' AND "paidAt" IS NULL)
  );

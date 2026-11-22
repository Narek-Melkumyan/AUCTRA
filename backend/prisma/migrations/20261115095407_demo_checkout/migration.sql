-- AlterEnum
ALTER TYPE "PaymentProvider" ADD VALUE 'DEMO';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "demoCompletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "fulfillmentMethod" "FulfillmentMethod",
ADD COLUMN     "shippingAddress" JSONB;

-- AlterTable
ALTER TABLE "payment_intents" ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false;

import "dotenv/config";
import { migrateDatabase } from "./migrations.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be configured to run database migrations.");
}

try {
  await migrateDatabase(databaseUrl);
  console.log("Database migrations are up to date.");
} catch (error) {
  console.error("Could not run database migrations:", error);
  process.exitCode = 1;
}

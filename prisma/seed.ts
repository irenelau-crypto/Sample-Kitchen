import { PrismaClient } from "@prisma/client";
import scenario from "../reference-data/scenario.json";
import productsAndRecipes from "../reference-data/products_and_recipes.json";
import supplier from "../reference-data/supplier.json";

const prisma = new PrismaClient();

async function main() {
  const seeds = [
    ["scenario", scenario],
    ["products_and_recipes", productsAndRecipes],
    ["supplier", supplier],
  ] as const;

  for (const [key, value] of seeds) {
    await prisma.referenceData.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });

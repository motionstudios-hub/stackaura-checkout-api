require("dotenv").config();
const argon2 = require("argon2");
const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");

(async () => {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;

  if (!url) {
    console.error("Missing DIRECT_URL or DATABASE_URL");
    process.exit(1);
  }

  const merchantId = process.env.MERCHANT_ID;
  const email = process.env.EMAIL || "admin@stackaura.com";
  const password = process.env.PASSWORD || "ChangeMe123!";

  if (!merchantId) throw new Error("Missing MERCHANT_ID");

  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const passwordHash = await argon2.hash(password);

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
    },
  });

  await prisma.membership.upsert({
    where: {
      userId_merchantId: {
        userId: user.id,
        merchantId,
      },
    },
    update: { role: "OWNER" },
    create: {
      userId: user.id,
      merchantId,
      role: "OWNER",
    },
  });

  console.log("✅ Admin user ready:", email);
  console.log("✅ Merchant linked:", merchantId);

  await prisma.$disconnect();
  await pool.end();
})();

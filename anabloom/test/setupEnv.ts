// Point Prisma at a throwaway SQLite test DB before any prisma import.
process.env.DATABASE_URL = "file:./test.db";
process.env.DIRECT_URL = "file:./test.db";

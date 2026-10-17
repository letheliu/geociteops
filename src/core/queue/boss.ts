import PgBoss from 'pg-boss'

export type Queue = PgBoss

export async function createQueue(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL! })
  await boss.start()
  return boss
}

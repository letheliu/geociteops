import { PrismaClient } from '@prisma/client'

let client: PrismaClient | null = null

export function getPrismaClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient()
  }
  return client
}

export function resetPrismaClient(): void {
  client = null
}

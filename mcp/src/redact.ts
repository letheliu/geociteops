/** Replace a presented secret so logs and HTTP bodies cannot echo it. */
export function redactSecret(message: string, secret: string | null | undefined): string {
  if (!secret || secret.length < 8) return message
  if (!message.includes(secret)) return message
  return message.split(secret).join('[redacted]')
}

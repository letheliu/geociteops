/** 会话 Cookie 默认名：__Host- 前缀强制 Secure + 不带 Domain + Path=/ */
export const SESSION_COOKIE_DEFAULT_NAME = '__Host-geo_sid'

function cookieName(): string {
  return process.env.GEO_COOKIE_NAME || SESSION_COOKIE_DEFAULT_NAME
}

/**
 * 序列化登录会话 Cookie（`Set-Cookie` 值）。
 * 五个属性：HttpOnly / Secure / SameSite=Lax / Path=/（名=token 之外共 4 个属性 + 值）。
 */
export function serializeSessionCookie(token: string): string {
  return `${cookieName()}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/`
}

/** 序列化登出清除 Cookie：同名 + Max-Age=0（其余属性保持一致以可靠覆盖） */
export function clearSessionCookie(): string {
  return `${cookieName()}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

/**
 * 对比 agent2api 与 wb2api 手里同一批 WorkBuddy 账号的令牌，判断是否已经分叉。
 *
 * 用法：AGENT2API_PASSWORD=... node script/compare-token-fork.mjs
 *
 * 背景：WorkBuddy 的 refresh token 是**轮换式**（用一次就换新）。
 * 两个网关拿同一批账号时，谁先刷新谁作废对方手里的那把 —— 这个脚本给出
 * 「两边 refreshToken 是否已不同」的直接证据。
 */

import { createHash } from 'node:crypto'

const BASE = (process.env.AGENT2API_BASE || 'http://43.139.52.59:30665').replace(/\/+$/, '')
const PASSWORD = process.env.AGENT2API_PASSWORD || ''
if (!PASSWORD) throw new Error('缺少 AGENT2API_PASSWORD')

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

async function login() {
  const challenge = await (await fetch(`${BASE}/api/panel/captcha`)).json()
  const target = String(challenge.challenge).toLowerCase()
  const salt = String(challenge.salt)
  let number = 0
  for (let n = 0; n <= Number(challenge.maxnumber); n += 1) {
    if (sha256(salt + n) === target) { number = n; break }
  }
  const captcha = Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm, challenge: challenge.challenge,
    number, salt: challenge.salt, signature: challenge.signature,
  })).toString('base64')
  const response = await fetch(`${BASE}/api/panel/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD, captcha }),
  })
  if (!response.ok) throw new Error(`登录失败: HTTP ${response.status} ${await response.text()}`)
  return response.headers.getSetCookie().map((line) => line.split(';', 1)[0]).join('; ')
}

const cookie = await login()
const response = await fetch(`${BASE}/api/accounts/export`, { headers: { cookie } })
const body = await response.json()
const accounts = body?.data?.accounts || body?.accounts || []
if (!Array.isArray(accounts) || accounts.length === 0) {
  throw new Error(`导出未拿到账号: ${JSON.stringify(body).slice(0, 300)}`)
}
for (const account of accounts.filter((item) => item.provider === 'workbuddy')) {
  console.log(
    [
      account.id.slice(5, 13),
      'at=' + (account.accessToken || '').slice(-16),
      'rt=' + (account.refreshToken || '').slice(-24),
      'exp=' + (account.expiresAt ? new Date(Number(account.expiresAt)).toISOString() : 'none'),
    ].join('  '),
  )
}

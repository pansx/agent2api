/**
 * 复现面板会话失效：登录后连续两次 `/api/panel/refresh`，观察第二次是否
 * 触发重放检测把整条会话链作废。
 *
 * 用法：AGENT2API_PASSWORD=... node script/probe-panel-session.mjs
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
  const cookies = response.headers.getSetCookie().map((line) => line.split(';', 1)[0])
  console.log('登录成功，Set-Cookie 条数 =', cookies.length)
  for (const cookie of cookies) console.log('   ', cookie.slice(0, 60) + '…')
  return cookies.join('; ')
}

const cookie = await login()
console.log()

async function probe(label, headers) {
  const response = await fetch(`${BASE}/api/panel/refresh`, { method: 'POST', headers })
  const text = await response.text()
  console.log(`${label}: HTTP ${response.status} ${text.slice(0, 120)}`)
  const setCookies = response.headers.getSetCookie()
  return { status: response.status, setCookies }
}

// ① 正常续期：带登录时的 cookie
const first = await probe('① 首次 refresh（带原 cookie）', { cookie })
console.log('   Set-Cookie 条数 =', first.setCookies.length)

// ② 同一把 cookie 再刷一次：模拟多标签页并发续期
await probe('② 同一 cookie 再 refresh（模拟并发）', { cookie })

// ③ 用第①次返回的新 cookie 试试还活着没
if (first.setCookies.length > 0) {
  const rotated = first.setCookies.map((line) => line.split(';', 1)[0]).join('; ')
  await probe('③ 用①轮换出的新 cookie refresh', { cookie: rotated })
}

// ④ 原 cookie 是否彻底作废（会话链是否被整链撤销）
await probe('④ 再用原 cookie refresh', { cookie })

/**
 * 部署后核对：版本、账号数量（按 provider）、面板会话可用性。
 * 用法：AGENT2API_PASSWORD=... node script/verify-deploy.mjs
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
  if (!response.ok) throw new Error(`登录失败: HTTP ${response.status}`)
  return response.headers.getSetCookie().map((line) => line.split(';', 1)[0]).join('; ')
}

const cookie = await login()
const json = async (path) => {
  const response = await fetch(`${BASE}${path}`, { headers: { cookie } })
  return response.json()
}

const upgrade = await json('/api/upgrade')
const current = upgrade?.data?.current || upgrade?.data?.version || upgrade?.current || upgrade?.version
console.log('版本信息:', JSON.stringify(current ?? upgrade?.data ?? upgrade).slice(0, 220))

const accounts = await json('/api/accounts')
const list = Array.isArray(accounts?.data) ? accounts.data : accounts?.data?.accounts || []
const byProvider = new Map()
for (const item of list) {
  const key = item.provider || 'workbuddy(默认)'
  byProvider.set(key, (byProvider.get(key) || 0) + 1)
}
console.log('账号总数:', list.length)
for (const [key, count] of [...byProvider.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key}: ${count}`)
}

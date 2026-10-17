/**
 * 一次性迁移脚本：把 workbuddy2api（wb2api）导出的账号 JSON 导入 Agent2API。
 *
 * 用法：
 *   AGENT2API_PASSWORD=... node script/import-wb2api-accounts.mjs
 *
 * 可选环境变量：
 *   AGENT2API_BASE   面板地址，默认 http://43.139.52.59:30665
 *   AGENT2API_USER   管理员账号，默认 admin
 *   AUTH_DIR         凭证文件目录，默认 script/.auths-tmp
 *
 * 做的事：
 *   1. 解 ALTCHA 题（sha256(salt+number) === challenge）换取登录会话 cookie；
 *   2. 逐个文件 POST /api/accounts，payload = 文件内容 + provider:"workbuddy"
 *      （与面板「导入凭证文件」同一入口、同一形状）；
 *   3. expiresAt 从秒归一化成毫秒 —— wb2api 写的是秒，Agent2API 按毫秒判过期。
 */

import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const BASE = (process.env.AGENT2API_BASE || 'http://43.139.52.59:30665').replace(/\/+$/, '')
const USER = process.env.AGENT2API_USER || 'admin'
const PASSWORD = process.env.AGENT2API_PASSWORD || ''
const AUTH_DIR = process.env.AUTH_DIR || 'script/.auths-tmp'

if (!PASSWORD) {
  console.error('缺少 AGENT2API_PASSWORD')
  process.exit(2)
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

async function solveCaptcha() {
  const response = await fetch(`${BASE}/api/panel/captcha`)
  if (!response.ok) throw new Error(`领题失败: HTTP ${response.status}`)
  const challenge = await response.json()
  const target = String(challenge.challenge || '').toLowerCase()
  const salt = String(challenge.salt || '')
  const max = Number(challenge.maxnumber) || 0
  for (let n = 0; n <= max; n += 1) {
    if (sha256(salt + n) === target) {
      return Buffer.from(
        JSON.stringify({
          algorithm: challenge.algorithm,
          challenge: challenge.challenge,
          number: n,
          salt: challenge.salt,
          signature: challenge.signature,
        }),
      ).toString('base64')
    }
  }
  throw new Error(`未找到答案（maxnumber=${max}）`)
}

async function login() {
  const captcha = await solveCaptcha()
  const response = await fetch(`${BASE}/api/panel/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD, captcha }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`登录失败: HTTP ${response.status} ${text.slice(0, 200)}`)
  const cookies = response.headers.getSetCookie().map((line) => line.split(';', 1)[0])
  if (cookies.length === 0) throw new Error('登录成功但未拿到会话 cookie')
  return cookies.join('; ')
}

/** wb2api 写秒，Agent2API 按毫秒判过期；只归一化“看起来是秒”的正数 */
function normalizeSeconds(value) {
  return typeof value === 'number' && value > 0 && value < 1e11 ? value * 1000 : value
}

function normalizeAuth(auth) {
  if (!auth || typeof auth !== 'object') return auth
  const normalized = { ...auth }
  for (const key of ['expiresAt', 'refreshExpiresAt', 'expires_at', 'refresh_expires_at']) {
    if (key in normalized) normalized[key] = normalizeSeconds(normalized[key])
  }
  return normalized
}

async function postAccount(cookie, payload) {
  const response = await fetch(`${BASE}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.success === false) {
    const reason = data?.error?.message || data?.message || JSON.stringify(data).slice(0, 200)
    throw new Error(`HTTP ${response.status}: ${reason}`)
  }
  return data?.data
}

async function listAccounts(cookie) {
  const response = await fetch(`${BASE}/api/accounts`, { headers: { cookie } })
  const data = await response.json()
  if (!response.ok || data.success === false) throw new Error(`读取账号列表失败: HTTP ${response.status}`)
  return data.data
}

const cookie = await login()
console.log('登录成功，会话已建立')

if (process.env.LIST_ONLY === '1') {
  const response = await fetch(`${BASE}/api/accounts`, { headers: { cookie } })
  const data = await response.json()
  const accounts = Array.isArray(data?.data) ? data.data : data?.data?.accounts || []
  for (const item of accounts) {
    console.log(
      [
        item.id,
        item.provider,
        item.name || item.nickname || '',
        item.expiresAt ? new Date(Number(item.expiresAt)).toISOString() : 'no-expiry',
        item.hasRefreshToken ? 'refresh' : 'no-refresh',
      ].join(' | '),
    )
  }
  console.log(`共 ${accounts.length} 条`)
  process.exit(0)
}

const files = (await readdir(AUTH_DIR)).filter((name) => name.endsWith('.json')).sort()
if (files.length === 0) throw new Error(`目录里没有凭证文件: ${AUTH_DIR}`)

let ok = 0
const failed = []
for (const file of files) {
  try {
    const parsed = JSON.parse(await readFile(join(AUTH_DIR, file), 'utf8'))
    const payload = { ...parsed, auth: normalizeAuth(parsed.auth), provider: 'workbuddy' }
    const result = await postAccount(cookie, payload)
    const account = result?.account || {}
    const nickname = account.name || account.nickname || parsed.account?.nickname || ''
    console.log(`✅ ${file} -> ${account.id || '(unknown id)'} ${nickname}`)
    ok += 1
  } catch (error) {
    console.log(`❌ ${file} -> ${error.message}`)
    failed.push({ file, reason: error.message })
  }
}

const list = await listAccounts(cookie)
console.log(`\n导入完成：成功 ${ok} / 共 ${files.length}，账号列表当前 ${Array.isArray(list) ? list.length : '?'} 条`)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const item of failed) console.log(`  - ${item.file}: ${item.reason}`)
  process.exit(1)
}

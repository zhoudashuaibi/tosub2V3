#!/usr/bin/env node
/**
 * 远端重复账号扫描 / 清理（sub2api 里同一邮箱存在多份账号）
 *
 * 由来：手动批量上传与巡检自动补号并发进入上传管线时，两边各自快照远端索引、双双判定
 * 「远端还没有这个号」，于是对同一个号各建一份。本地只关联其中一份，另一份成为仍在接流量、
 * 却永远不会被回推凭据（因此早晚挂 401）的孤儿副本。
 * 上传管线现已串行化 + 创建前二次校验（server/modules/sub2api/upload.js），
 * 本脚本用于清理历史遗留的重复。
 *
 * 用法：
 *   node scripts/dedupe-remote-accounts.mjs [--data-dir ./data] [--delete] [--include-unlinked]
 *
 * 默认 dry-run：只打印每个邮箱的重复远端 id 与将要删除的那几个。
 * 只有显式加 --delete 才会调用 DELETE /api/v1/admin/accounts/{id}。
 * 默认只清理本地账号表里存在的邮箱；--include-unlinked 连本地已无记录的孤儿一并清理。
 *
 * 保留规则：本地 sub2api_account_id 指向的那份优先保留，其次是非 error 状态，最后取最小 id。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args['data-dir'] || path.join(__dirname, '..', 'data'));
const apply = Boolean(args.delete);
const includeUnlinked = Boolean(args['include-unlinked']);

const { createCrypto } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'lib', 'crypto.js')).href);
const { createSub2apiClient } = await import(
  pathToFileURL(path.join(__dirname, '..', 'server', 'modules', 'sub2api', 'client.js')).href
);

// 只读打开：脚本不写库、不跑迁移，可以对正在运行的实例直接执行
const dbPath = path.join(dataDir, 'tosub2.db');
if (!fs.existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}（用 --data-dir 指向实例的 data 目录）`);
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
const crypto = createCrypto({ dataDir, secretKeyEnv: process.env.TOSUB2_SECRET_KEY || '' });

function getConfig() {
  const row = db.prepare('SELECT value, encrypted FROM settings WHERE key = ?').get('sub2api.config');
  if (!row) return null;
  const text = row.encrypted ? crypto.decrypt(row.value, 'settings.sub2api.config') : row.value;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 保留哪一份：本地已关联 > 非 error > 最小 id。 */
function pickKeeper(copies, local) {
  const linked = Number(local?.sub2api_account_id);
  const scored = copies.map((copy) => ({
    copy,
    score: Number.isSafeInteger(linked) && linked > 0 && copy.id === linked ? 0 : copy.status === 'error' ? 2 : 1,
  }));
  scored.sort((a, b) => a.score - b.score || a.copy.id - b.copy.id);
  return scored[0].copy;
}

console.log(`远端重复账号扫描（${apply ? '删除模式' : 'dry-run'}）`);
console.log(`  data-dir: ${dataDir}`);

const config = getConfig();
if (!config?.base_url || !config?.admin_key) {
  console.error('sub2api 未配置（settings.sub2api.config 缺少 base_url / admin_key），无法扫描。');
  process.exit(1);
}
console.log(`  sub2api: ${config.base_url}`);

const client = createSub2apiClient(() => config);

const accounts = await client.listAllOpenAiAccounts();
console.log(`  远端 openai 账号：${accounts.length}`);

const byEmail = new Map();
for (const account of accounts) {
  const email = client.accountEmail(account);
  const id = Number(account?.id);
  if (!email || !Number.isSafeInteger(id) || id <= 0) continue;
  const key = email.toLowerCase();
  if (!byEmail.has(key)) byEmail.set(key, []);
  byEmail.get(key).push({ id, status: String(account.status || 'unknown'), name: String(account.name || '') });
}

const localByEmail = new Map();
for (const row of db.prepare(`SELECT id, email, pool, status, sub2api_account_id FROM accounts`).all()) {
  localByEmail.set(String(row.email || '').trim().toLowerCase(), row);
}

const groups = [...byEmail.entries()].filter(([, copies]) => copies.length > 1);
const targets = [];
for (const [email, copies] of groups) {
  const local = localByEmail.get(email) || null;
  if (!local && !includeUnlinked) continue;
  const keeper = pickKeeper(copies, local);
  targets.push({ email, local, keeper, extras: copies.filter((copy) => copy.id !== keeper.id) });
}

if (!targets.length) {
  console.log(`\n未发现需要清理的重复账号（同邮箱多份共 ${groups.length} 组）。`);
  db.close();
  process.exit(0);
}

console.log(`\n同邮箱多份共 ${groups.length} 组，其中待处理 ${targets.length} 组：\n`);
for (const target of targets) {
  const localText = target.local
    ? `本地 #${target.local.id} [${target.local.pool}/${target.local.status}] linked=${target.local.sub2api_account_id ?? '-'}`
    : '本地无记录';
  console.log(`${target.email}`);
  console.log(`  ${localText}`);
  console.log(`  保留 #${target.keeper.id} (${target.keeper.status})`);
  console.log(`  删除 ${target.extras.map((copy) => `#${copy.id}(${copy.status})`).join(' ')}`);
}

const totalExtras = targets.reduce((sum, target) => sum + target.extras.length, 0);
if (!apply) {
  console.log(`\ndry-run：共 ${totalExtras} 个孤儿副本待删除。确认无误后加 --delete 执行。`);
  console.log('若接口不支持 DELETE，请到 sub2api 后台按上面的 id 手工删除。');
  db.close();
  process.exit(0);
}

console.log(`\n开始删除 ${totalExtras} 个孤儿副本…`);
const failed = [];
let deleted = 0;
for (const target of targets) {
  for (const copy of target.extras) {
    try {
      await client.request(`/api/v1/admin/accounts/${copy.id}`, { method: 'DELETE' });
      deleted += 1;
      console.log(`  已删除 #${copy.id} (${target.email})`);
    } catch (error) {
      failed.push({ id: copy.id, email: target.email, error: String(error.message || error) });
      console.error(`  删除失败 #${copy.id} (${target.email})：${error.message || error}`);
    }
  }
}

console.log(`\n已删除 ${deleted} 个，失败 ${failed.length} 个。`);
if (failed.length) {
  console.log('失败列表（可在 sub2api 后台手工删除）：');
  for (const item of failed) console.log(`  #${item.id} ${item.email} — ${item.error}`);
}
console.log('清理后请到「主号池」点一次「远端同步」，让本地关联与远端重新对齐。');

db.close();

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

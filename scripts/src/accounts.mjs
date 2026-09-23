import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const REGISTRY_VERSION = 1;

export function validateAccountId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(value) || value === '.' || value === '..') {
    throw new Error('账号别名仅可使用 1–64 位字母、数字、点、下划线和连字符，且不能是 . 或 ..');
  }
  return value;
}

/** Store a one-way local fingerprint rather than the platform's raw sec_uid. */
export function fingerprintIdentity(secUid) {
  if (typeof secUid !== 'string' || !secUid.trim()) {
    throw new Error('创作者中心没有返回稳定账号身份，不能绑定');
  }
  return createHash('sha256').update(`douyin:${secUid.trim()}`).digest('hex');
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`无法读取账号注册表：${error?.message ?? error}`);
  }
}

async function writeJsonAtomic(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readAccountRegistry(path) {
  const registry = await readJson(path);
  if (registry === null) return { schemaVersion: REGISTRY_VERSION, accounts: [] };
  if (registry?.schemaVersion !== REGISTRY_VERSION || !Array.isArray(registry.accounts)) {
    throw new Error('账号注册表格式无法识别；为保护已有绑定，未重置文件');
  }
  for (const row of registry.accounts) {
    validateAccountId(row?.accountId);
    if (typeof row?.identityFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.identityFingerprint)) {
      throw new Error('账号注册表记录不完整；为保护已有绑定，未重置文件');
    }
  }
  return registry;
}

export async function getBoundAccount(path, accountId) {
  validateAccountId(accountId);
  const registry = await readAccountRegistry(path);
  return registry.accounts.find((row) => row.accountId === accountId) ?? null;
}

/**
 * Check alias and identity uniqueness before a staged browser profile is adopted.
 * Repeating the same binding is idempotent; changing or duplicating an identity fails closed.
 */
export async function assertAccountCanBind(path, accountId, identityFingerprint) {
  validateAccountId(accountId);
  const registry = await readAccountRegistry(path);
  const existing = registry.accounts.find((row) => row.accountId === accountId);
  if (existing && existing.identityFingerprint !== identityFingerprint) {
    throw new Error(`账号别名「${accountId}」已绑定到另一个抖音身份；登录态未替换`);
  }
  const duplicate = registry.accounts.find((row) => row.identityFingerprint === identityFingerprint && row.accountId !== accountId);
  if (duplicate) {
    throw new Error(`这个抖音身份已绑定到别名「${duplicate.accountId}」；未创建重复账号`);
  }
  return { exists: !!existing, registry };
}

export async function registerAccount(path, accountId, identityFingerprint) {
  const { exists, registry } = await assertAccountCanBind(path, accountId, identityFingerprint);
  if (exists) return registry.accounts.find((row) => row.accountId === accountId);
  const account = { accountId, identityFingerprint, boundAt: new Date().toISOString() };
  await writeJsonAtomic(path, { ...registry, accounts: [...registry.accounts, account] });
  return account;
}

/**
 * A data root belongs to one alias. Existing unscoped data is left untouched and
 * requires an explicit migration instead of being silently assigned to an account.
 */
export async function assertOutputRootAccount(root, accountId) {
  validateAccountId(accountId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const markerPath = join(root, '_account.json');
  const marker = await readJson(markerPath);
  if (marker) {
    if (marker.schemaVersion !== REGISTRY_VERSION || marker.accountId !== accountId) {
      throw new Error(`输出目录已归属其他账号，拒绝混写：${root}`);
    }
    return;
  }
  const entries = await readdir(root);
  const existing = entries.filter((name) => name !== '_account.json');
  if (existing.length) {
    throw new Error(`输出目录含有未标记的旧数据，拒绝自动归属或覆盖：${root}。请指定一个新的账号专属 --root。`);
  }
  const handle = await open(markerPath, 'wx', 0o600).catch((error) => {
    if (error?.code === 'EEXIST') return null;
    throw error;
  });
  if (!handle) {
    const current = await readJson(markerPath);
    if (current?.accountId !== accountId) throw new Error(`输出目录已归属其他账号，拒绝混写：${root}`);
    return;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: REGISTRY_VERSION, accountId }, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

/** Adopt a successfully scanned temporary profile, rolling back if registry write fails. */
export async function adoptBoundProfile({ stagingDir, authDir, registryPath, accountId, identityFingerprint }) {
  const { exists } = await assertAccountCanBind(registryPath, accountId, identityFingerprint);
  const backupDir = `${authDir}.backup-${process.pid}-${Date.now()}`;
  let backedUp = false;
  try {
    await mkdir(dirname(authDir), { recursive: true, mode: 0o700 });
    if (exists && existsSync(authDir)) {
      await rename(authDir, backupDir);
      backedUp = true;
    }
    await rename(stagingDir, authDir);
    await registerAccount(registryPath, accountId, identityFingerprint);
    if (backedUp) await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    await rm(authDir, { recursive: true, force: true }).catch(() => {});
    if (backedUp) await rename(backupDir, authDir).catch(() => {});
    throw error;
  }
}

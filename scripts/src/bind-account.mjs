import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  adoptBoundProfile,
  assertAccountCanBind,
  fingerprintIdentity,
  getBoundAccount,
  validateAccountId,
} from './accounts.mjs';

/**
 * Bind an alias to the identity returned by a clean, temporary creator-center profile.
 * The previous profile stays in place unless login, identity verification, and registry
 * checks all succeed.
 */
export async function bindDouyinAccount({
  accountId,
  authDir,
  registryPath,
  timeoutSec = 240,
  ensureProfileNotLocked,
  loginDouyinProfile,
  openProfile,
  probeSession,
  readCreatorIdentity,
}) {
  validateAccountId(accountId);
  const existingBinding = await getBoundAccount(registryPath, accountId);
  const legacyUnverifiedProfile = existsSync(authDir) && !existingBinding;
  if (existsSync(authDir)) ensureProfileNotLocked(authDir, accountId);

  const stageParent = dirname(authDir);
  await mkdir(stageParent, { recursive: true, mode: 0o700 });
  const stagingDir = await mkdtemp(join(stageParent, '.douyin-staging-'));
  try {
    const loggedIn = await loginDouyinProfile({ authDir: stagingDir, timeoutSec });
    if (!loggedIn) throw new Error('扫码超时或窗口关闭；原账号登录态未更改');

    const ctx = await openProfile({ authDir: stagingDir, headless: true });
    let identity;
    try {
      if ((await probeSession(ctx)) !== 'active') throw new Error('扫码窗口返回后会话探针未通过；原账号登录态未更改');
      identity = await readCreatorIdentity(ctx);
    } finally {
      await ctx.close().catch(() => {});
    }

    if (!identity?.secUid) throw new Error('无法从创作者中心读到稳定账号身份；未绑定或保存登录态');
    const identityFingerprint = fingerprintIdentity(identity.secUid);
    await assertAccountCanBind(registryPath, accountId, identityFingerprint);
    const alreadyBound = !!existingBinding;
    let legacyBackup = null;
    if (legacyUnverifiedProfile) {
      legacyBackup = `${authDir}.legacy-${process.pid}-${Date.now()}`;
      await rename(authDir, legacyBackup);
    }
    try {
      await adoptBoundProfile({ stagingDir, authDir, registryPath, accountId, identityFingerprint });
    } catch (error) {
      if (legacyBackup) await rename(legacyBackup, authDir).catch(() => {});
      throw error;
    }
    return { accountId, alreadyBound, nickname: identity.nickname, legacyBackup };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

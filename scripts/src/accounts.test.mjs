import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertAccountCanBind,
  assertOutputRootAccount,
  fingerprintIdentity,
  getBoundAccount,
  registerAccount,
  validateAccountId,
} from './accounts.mjs';
import { bindDouyinAccount } from './bind-account.mjs';

test('账号注册表只存稳定身份指纹，并拒绝别名或身份冲突', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moonlit account isolation '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'private', 'accounts.json');
  const fingerprintA = fingerprintIdentity('private-sec-uid-a');
  const row = await registerAccount(registry, 'account-a', fingerprintA);
  assert.equal(row.accountId, 'account-a');
  assert.equal((await getBoundAccount(registry, 'account-a')).identityFingerprint, fingerprintA);
  const stored = await readFile(registry, 'utf8');
  assert.equal(stored.includes('private-sec-uid-a'), false);
  await assert.rejects(registerAccount(registry, 'account-a', fingerprintIdentity('private-sec-uid-b')), /已绑定到另一个抖音身份/);
  await assert.rejects(registerAccount(registry, 'account-b', fingerprintA), /已绑定到别名/);
  await assert.rejects(assertAccountCanBind(registry, '../escape', fingerprintA), /账号别名/);
});

test('账号输出目录标记归属，拒绝跨账号混写和未标记旧目录', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moonlit output isolation '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const accountA = join(root, 'data', 'account-a');
  await assertOutputRootAccount(accountA, 'account-a');
  await assertOutputRootAccount(accountA, 'account-a');
  await assert.rejects(assertOutputRootAccount(accountA, 'account-b'), /拒绝混写/);

  const legacy = join(root, 'legacy');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'old-index.json'), '{}');
  await assert.rejects(assertOutputRootAccount(legacy, 'account-a'), /未标记的旧数据/);
});

test('绑定使用全新 staging profile；身份不匹配时保留旧目录', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moonlit bind recovery '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authDir = join(root, 'auth', 'account-a');
  const registryPath = join(root, 'auth', 'accounts.json');
  await mkdir(authDir, { recursive: true });
  await writeFile(join(authDir, 'keep.txt'), 'old profile');
  await registerAccount(registryPath, 'account-a', fingerprintIdentity('stable-a'));

  const deps = {
    ensureProfileNotLocked() {},
    async loginDouyinProfile({ authDir: stagingDir }) {
      await writeFile(join(stagingDir, 'new.txt'), 'new profile');
      return true;
    },
    async openProfile() { return { async close() {} }; },
    async probeSession() { return 'active'; },
    async readCreatorIdentity() { return { nickname: '另一个账号', secUid: 'stable-b' }; },
  };
  await assert.rejects(bindDouyinAccount({ accountId: 'account-a', authDir, registryPath, ...deps }), /已绑定到另一个抖音身份/);
  assert.equal(await readFile(join(authDir, 'keep.txt'), 'utf8'), 'old profile');
  assert.equal(await getBoundAccount(registryPath, 'account-a').then((r) => r.identityFingerprint), fingerprintIdentity('stable-a'));
});

test('成功绑定后才替换 profile 并登记新别名', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moonlit bind success '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authDir = join(root, 'auth', 'account-b');
  const registryPath = join(root, 'auth', 'accounts.json');
  const deps = {
    ensureProfileNotLocked() {},
    async loginDouyinProfile({ authDir: stagingDir }) {
      await writeFile(join(stagingDir, 'profile.txt'), 'verified profile');
      return true;
    },
    async openProfile() { return { async close() {} }; },
    async probeSession() { return 'active'; },
    async readCreatorIdentity() { return { nickname: '账号乙', secUid: 'stable-b' }; },
  };
  const result = await bindDouyinAccount({ accountId: 'account-b', authDir, registryPath, ...deps });
  assert.equal(result.accountId, 'account-b');
  assert.equal(await readFile(join(authDir, 'profile.txt'), 'utf8'), 'verified profile');
  assert.equal((await getBoundAccount(registryPath, 'account-b')).identityFingerprint, fingerprintIdentity('stable-b'));
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveWorkDir, writeIndex } from './layout.mjs';

test('account datasets, per-account indexes, and mapped work directories stay separate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moonlit works isolation '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worksRoot = join(root, 'creator', 'works');
  const workPath = join(worksRoot, '2026', 'W-20260923-001-example');
  await mkdir(workPath, { recursive: true });
  await writeFile(join(workPath, 'work.json'), JSON.stringify({ title: '同名作品', platformIds: { douyin: ['aweme-1'] } }));

  const accountA = join(worksRoot, 'douyin', 'account-a');
  const accountB = join(worksRoot, 'douyin', 'account-b');
  const pathA = await resolveWorkDir(accountA, 'aweme-1', '同名作品', 'account-a');
  const pathB = await resolveWorkDir(accountB, 'aweme-1', '同名作品', 'account-b');
  assert.equal(pathA, join(workPath, 'distribution', 'douyin', 'account-a'));
  assert.equal(pathB, join(workPath, 'distribution', 'douyin', 'account-b'));
  assert.notEqual(pathA, pathB);

  await writeIndex(accountA, { accountId: 'account-a', totals: { works: 1, comments: 0 }, works: [{ awemeId: 'aweme-1', title: '同名作品' }] });
  await writeIndex(accountB, { accountId: 'account-b', totals: { works: 1, comments: 0 }, works: [{ awemeId: 'aweme-1', title: '同名作品' }] });
  const indexA = JSON.parse(await readFile(join(accountA, '_index.json'), 'utf8'));
  const indexB = JSON.parse(await readFile(join(accountB, '_index.json'), 'utf8'));
  assert.equal(indexA.accountId, 'account-a');
  assert.equal(indexB.accountId, 'account-b');
  assert.match(indexA.works[0].path, /account-a/);
  assert.match(indexB.works[0].path, /account-b/);
});

test('同标题不能把作品归给别的条目；没有 awemeId 映射时进入当前账号目录', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moonlit title safety '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worksRoot = join(root, 'creator', 'works');
  const workPath = join(worksRoot, '2026', 'W-20260923-001-example');
  await mkdir(workPath, { recursive: true });
  await writeFile(join(workPath, 'work.json'), JSON.stringify({ title: '相同标题', platformIds: { douyin: ['another-aweme'] } }));
  const accountRoot = join(worksRoot, 'douyin', 'account-a');
  assert.equal(
    await resolveWorkDir(accountRoot, 'unmatched-aweme', '相同标题', 'account-a'),
    join(accountRoot, '_unassigned', 'unmatched-aweme'),
  );
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { resolveWorkDir, writeIndex, readCommentTargets, writeComments } from './layout.mjs';

test('empty interrupted refresh retains the last real comment date and stores attempt coverage', async t => {
  const root=await mkdtemp(join(tmpdir(),'moonlit old comments '));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeComments(root,{awemeId:'123',collectedAt:'2026-10-02T00:00:00Z',incomplete:false,truncatedReason:null,items:[{commentId:'a',awemeId:'123',text:'旧实际问题'}]});
  await writeComments(root,{awemeId:'123',collectedAt:'2026-10-03T00:00:00Z',incomplete:true,truncatedReason:'comment_response_not_available',items:[],coverage:{top_has_more:null,top_complete:false}});
  const stored=JSON.parse(await readFile(join(root,'comments.json'),'utf8'));
  assert.equal(stored.collectedAt,'2026-10-02T00:00:00Z');assert.equal(stored.lastAttemptAt,'2026-10-03T00:00:00Z');assert.equal(stored.items.length,1);assert.equal(stored.coverage.top_complete,false);
});

test('评论单独刷新保留作品与指标索引，空索引可按真实ID原始文件恢复', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moonlit comment targets '));
  t.after(() => rm(root, { recursive:true, force:true }));
  const data = join(root, 'main');
  const raw = join(data, '_unassigned', '123');
  await mkdir(raw, {recursive:true});
  await writeFile(join(data, '_index.json'), JSON.stringify({accountId:'main', works:[
    {awemeId:'123',title:'原题',metrics:{views:100,favorites:0}}]}));
  let targets = await readCommentTargets(data,'main',['123']);
  await writeIndex(data,{accountId:'main', totals:{works:targets.length}, works:targets});
  let index=JSON.parse(await readFile(join(data,'_index.json')));
  assert.equal(index.works.length,1);
  assert.deepEqual(index.works[0].metrics,{views:100,favorites:0});
  await writeFile(join(data,'_index.json'),JSON.stringify({accountId:'main',works:[]}));
  await writeFile(join(raw,'meta.json'),JSON.stringify({accountId:'main',awemeId:'123',title:'原始题'}));
  await writeFile(join(raw,'metrics.json'),JSON.stringify({latest:{metrics:{views:200,likes:0}}}));
  targets=await readCommentTargets(data,'main',['123']);
  assert.equal(targets[0].title,'原始题');
  assert.deepEqual(targets[0].metrics,{views:200,likes:0});
  await writeFile(join(data,'_index.json'),JSON.stringify({accountId:'other',works:[]}));
  await assert.rejects(readCommentTargets(data,'main',['123']),/账号不匹配/);
});

test('迁移后的兼容链接写入索引，以实际数据目录为相对路径基准', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moonlit migrated space '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const works = join(root, 'creator', 'works');
  const physicalData = join(root, 'creator', 'research', 'douyin');
  await mkdir(join(physicalData, 'main'), { recursive: true });
  await mkdir(works, { recursive: true });
  await symlink(physicalData, join(works, 'douyin'));
  const work = join(works, '2026', 'W-example');
  const target = join(work, 'distribution', 'douyin', 'main', '123');
  await mkdir(target, { recursive: true });
  await writeFile(join(work, 'work.json'), JSON.stringify({platformIds:{douyin:['123']}}));
  await writeIndex(join(works, 'douyin', 'main'), {accountId:'main', totals:{works:1}, works:[{awemeId:'123'}]});
  const index = JSON.parse(await readFile(join(physicalData, 'main', '_index.json')));
  assert.equal(await realpath(resolve(physicalData, 'main', index.works[0].path)), await realpath(target));
});

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
  assert.equal(pathA, join(workPath, 'distribution', 'douyin', 'account-a', 'aweme-1'));
  assert.equal(pathB, join(workPath, 'distribution', 'douyin', 'account-b', 'aweme-1'));
  assert.notEqual(pathA, pathB);

  await writeIndex(accountA, { accountId: 'account-a', totals: { works: 1, comments: 0 }, works: [{ awemeId: 'aweme-1', title: '同名作品' }] });
  await writeIndex(accountB, { accountId: 'account-b', totals: { works: 1, comments: 0 }, works: [{ awemeId: 'aweme-1', title: '同名作品' }] });
  const indexA = JSON.parse(await readFile(join(accountA, '_index.json'), 'utf8'));
  const indexB = JSON.parse(await readFile(join(accountB, '_index.json'), 'utf8'));
  assert.equal(indexA.accountId, 'account-a');
  assert.equal(indexB.accountId, 'account-b');
  assert.match(indexA.works[0].path, /account-a/);
  assert.match(indexB.works[0].path, /account-b/);
  assert.equal(indexA.works[0].path, '../../2026/W-20260923-001-example/distribution/douyin/account-a/aweme-1/');
  assert.equal(indexB.works[0].path, '../../2026/W-20260923-001-example/distribution/douyin/account-b/aweme-1/');
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

test('comment namespace changes preserve old evidence without double counting; empty failure retains namespace',async t=>{
 const root=await mkdtemp(join(tmpdir(),'moonlit comment namespaces '));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeComments(root,{awemeId:'123',collectedAt:'2026-10-02T00:00:00Z',incomplete:false,items:[{commentId:'1',text:'same'}],coverage:{id_namespace:'web'}});
 await writeComments(root,{awemeId:'123',collectedAt:'2026-10-04T00:00:00Z',incomplete:false,items:[{commentId:'opaque',text:'same',idNamespace:'creator_opaque'}],coverage:{id_namespace:'creator_opaque'}});
 await writeComments(root,{awemeId:'123',collectedAt:'2026-10-04T01:00:00Z',incomplete:true,items:[],coverage:{id_namespace:'web',reply_scope:'not_collected'}});
 const x=JSON.parse(await readFile(join(root,'comments.json'),'utf8'));assert.equal(x.items.length,1);assert.equal(x.alternateCollections[0].items[0].commentId,'1');assert.equal(x.coverage.id_namespace,'creator_opaque');assert.equal(x.collectedAt,'2026-10-04T00:00:00Z');
});

test('metric success cannot erase a comment failure and uncollected reply ranges are resumable',async t=>{
 const {writeFailure,clearFailure,listFailedWorks}=await import('./layout.mjs');
 const root=await mkdtemp(join(tmpdir(),'moonlit stage failures '));t.after(()=>rm(root,{recursive:true,force:true}));const dir=join(root,'_unassigned/123');
 await writeIndex(root,{accountId:'test',totals:{works:1,comments:0},works:[{awemeId:'123'}]});
 await writeFailure(dir,{awemeId:'123',stage:'comments',errorCode:'PartialComments',errorMessage:'missing'});await clearFailure(dir,'metrics');assert.deepEqual(await listFailedWorks(root),['123']);
 await clearFailure(dir,'comments');await writeComments(dir,{awemeId:'123',collectedAt:'2026-10-02T00:00:00Z',incomplete:false,items:[],coverage:{top_complete:true,reply_scope:'not_collected'}});assert.deepEqual(await listFailedWorks(root),['123']);
});

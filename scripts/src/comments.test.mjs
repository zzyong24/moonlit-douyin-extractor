import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchCommentsForWork, fetchCommentsForWorks } from './comments.mjs';
import { listFailedWorks, writeIndex, writeComments } from './layout.mjs';

function pageWith(payload) {
  const listeners=new Map();let scrolls=0;
  const page={on:(k,fn)=>listeners.set(k,fn),off:k=>listeners.delete(k),
    goto:async()=>{if(payload)await listeners.get('response')({url:()=> 'https://creator.douyin.com/aweme/v1/web/comment/list/?item_id=123',json:async()=>payload});},
    waitForTimeout:async()=>{},evaluate:async()=>{},mouse:{wheel:async()=>{scrolls++;}}};
  return {page,scrolls:()=>scrolls};
}
const comment=(id,video='123')=>({cid:id,aweme_id:video,text:'我想跟着做一次'});
async function run(t,payload,batch=false){const root=await mkdtemp(join(tmpdir(),'moonlit comment budget '));t.after(()=>rm(root,{recursive:true,force:true}));const fake=pageWith(payload),ctx={pages:()=>[fake.page]};const params={ctx,root,accountId:'test',capturedAt:'2026-10-03T00:00:00Z',maxPages:1};const result=batch?await fetchCommentsForWorks({...params,awemeIds:['123']}):await fetchCommentsForWork({...params,awemeId:'123'});return {result:batch?result.results[0]:result,stored:JSON.parse(await readFile(join(root,'_unassigned/123/comments.json'),'utf8')),fake};}

test('single and batch comment reads honor the caller budget and keep unfinished has_more',async t=>{
  for(const batch of [false,true]){const r=await run(t,{status_code:0,has_more:1,cursor:20,comments:[comment('a')]},batch);assert.equal(r.fake.scrolls(),0);assert.equal(r.result.incomplete,true);assert.equal(r.stored.coverage.top_has_more,true);assert.equal(r.stored.coverage.cursor,20);assert.equal(r.stored.coverage.scroll_rounds,0);}
});
test('missing responses or end markers cannot become complete; foreign comments stay out',async t=>{
  const missing=await run(t,null);assert.equal(missing.result.incomplete,true);assert.equal(missing.stored.coverage.top_has_more,null);
  const unknown=await run(t,{comments:[comment('a'),comment('b','other')]});assert.equal(unknown.result.incomplete,true);assert.deepEqual(unknown.stored.items.map(c=>c.commentId),['a']);
  const mixed=await run(t,{status_code:0,has_more:0,comments:[comment('a'),comment('b','other')]});assert.equal(mixed.result.incomplete,true);assert.equal(mixed.stored.coverage.top_has_more,null);
});
test('platform rejection stops the remaining videos rather than retrying the account',async t=>{
  const root=await mkdtemp(join(tmpdir(),'moonlit rejected comments '));t.after(()=>rm(root,{recursive:true,force:true}));const fake=pageWith({status_code:4,comments:[]});let visits=0;const go=fake.page.goto;fake.page.goto=async()=>{visits++;await go();};
  const result=await fetchCommentsForWorks({ctx:{pages:()=>[fake.page]},root,accountId:'test',awemeIds:['123','456'],capturedAt:'2026-10-03T00:00:00Z',maxPages:1});assert.equal(visits,1);assert.equal(result.truncated,true);assert.equal(result.results.length,1);
});
test('verified end marker completes top-level range without claiming replies',async t=>{
  const r=await run(t,{status_code:0,has_more:0,cursor:1,comments:[comment('a')]});assert.equal(r.fake.scrolls(),0);assert.equal(r.result.incomplete,false);assert.equal(r.stored.coverage.top_complete,true);assert.equal(r.stored.coverage.reply_scope,'not_collected');
});

test('a processed video without a response is not completed and remains resumable',async t=>{
  const root=await mkdtemp(join(tmpdir(),'moonlit partial receipt '));t.after(()=>rm(root,{recursive:true,force:true}));
  const fake=pageWith(null);
  const result=await fetchCommentsForWorks({ctx:{pages:()=>[fake.page]},root,accountId:'test',awemeIds:['123'],capturedAt:'2026-10-04T00:00:00Z',maxPages:1});
  await writeIndex(root,{accountId:'test',totals:{works:1,comments:0},works:[{awemeId:'123'}]});
  const receipt=JSON.parse(await readFile(join(root,'_run_comments.json/_run.json'),'utf8'));
  assert.equal(receipt.attempted,1);assert.equal(receipt.topCompleted,0);assert.equal(receipt.collected,0);
  assert.equal(receipt.status,'partial');assert.deepEqual(await listFailedWorks(root),['123']);
  assert.equal(result.results[0].storedCount,0);
});

test('a failed refresh reports the retained stored count instead of replacing it with zero',async t=>{
  const root=await mkdtemp(join(tmpdir(),'moonlit retained comments '));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeComments(join(root,'_unassigned/123'),{awemeId:'123',collectedAt:'2026-10-02T00:00:00Z',incomplete:false,items:[{commentId:'old',awemeId:'123',text:'old'}]});
  const fake=pageWith(null),result=await fetchCommentsForWorks({ctx:{pages:()=>[fake.page]},root,accountId:'test',awemeIds:['123'],capturedAt:'2026-10-04T00:00:00Z',maxPages:1});
  assert.equal(result.results[0].storedCount,1);assert.equal(result.results[0].records.length,0);
});

test('an expired comment session records the affected video before stopping',async t=>{
  const root=await mkdtemp(join(tmpdir(),'moonlit expired comments '));t.after(()=>rm(root,{recursive:true,force:true}));
  const fake=pageWith({status_code:8}),result=await fetchCommentsForWorks({ctx:{pages:()=>[fake.page]},root,accountId:'test',awemeIds:['123','456'],capturedAt:'2026-10-04T00:00:00Z',maxPages:1});
  assert.equal(result.results.length,1);assert.equal(result.results[0].incomplete,true);
  const failure=JSON.parse(await readFile(join(root,'_unassigned/123/_FAILED.json'),'utf8'));assert.equal(failure.stage,'comments');
});


test('creator packets require the plain video mapping and store expanded reply parent IDs',async t=>{
 const root=await mkdtemp(join(tmpdir(),'moonlit creator comments '));t.after(()=>rm(root,{recursive:true,force:true}));
 const listeners=new Map();let expanded=false;
 const send=async(path,query,json)=>listeners.get('response')({url:()=>`https://creator.douyin.com${path}?${query}`,status:()=>200,json:async()=>json});
 const page={on:(k,f)=>listeners.set(k,f),off:k=>listeners.delete(k),waitForTimeout:async()=>{},evaluate:async()=>{},mouse:{wheel:async()=>{}},
 goto:async()=>{
  await send('/aweme/v1/creator/comment/list/','item_id=opaque-target',{status_code:0,has_more:false,comment_info_list:[{comment_id:'parent',text:'操作在哪',reply_count:'1'},{comment_id:'image',text:'',reply_count:'0'}]});
  await send('/aweme/v1/creator/item/list/','',{status_code:0,item_info_list:[{item_id:'opaque-target',item_id_plain:'123'}]});
  await send('/aweme/v1/creator/comment/list/','item_id=opaque-other',{status_code:0,has_more:false,comment_info_list:[{comment_id:'foreign',text:'other',reply_count:'0'}]});
 },getByText:()=>({count:async()=>expanded?0:1,first:()=>({click:async()=>{expanded=true;await send('/aweme/v1/creator/comment/reply/list/','comment_id=parent',{status_code:0,has_more:false,comment_info_list:[{comment_id:'child',text:'第一步',reply_count:'0'}]});}})})};
 const out=await fetchCommentsForWorks({ctx:{pages:()=>[page]},root,accountId:'test',awemeIds:['123'],capturedAt:'2026-10-04T00:00:00Z',maxPages:2});
 assert.deepEqual(out.results[0].records.map(r=>r.commentId),['parent','image','child']);
 assert.equal(out.results[0].records.find(r=>r.commentId==='child').parentCommentId,'parent');
 assert.equal(out.results[0].coverage.scope_evidence,'creator_item_id_plain_mapping');
 assert.equal(out.results[0].coverage.reply_complete,true);assert.equal(out.truncated,false);
});

test('web proxy replies stay tied to their parent and report independent completion',async t=>{
 const root=await mkdtemp(join(tmpdir(),'moonlit proxy replies '));t.after(()=>rm(root,{recursive:true,force:true}));const listeners=new Map();let expanded=false;
 const send=async(path,query,json)=>listeners.get('response')({url:()=>`https://creator.douyin.com/web/api/third_party/aweme/api/comment/read${path}?${query}`,status:()=>200,json:async()=>json});
 const page={on:(k,f)=>listeners.set(k,f),off:k=>listeners.delete(k),waitForTimeout:async()=>{},evaluate:async()=>{},mouse:{wheel:async()=>{}},goto:async()=>send('/aweme/v1/web/comment/list/select/','aweme_id=123',{status_code:0,has_more:0,comments:[{...comment('parent'),reply_comment_total:1}]}),getByText:()=>({count:async()=>expanded?0:1,first:()=>({click:async()=>{expanded=true;await send('/aweme/v1/web/comment/list/reply/','comment_id=parent&item_id=123',{status_code:0,has_more:0,comments:[comment('child')]});}})})};
 const out=await fetchCommentsForWorks({ctx:{pages:()=>[page]},root,accountId:'test',awemeIds:['123'],capturedAt:'2026-10-04T00:00:00Z',maxPages:2});assert.equal(out.results[0].coverage.top_count,1);assert.equal(out.results[0].coverage.reply_count,1);assert.equal(out.results[0].coverage.reply_complete,true);assert.equal(out.results[0].records[1].parentCommentId,'parent');assert.equal(out.truncated,false);
});

test('a reply arriving after the click is awaited instead of counted as a missing branch',async t=>{
 const root=await mkdtemp(join(tmpdir(),'moonlit delayed reply '));t.after(()=>rm(root,{recursive:true,force:true}));const listeners=new Map();let expanded=false,resolveResponse;
 const send=async(path,query,json)=>listeners.get('response')({url:()=>`https://creator.douyin.com${path}?${query}`,status:()=>200,json:async()=>json});
 const page={on:(k,f)=>listeners.set(k,f),off:k=>listeners.delete(k),waitForTimeout:async()=>{},evaluate:async()=>{},mouse:{wheel:async()=>{}},goto:async()=>send('/aweme/v1/web/comment/list/','aweme_id=123',{status_code:0,has_more:0,comments:[{...comment('parent'),reply_comment_total:1}]}),waitForResponse:()=>new Promise(resolve=>{resolveResponse=resolve;}),getByText:()=>({count:async()=>expanded?0:1,first:()=>({click:async()=>{expanded=true;setImmediate(async()=>{await send('/aweme/v1/web/comment/list/reply/','comment_id=parent&item_id=123',{status_code:0,has_more:0,comments:[comment('late')]});resolveResponse({});});}})})};
 const out=await fetchCommentsForWorks({ctx:{pages:()=>[page]},root,accountId:'test',awemeIds:['123'],capturedAt:'2026-10-04T00:00:00Z',maxPages:2});assert.equal(out.results[0].coverage.reply_count,1);assert.equal(out.truncated,false);
});

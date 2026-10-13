// 月明·抖音萃取 · 评论抓取
//
// 单作品路径：导航创作者中心评论管理页（带 item_id 过滤）→ 拦 /aweme/v1/web/comment/list/ XHR
//            → 翻页（限流 sleep 4s/页）→ 写 comments.json
// 批量路径：在单个 context 串行抓多个作品（open/close 只一次）
//
// 评论采集的边界处理：
//   - 评论管理页 URL：https://creator.douyin.com/creator-micro/interactive/comment?item_id=<id>
//     旧 URL content/comment-manage 已被抖音改向到 content/upload，不触发评论接口
//   - item_id 过滤偶发不生效：每条评论按 payload 自带 aweme_id 归属（旧实现误把整批归到目标作品）
//   - 列表是内层滚动容器：只滚 window 触不到，需要 evaluate 内层可滚元素

import { join } from 'node:path';
import {readFile,writeFile,rename} from 'node:fs/promises';
import { parseCommentList, parseCreatorComments } from './parsers.mjs';
import { writeComments, writeFailure, clearFailure, writeRun, resolveWorkDir, readMeta } from './layout.mjs';

const CREATOR_COMMENT_MANAGE =
  'https://creator.douyin.com/creator-micro/interactive/comment';
const COMMENT_LIST_HINTS = ['/aweme/v1/web/comment/list/'];
const DEFAULT_MAX_PAGES = 40;
const PAGE_SLEEP_MS = 4000;
const NAV_TIMEOUT_MS = 60_000;

// 与 metrics.mjs 同款的退避重试
async function gotoWithRetry(page, url, signal) {
  const delays = [0, 2000, 5000, 10000];
  let lastErr = null;
  for (const delay of delays) {
    if (signal?.aborted) throw new Error('aborted');
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      return;
    } catch (err) {
      lastErr = err;
      const msg = err?.message ?? String(err);
      if (!/Timeout|timed? out|超时/i.test(msg)) throw err;
    }
  }
  throw lastErr;
}

/**
 * 在指定 page 上抓一个作品的评论（不关 context）。
 * @returns {Promise<{records: Array, hitWatermark: boolean, staleRounds: number}>}
 */
const creatorItemMaps = new WeakMap();
const creatorItemEvidence = new WeakMap();

async function scrapeCommentsForWork(page, awemeId, maxPages, signal) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new Error('maxPages must be 1..200');
  const byId = new Map(), parents = new Map(), replyPages = new Map();
  const idMap = creatorItemMaps.get(page) ?? new Map();
  creatorItemMaps.set(page,idMap);
  const itemEvidence=creatorItemEvidence.get(page)??new Map();creatorItemEvidence.set(page,itemEvidence);
  const deferred = [], pending = new Set(), endpoints = new Set(), replyAttempts=[];
  let staleRounds=0,topHasMore=null,cursor=null,responsePages=0,scrollRounds=0,responseError=null;
  let source=null,reportedTotal=null,replyResponsePages=0,replyStopReason=null;
  const moreOf = data => [true,false,0,1].includes(data.has_more ?? data.hasMore) ? Boolean(data.has_more ?? data.hasMore) : null;
  function accept(packet) {
    const {url,json} = packet, data=json.data ?? json;
    const isCreator=url.pathname.includes('/creator/comment/');
    const isReply=url.pathname.includes('/reply/');
    const requestedId=url.searchParams.get('item_id') || url.searchParams.get('aweme_id');
    const parentId=url.searchParams.get('comment_id');
    if(isCreator && !isReply && idMap.get(requestedId)!==awemeId) {
      if(!idMap.has(requestedId)) deferred.push(packet);
      return;
    }
    if(isReply){replyAttempts.push({path:url.pathname,parent_id:parentId,parent_found:parents.has(parentId),incoming_source:isCreator?'creator':'web',active_source:source});}
    if(isReply && !parents.has(parentId)) {replyAttempts.at(-1).skip='parent_not_in_top_response';return;}
    if(!isCreator && requestedId && requestedId!==awemeId) {if(isReply)replyAttempts.at(-1).skip='requested_video_mismatch';return;}
    const code=json.status_code ?? data.status_code;
    if(code!=null && code!==0) {
      responseError=new Error(code===8?'账号会话过期，停止评论读取':'平台本次拒绝评论读取');
      responseError.name=code===8?'DouyinNotLoggedInError':'CommentResponseRejected';return;
    }
    let parsed=isCreator?parseCreatorComments(json,awemeId,isReply?parentId:null):parseCommentList(json,awemeId);
    if(isReply && !isCreator)parsed=parsed.map(c=>({...c,parentCommentId:parentId,level:2}));
    if(!isCreator && (parsed.some(c=>c.awemeId!==awemeId) || (!requestedId && !parsed.length))) {
      for(const c of parsed.filter(c=>c.awemeId===awemeId))byId.set(c.commentId,c);
      return;
    }
    const incoming=isCreator?'creator':'web';
    if(source && source!==incoming){if(isReply)replyAttempts.at(-1).skip='source_namespace_mismatch';return;}
    source=incoming;
    endpoints.add(url.pathname);
    for(const c of parsed){byId.set(c.commentId,c);if(!isReply)parents.set(c.commentId,c);}
    if(isReply) {
      replyResponsePages++;
      replyPages.set(parentId,{has_more:moreOf(data),cursor:data.cursor??null,response_pages:(replyPages.get(parentId)?.response_pages??0)+1});
    } else {
      responsePages++;
      topHasMore=moreOf(data);cursor=data.cursor??null;
      reportedTotal=typeof (data.total_count??data.total)==='number'?(data.total_count??data.total):reportedTotal;
    }
  }
  const onResponse=async resp=>{
    const url=new URL(resp.url());
    const isItem=url.pathname.includes('/aweme/v1/creator/item/list');
    if(!isItem && !COMMENT_LIST_HINTS.some(h=>url.pathname.includes(h)) && !/\/creator\/comment\/(?:reply\/)?list\/?$/.test(url.pathname))return;
    if(resp.status && resp.status()!==200){
      if([403,429].includes(resp.status())){responseError=new Error(`平台拒绝评论读取（HTTP ${resp.status()}），停止本账号`);responseError.name='CommentResponseRejected';}
      if(/reply/.test(url.pathname))replyAttempts.push({path:url.pathname,http:resp.status(),skip:'non_200'});
      return;
    } // redirect bodies are not comment payloads
    const reading=(async()=>{
      const json=await resp.json().catch(()=>null);if(!json){if(/reply/.test(url.pathname))replyAttempts.push({path:url.pathname,skip:'not_json'});return;}
      if(isItem){
        for(const w of (json.data??json).item_info_list??[])if(w.item_id && /^\d+$/.test(w.item_id_plain??'')){idMap.set(w.item_id,w.item_id_plain);itemEvidence.set(w.item_id,{creatorItemId:w.item_id,awemeId:w.item_id_plain,observedAt:new Date().toISOString()});}
        const queued=deferred.splice(0);for(const packet of queued)accept(packet);
      }else accept({url,json});
    })();pending.add(reading);try{await reading;}finally{pending.delete(reading);}
  };
  const settle=async()=>{await Promise.all([...pending]);if(responseError)throw responseError;};
  const scroll=async selector=>{
    await page.evaluate(selector=>{
      const scope=selector?document.querySelector(selector):document;
      if(!scope)return;
      if(!selector)window.scrollTo(0,document.body.scrollHeight);
      for(const el of [scope,...scope.querySelectorAll('*')])if(el.scrollHeight>el.clientHeight+100)el.scrollTop=el.scrollHeight;
    },selector).catch(()=>{});
    if(!selector)await page.mouse.wheel(0,2000).catch(()=>{});
    await page.waitForTimeout(PAGE_SLEEP_MS);await settle();
  };
  page.on('response',onResponse);
  try {
    await gotoWithRetry(page,`${CREATOR_COMMENT_MANAGE}?item_id=${encodeURIComponent(awemeId)}`,signal);
    // A loaded shell can still be showing “加载中”; wait for the actual comment response.
    await page.waitForTimeout(3000);await settle();
    if(page.getByRole)for(let i=0;i<57 && !responsePages && !deferred.length;i++){await page.waitForTimeout(1000);await settle();}
    // The new creator endpoint sends encrypted item IDs. Resolve them through
    // its real item_id_plain mapping, including older works in the selector.
    if(deferred.length && !responsePages && page.getByRole){
      await page.getByRole('button',{name:'选择作品',exact:true}).click({timeout:10000});
      await page.waitForTimeout(3000);await settle();
      let mapStale=0;
      for(let i=0;i<maxPages && !responsePages;i++){signal?.throwIfAborted?.();const before=idMap.size;await scroll('[role="dialog"]');mapStale=idMap.size===before?mapStale+1:0;if(mapStale>=3)break;}
      await page.keyboard.press('Escape');
      const dialog=page.getByRole('dialog');
      if(await dialog.count() && await dialog.first().isVisible()) {
        const box=await dialog.first().boundingBox();
        if(box && box.x>5)await page.mouse.click(box.x-5,Math.max(5,box.y+20));
        await dialog.first().waitFor({state:'hidden',timeout:5000});
      }
      await settle();
    }
    for(let i=0;i<maxPages && responsePages<maxPages && topHasMore!==false;i++){
      signal?.throwIfAborted?.();const before=parents.size;await scroll();scrollRounds++;
      staleRounds=parents.size===before?staleRounds+1:0;if(staleRounds>=3)break;
    }
    const topComplete=responsePages>0 && topHasMore===false;
    // Expand only read controls; never click 回复/发送/删除/举报.
    if(source && page.getByText) {
      for(let i=0;i<maxPages;i++){
        signal?.throwIfAborted?.();
        const expands=page.getByText(/^查看\d+条回复$/);if(!await expands.count())break;
        const before=replyResponsePages;
        // Some expanded replies arrive after the old fixed four-second wait.
        // Wait for their actual response before moving to the next read control.
        const responseWait=page.waitForResponse ? page.waitForResponse(r=>
          /\/comment\/(?:list\/reply|reply\/list)\//.test(new URL(r.url()).pathname) && r.status()===200,
          {timeout:15000}).catch(()=>null) : Promise.resolve(null);
        await expands.first().click({timeout:5000});
        await responseWait;await page.waitForTimeout(PAGE_SLEEP_MS);await settle();
        if(replyResponsePages===before){replyStopReason='expanded_reply_response_missing_or_unmatched';break;}
      }
    }
    const replyParents=[...parents.values()].filter(c=>typeof c.replyCount==='number' && c.replyCount>0);
    const repliesComplete=Boolean(source) && topComplete && [...parents.values()].every(c=>c.replyCount!==null) && replyParents.every(c=>replyPages.get(c.commentId)?.has_more===false);
    const reason=topComplete?null:!responsePages?(deferred.length?'creator_item_scope_unresolved':'comment_response_not_available'):topHasMore===null?'end_marker_unknown':staleRounds>=3?'pagination_stalled':'page_budget_reached';
    return {records:[...byId.values()],incomplete:!topComplete,truncatedReason:reason,
      coverage:{scope:source && page.getByText?'top_level_and_replies':'top_level',top_complete:topComplete,
        top_has_more:topHasMore,cursor,response_pages:responsePages,scroll_rounds:scrollRounds,page_budget:maxPages,
        id_namespace:source==='creator'?'creator_opaque':'web',endpoints:[...endpoints],
        scope_evidence:source==='creator'?'creator_item_id_plain_mapping':'requested_aweme_id',
        reported_total:reportedTotal,top_count:parents.size,reply_count:[...byId.values()].filter(c=>c.parentCommentId).length,
        reply_scope:repliesComplete?'complete':source && page.getByText?'partial':'not_collected',reply_complete:repliesComplete,
        reply_response_pages:replyResponsePages,reply_parent_budget:maxPages,
        reply_stop_reason:replyStopReason,reply_attempts:replyAttempts,
        reply_parents:replyParents.map(c=>({comment_id:c.commentId,reported_count:c.replyCount,...replyPages.get(c.commentId),complete:replyPages.get(c.commentId)?.has_more===false}))}};
  } catch(error) {
    error.partial={records:[...byId.values()],coverage:{scope:source && page.getByText?'top_level_and_replies':'top_level',top_complete:responsePages>0&&topHasMore===false,top_has_more:topHasMore,cursor,response_pages:responsePages,scroll_rounds:scrollRounds,page_budget:maxPages,reply_scope:'partial',reply_complete:false,id_namespace:source==='creator'?'creator_opaque':'web',endpoints:[...endpoints]}};
    throw error;
  } finally {page.off('response',onResponse);}
}

async function seedCreatorItemMap(page,root,accountId) {
  try {
    const receipt=JSON.parse(await readFile(join(root,'_creator-item-map.json'),'utf8'));
    if(receipt.accountId!==accountId)return;
    const map=creatorItemMaps.get(page)??new Map(),evidence=creatorItemEvidence.get(page)??new Map();
    for(const row of receipt.items??[]) {
      const age=Date.now()-Date.parse(row.observedAt??receipt.observedAt);
      if(typeof row.creatorItemId==='string' && /^\d+$/.test(row.awemeId??'') && age>=0 && Number.isFinite(age)){map.set(row.creatorItemId,row.awemeId);evidence.set(row.creatorItemId,row);}
    }
    creatorItemMaps.set(page,map);creatorItemEvidence.set(page,evidence);
  } catch {}
}

async function saveCreatorItemMap(page,root,accountId) {
  const entries=creatorItemEvidence.get(page);
  if(!entries?.size)return;
  const path=join(root,'_creator-item-map.json'),tmp=path+'.tmp';
  await writeFile(tmp,JSON.stringify({accountId,updatedAt:new Date().toISOString(),items:[...entries.values()]},null,2)+'\n','utf8');
  await rename(tmp,path);
}

/**
 * 抓一个作品的评论（含打开新 context / 关闭）。
 * 用于 --aweme 单作品路径。
 */
export async function fetchCommentsForWork({
  ctx,
  awemeId,
  signal,
  root,
  accountId,
  capturedAt,
  force = false,
  maxPages = DEFAULT_MAX_PAGES,
}) {
  const meta = await readMeta(root, awemeId);
  const workDir = await resolveWorkDir(root, awemeId, meta?.title ?? '', accountId);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await seedCreatorItemMap(page,root,accountId);
  let incomplete = false;
  let truncatedReason = null;
  let records = [];
  let coverage = {scope:'top_level',top_complete:false,top_has_more:null,reply_scope:'not_collected'};
  try {
    const out = await scrapeCommentsForWork(
      page,
      awemeId,
      maxPages,
      signal,
    );
    records = out.records;
    incomplete = out.incomplete;
    truncatedReason = out.truncatedReason;
    coverage = out.coverage;
  } catch (err) {
    incomplete = true;
    truncatedReason = err?.message ?? String(err);
    if(err.partial){records=err.partial.records;coverage=err.partial.coverage;}
    await writeFailure(workDir, {
      awemeId,
      stage: 'comments',
      errorCode: err?.name ?? 'ScrapeError',
      errorMessage: truncatedReason,
    });
  }
  const saved = await writeComments(
    workDir,
    {
      awemeId,
      collectedAt: capturedAt,
      incomplete,
      truncatedReason,
      count: records.length,
      items: records,
      coverage,
    },
    { force },
  );
  if (incomplete || coverage.reply_scope==='partial') await writeFailure(workDir, {awemeId,stage:'comments',errorCode:'PartialComments',errorMessage:truncatedReason});
  if (!incomplete && coverage.reply_scope!=='partial') await clearFailure(workDir, 'comments');
  await saveCreatorItemMap(page,root,accountId);
  return { awemeId, records, storedCount:saved.length, added:saved.added ?? records.length, incomplete, truncatedReason, coverage };
}

/**
 * 批量抓多个作品的评论（复用单 context）。
 * 撞冷却或登出立即停止。
 */
export async function fetchCommentsForWorks({
  ctx,
  awemeIds,
  signal,
  root,
  accountId,
  capturedAt,
  force = false,
  maxPages = DEFAULT_MAX_PAGES,
}) {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await seedCreatorItemMap(page,root,accountId);
  const results = [];
  let truncated = false;
  let truncatedReason = null;

  for (const awemeId of awemeIds) {
    if (signal?.aborted) throw new Error('aborted');
    const meta = await readMeta(root, awemeId);
    const workDir = await resolveWorkDir(root, awemeId, meta?.title ?? '', accountId);
    let incomplete = false;
    let reason = null;
    let records = [];
    let coverage = {scope:'top_level',top_complete:false,top_has_more:null,reply_scope:'not_collected'};
    let stopAfterWrite = false;
    try {
      const out = await scrapeCommentsForWork(page, awemeId, maxPages, signal);
      records = out.records;
      incomplete = out.incomplete;
      reason = out.truncatedReason;
      coverage = out.coverage;
    } catch (err) {
      // 登出 → 立即停剩余作品
      if (err?.name === 'DouyinNotLoggedInError') {
        truncated = true;
        truncatedReason = `账号会话过期,已采 ${results.length}/${awemeIds.length} 个作品`;
        stopAfterWrite = true;
      }
      incomplete = true;
      reason = err?.message ?? String(err);
      if(err.partial){records=err.partial.records;coverage=err.partial.coverage;}
      if (err?.name === 'CommentResponseRejected') {
        stopAfterWrite = true;
        truncated = true;
        truncatedReason = '平台拒绝评论读取，停止本账号后续作品';
      }
      await writeFailure(workDir, {
        awemeId,
        stage: 'comments',
        errorCode: err?.name ?? 'ScrapeError',
        errorMessage: reason,
      });
    }
    const saved = await writeComments(
      workDir,
      {
        awemeId,
        collectedAt: capturedAt,
        incomplete,
        truncatedReason: reason,
        count: records.length,
        items: records,
        coverage,
      },
      { force },
    );
    if (!incomplete && coverage.reply_scope!=='partial') await clearFailure(workDir, 'comments');
    if (incomplete || coverage.reply_scope==='partial') {
      await writeFailure(workDir, {awemeId,stage:'comments',errorCode:'PartialComments',errorMessage:reason || 'reply_range_incomplete'});
      truncated = true;
      truncatedReason ||= reason || 'reply_range_incomplete';
    }
    results.push({ awemeId, records, storedCount:saved.length, added:saved.added ?? records.length, incomplete, truncatedReason: reason, coverage });
    if (stopAfterWrite) break;
  }

  await saveCreatorItemMap(page,root,accountId);
  await writeRun(join(root, '_run_comments.json'), {
    startedAt: capturedAt,
    completedAt: new Date().toISOString(),
    works: awemeIds.length,
    attempted: results.length,
    collected: results.filter(r=>!r.incomplete && r.coverage.reply_scope!=='partial').length,
    topCompleted: results.filter(r=>r.coverage.top_complete).length,
    incomplete: results.filter(r=>r.incomplete || r.coverage.reply_scope==='partial').map(r=>({awemeId:r.awemeId,reason:r.truncatedReason || 'reply_range_incomplete'})),
    notAttempted: awemeIds.filter(id=>!results.some(r=>r.awemeId===id)),
    storedComments: results.reduce((s,r)=>s+r.storedCount,0),
    newComments: results.reduce((s,r)=>s+r.added,0),
    scope:'per_video_coverage',replyScope:results.every(r=>r.coverage.reply_complete)?'complete':results.some(r=>r.coverage.scope==='top_level_and_replies')?'partial':'not_collected',
    status:truncated?'partial':results.every(r=>r.coverage.reply_complete)?'complete':'top_level_complete',
    truncated,
    truncatedReason,
  });

  return { results, truncated, truncatedReason };
}

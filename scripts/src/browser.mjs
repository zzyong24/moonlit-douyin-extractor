// 月明·抖音萃取 · Playwright 浏览器封装
//
// 单一职责：
//   1. SingletonLock 冲突检测（另一进程正在用就拒绝 / 已死就清锁）
//   2. openProfile 启动 headless Chromium
//   3. loginDouyinProfile 启动 headed Chromium 引导用户扫码（首次或重扫）
//   4. probeSession 验证 sessionid + creator/user/info
//
// 所有 IO 异常都包成自定义错误类，调用方 instanceof 判别即可。

import { chromium } from 'playwright';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseCreatorProfileIdentity, parseCreatorWorkListIdentity } from './parsers.mjs';

// ------------------------------------------------------------------
// 浏览器错误类
// ------------------------------------------------------------------

export class DouyinNotLoggedInError extends Error {
  constructor(message = '会话过期或未登录') {
    super(message);
    this.name = 'DouyinNotLoggedInError';
  }
}

export class DouyinProfileLockedError extends Error {
  constructor(accountId, pid) {
    super(
      `账号「${accountId}」的登录态目录正在被另一个进程持有（PID=${pid ?? '未知'}）；请先关闭那个窗口或进程`,
    );
    this.name = 'DouyinProfileLockedError';
    this.accountId = accountId;
    this.pid = pid;
  }
}

// ------------------------------------------------------------------
// SingletonLock 处理
// ------------------------------------------------------------------

/**
 * 读取 SingletonLock 文件内容（Chromium 写入的 PID 字符串）。
 * 文件不存在 → null；存在但读不到 → null。
 */
function readSingletonLock(authDir) {
  const p = join(authDir, 'SingletonLock');
  if (!existsSync(p)) return null;
  try {
    const txt = readFileSync(p, 'utf8').trim();
    return txt || null;
  } catch {
    return null;
  }
}

/**
 * 进程是否存活（POSIX / macOS / Linux）。Windows 上 process.kill 抛 ESRCH 即可判不存在。
 */
function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'EPERM') return true; // 进程存在但无权限发信号
    return false;
  }
}

/**
 * 在打开 profile 前检查 / 清理 SingletonLock。
 * - 锁存在且进程存活 → 抛 DouyinProfileLockedError
 * - 锁存在但进程已死 → 删锁（这是 Chromium 异常退出后的常见遗留状态）
 * - 锁不存在 → 通过
 */
export function ensureProfileNotLocked(authDir, accountId) {
  const raw = readSingletonLock(authDir);
  if (!raw) return; // 无锁，安全
  const pid = Number.parseInt(raw, 10);
  if (isPidAlive(pid)) {
    throw new DouyinProfileLockedError(accountId, pid);
  }
  // 进程已死 → 删锁（Chromium 异常退出未清理）
  try {
    unlinkSync(join(authDir, 'SingletonLock'));
    console.warn(
      `[browser] 清理已死进程的 SingletonLock（PID=${pid} 已不存在）`,
    );
  } catch (err) {
    console.warn(
      `[browser] SingletonLock 清理失败（${err?.message ?? err}）；继续尝试 launch（Chromium 会自己处理）`,
    );
  }
}

// ------------------------------------------------------------------
// Profile 启动
// ------------------------------------------------------------------

/**
 * @typedef {{
 *   authDir: string,
 *   headless?: boolean,
 *   signal?: AbortSignal
 * }} OpenOptions
 */

/**
 * 启动 Playwright 持久 profile context。
 *
 * 调用方负责：
 * - 先调 ensureProfileNotLocked()
 * - 拿到 ctx 后用完必须 close()（即使抛错也要 close，否则 SingletonLock 残留）
 */
export async function openProfile(opts = /** @type {OpenOptions} */ ({})) {
  const { authDir, headless = true, signal } = opts;
  if (signal?.aborted) {
    throw new Error('aborted');
  }
  // 减少自动化标记，使用可见或无头的独立 Chromium profile。
  const ctx = await chromium.launchPersistentContext(authDir, {
    headless,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    acceptDownloads: true,
  });
  // Playwright v1.49+：launchPersistentContext 的 signal 透传需要监听 abort
  if (signal) {
    const onAbort = () => {
      ctx.close().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return ctx;
}

// ------------------------------------------------------------------
// 登录态探针（被动）
// ------------------------------------------------------------------

const CREATOR_HOME = 'https://creator.douyin.com/';
const CREATOR_LOGIN_HOME = 'https://creator.douyin.com/creator-micro/home';
const CREATOR_WORKS_HOME = 'https://creator.douyin.com/creator-micro/content/manage';
const SESSION_PROBE_API = 'https://creator.douyin.com/aweme/v1/creator/user/info/';
const WORK_LIST_HINTS = ['/aweme/v1/creator/item/list', '/creator/pc/work_list', '/web/aweme/post'];

/**
 * 只读：检查 .auth/<accountId>/ 是否有 sessionid / sessionid_ss cookie。
 */
export async function hasSessionCookie(ctx) {
  const cookies = await ctx.cookies(CREATOR_LOGIN_HOME);
  return cookies.some(
    (c) => c.name === 'sessionid' || c.name === 'sessionid_ss',
  );
}

/**
 * 深度探测：在创作者中心页面内 fetch 同源账号资料接口，
 *  判定 status_code=0（active）/ status_code=8（expired）/ 其他（unknown）。
 */
async function probeCreatorSession(page) {
  try {
    const result = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url, { credentials: 'include' });
        const json = await response.json();
        return {
          statusCode:
            typeof json?.status_code === 'number' ? json.status_code : null,
          statusMessage:
            typeof json?.status_msg === 'string' ? json.status_msg : '',
        };
      } catch {
        return null;
      }
    }, SESSION_PROBE_API);
    if (!result) return 'unknown';
    if (result.statusCode === 8) return 'expired';
    return result.statusCode === 0 ? 'active' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 完整登录态探针：先看 cookie，再在 page 里探 creator/user/info。
 * 返回 'active' | 'expired' | 'unknown'。
 */
export async function probeSession(ctx) {
  if (!(await hasSessionCookie(ctx))) return 'unknown';
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    await page
      .goto(CREATOR_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch(() => {});
    return await probeCreatorSession(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Read and validate the identity tied to the currently open creator profile. */
export async function readCreatorIdentity(ctx) {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  let identity = null;
  const pending = [];
  const onResponse = (response) => {
    const url = response.url();
    const isProfile = /creator\/user\/info|user_info|account_info|profile/i.test(url);
    const isWorkList = WORK_LIST_HINTS.some((hint) => url.includes(hint));
    if (!isProfile && !isWorkList) return;
    pending.push(response.json().then((json) => {
      identity ??= isWorkList
        ? parseCreatorWorkListIdentity(json)
        : parseCreatorProfileIdentity(json);
    }).catch(() => {}));
  };
  page.on('response', onResponse);
  try {
    await page.goto(CREATOR_LOGIN_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    if (!identity) {
      await page.goto(CREATOR_WORKS_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    if (pending.length) await Promise.allSettled([...pending]);
    for (let attempt = 0; attempt < 8 && !identity; attempt += 1) {
      const payload = await page.evaluate(async (url) => {
        try {
          const response = await fetch(url, { credentials: 'include' });
          return await response.json();
        } catch {
          return null;
        }
      }, SESSION_PROBE_API).catch(() => null);
      identity ??= parseCreatorProfileIdentity(payload);
      if (!identity) await page.waitForTimeout(750);
      if (pending.length) await Promise.allSettled([...pending]);
    }
    return identity;
  } finally {
    page.off('response', onResponse);
  }
}

// ------------------------------------------------------------------
// 扫码登录（主动）
// ------------------------------------------------------------------

/**
 * @typedef {{
 *   authDir: string,
 *   timeoutSec?: number
 * }} LoginOptions
 */

/**
 * Launch a visible, isolated Playwright profile for QR login.
 * The caller supplies a new staging directory so an old account session cannot
 * short-circuit the QR flow. Only a server-accepted session counts as success.
 */
export async function loginDouyinProfile(opts = /** @type {LoginOptions} */ ({})) {
  const { authDir, timeoutSec = 240 } = opts;
  const ctx = await openProfile({ authDir, headless: false });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(CREATOR_LOGIN_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    for (let attempt = 0; attempt < Math.max(1, Number(timeoutSec) || 240); attempt += 1) {
      if ((await probeCreatorSession(page)) === 'active') return true;
      await page.waitForTimeout(1000);
    }
    return false;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ------------------------------------------------------------------
// 类型 / 异常重导出（给持久化层的兼容接口）
// ------------------------------------------------------------------

export function rehydrateDouyinError(err) {
  if (err instanceof DouyinNotLoggedInError) return err;
  if (err?.name === 'DouyinNotLoggedInError') return new DouyinNotLoggedInError(err.message);
  return null;
}

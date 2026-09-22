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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ------------------------------------------------------------------
// 错误类（与 CreatorOS douyin-errors.ts 语义对齐；standalone 实现）
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
  // 反自动化标记 + 关闭 automation 开关（与 CreatorOS 同款）
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
const SESSION_PROBE_API = 'https://creator.douyin.com/aweme/v1/creator/user/info/';

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
 * 调用 ego-browser 的可见持久页面引导用户扫码登录抖音创作者中心。
 * 成功条件必须是抖音服务端接受该会话，不能只看本地 sessionid 是否存在
 * —— 失效 Cookie 仍会留在 profile，旧实现会第一轮就误判成功。
 *
 * 流程：
 *   1. 调用 ego-browser 的持久页面打开 CREATOR_LOGIN_HOME
 *   2. 每秒轮询 /aweme/v1/creator/user/info/
 *   3. status_code=0 后通过 CDP 读取抖音 Cookie
 *   4. 用 Playwright 打开本地 profile，注入 Cookie 并重新探针验证
 *   5. 超时返回 false；临时 Cookie 文件在 finally 中清理
 */
export async function loginDouyinProfile(opts = /** @type {LoginOptions} */ ({})) {
  const { authDir, timeoutSec = 240 } = opts;
  // 登录阶段使用 ego-browser 的可见页面，避免 NomiFun 后台进程启动的
  // Playwright headed Chromium 窗口一闪而过、但没有出现在用户桌面。
  const tempDir = await mkdtemp(join(tmpdir(), 'moonlit-douyin-ego-'));
  const cookieFile = join(tempDir, 'cookies.json');
  const egoScript = `
    const { writeFile } = await import('node:fs/promises');
    const task = await taskSpace('moonlit-douyin-login');
    const page = task.page('p1');
    await page.goto('https://creator.douyin.com/creator-micro/home', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(() => {});
    for (let i = 0; i < ${Math.max(1, Number(timeoutSec) || 240)}; i++) {
      const status = await page.evaluate(async () => {
        try {
          const response = await fetch(
            'https://creator.douyin.com/aweme/v1/creator/user/info/',
            { credentials: 'include' },
          );
          const json = await response.json();
          return json?.status_code ?? null;
        } catch { return null; }
      }).catch(() => null);
      if (status === 0) {
        const result = await page.cdp('Network.getAllCookies');
        const cookies = (result?.cookies ?? [])
          .filter((c) => /(?:^|\\.)douyin\\.com$/.test(c.domain))
          .map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({
            name, value, domain, path, expires, httpOnly, secure, sameSite,
          }));
        await writeFile(${JSON.stringify(cookieFile)}, JSON.stringify(cookies));
        console.log('__MOONLIT_EGO_LOGIN_OK__');
        process.exit(0);
      }
      await page.waitForTimeout(1000);
    }
    process.exit(5);
  `;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('ego-browser', ['nodejs'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `ego-browser 登录退出码 ${code}`));
      });
      child.stdin.end(egoScript);
    });

    const cookies = JSON.parse(await readFile(cookieFile, 'utf8'));
    const ctx = await openProfile({ authDir, headless: true });
    try {
      await ctx.addCookies(cookies);
      return (await probeSession(ctx)) === 'active';
    } finally {
      await ctx.close().catch(() => {});
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
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

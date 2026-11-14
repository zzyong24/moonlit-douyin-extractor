#!/usr/bin/env python3
"""用 Redfox 公开数据接口读抖音作品的公开指标（播放/点赞/评论/分享数等）。

团队 Bot 用这条路，不需要月明的抖音登录态。只用 Python 3 标准库。
- 默认只报价（不联网、不花钱）：列出将调用几次、单价、预计金额。
- 加 --run 才真实调用。Redfox 低价档（0.04 元/次）按团队额度规则使用；
  一次超过 --max-calls（默认 20 次）要先把报价交给月明批准，再加 --approval。
- API Key 只从环境变量 REDFOX_API_KEY 读取（由团队凭据库注入），不写文件、不打印。
"""
import argparse, json, os, sys, urllib.error, urllib.request

BASE = 'https://redfox.hk'
PRICE = 0.04  # 元/次，文档标价（2026-10-20 核对）；实扣以 Redfox 调用记录为准
WORK_LIST = '/story/api/dyData/queryWorkList'
WORK = '/story/api/dyData/queryWork'


def call(path, body, key):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method='POST',
                                 headers={'REDFOX_API_KEY': key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f'Redfox HTTP {e.code}（响应正文已省略）')
    if res.get('code') not in (None, 2000):
        raise SystemExit(f"Redfox 返回 code={res.get('code')}：{str(res.get('msg'))[:80]}")
    return res.get('data')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--account-id', help='抖音号（读账号作品列表）')
    g.add_argument('--work', action='append', help='作品 ID 或作品链接，可重复')
    ap.add_argument('--pages', type=int, default=1, help='作品列表翻几页（每页 20 条，每页 1 次调用）')
    ap.add_argument('--out', help='输出 JSON 路径（默认打印到标准输出）')
    ap.add_argument('--run', action='store_true', help='真实调用（会扣 Redfox 积分）')
    ap.add_argument('--max-calls', type=int, default=20, help='不需单独批准的最大调用次数')
    ap.add_argument('--approval', default='', help='超过 --max-calls 时，月明对报价的批准记录')
    a = ap.parse_args()
    calls = a.pages if a.account_id else len(a.work)
    quote = {'service': 'Redfox 抖音公开数据（优质库）', 'calls': calls, 'unit_price_yuan': PRICE,
             'estimated_yuan': round(calls * PRICE, 2), 'needs_approval': calls > a.max_calls}
    print(json.dumps({'quote': quote}, ensure_ascii=False), file=sys.stderr)
    if not a.run:
        return 0
    if calls > a.max_calls and not a.approval.strip():
        raise SystemExit(f'本次 {calls} 次调用超过 {a.max_calls} 次：先把报价交给月明，批准后加 --approval')
    key = os.environ.get('REDFOX_API_KEY', '').strip()
    if not key:
        raise SystemExit('缺 REDFOX_API_KEY 环境变量（从团队凭据库注入，不要写进文件）')
    rows = []
    if a.account_id:
        for p in range(a.pages):
            d = call(WORK_LIST, {'accountId': a.account_id, 'offset': p * 20, 'sortType': '2'}, key) or {}
            rows += d.get('list') or []
            if not d.get('hasMore'):
                break
    else:
        for w in a.work:
            body = {'workUrl': w} if w.startswith('http') else {'workId': w}
            rows.append(call(WORK, body, key))
    out = json.dumps({'source': 'redfox-public', 'quote': quote, 'items': rows}, ensure_ascii=False, indent=1)
    if a.out:
        open(a.out, 'w', encoding='utf-8').write(out)
    else:
        print(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())

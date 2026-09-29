#!/usr/bin/env node
/**
 * check.mjs —— 输出前自检 / 更新状态一览
 *
 * 用法:
 *   node check.mjs                  # 校验当前目录所有 feed-*.xml
 *   node check.mjs --max-age 36     # 额外检查“应该在动”的源是否超期（小时），超期则退出码 1
 *   node check.mjs --allow-shrink   # 允许条目数比 HEAD 少（默认不允许，防止历史条目被覆盖丢失）
 *   node check.mjs feed-c.xml ...   # 只校验指定文件
 *
 * 校验内容:
 *   1. XML 结构完整（声明 / <rss> / <channel> / 成对的 </item>）
 *   2. 没有未转义的 & 、没有控制字符与零宽字符（历史上踩过坑）
 *   3. 每个 item 都有 <title> 与 <guid>，且 guid 不重复
 *   4. 条目数不少于 HEAD 里的同名文件（防「本地旧文件覆盖远端新文件」）
 * 状态一览会打印每个源的条数 / 最后构建时间 / 最新一条标题。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FEED_RE = /^feed-[a-z]\.xml$/;
// 这些源内容更新本身就不频繁，不做超期检查
const QUIET = new Set(['feed-a.xml', 'feed-b.xml', 'feed-f.xml']);

const args = process.argv.slice(2);
let maxAge = 0;
let allowShrink = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max-age') {
    maxAge = Number(args[++i]);
    if (!Number.isFinite(maxAge) || maxAge < 0) {
      console.error(`--max-age 需要一个非负数字，收到: ${args[i]}`);
      process.exit(2);
    }
  } else if (args[i] === '--allow-shrink') {
    allowShrink = true;
  } else if (args[i] === '--no-shrink') {
    allowShrink = false;
  } else if (args[i].startsWith('-')) {
    console.error(`未知参数: ${args[i]}`);
    process.exit(2);
  } else {
    files.push(args[i]);
  }
}

/**
 * HEAD 里同名文件的条目数；取不到（无 git / 文件是新增的）返回 null 表示不检查。
 * 用「stdout 直接写文件」而不是管道读取，避免受限环境下创建命名管道失败。
 */
function headItemCount(f) {
  const tmp = path.join(os.tmpdir(), `check-${process.pid}-${Math.random().toString(36).slice(2)}.xml`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    const r = spawnSync('git', ['show', `HEAD:${f}`], { stdio: ['ignore', fd, 'ignore'] });
    fs.closeSync(fd);
    fd = null;
    if (r.status !== 0) return null;
    return (fs.readFileSync(tmp, 'utf8').match(/<item>/g) || []).length;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const targets = files.length
  ? files
  : fs.readdirSync('.').filter((f) => FEED_RE.test(f)).sort();

if (!targets.length) {
  console.error('没有找到 feed-*.xml');
  process.exit(2);
}

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/;
const RAW_AMP = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

let bad = 0;
let stale = 0;
const rows = [];

for (const f of targets) {
  const errs = [];
  let xml = '';
  try {
    xml = fs.readFileSync(f, 'utf8');
  } catch (e) {
    console.log(`✗ ${f}  无法读取: ${e.message}`);
    bad++;
    continue;
  }

  if (!xml.startsWith('<?xml ')) errs.push('缺少 XML 声明');
  if (!xml.includes('<rss ')) errs.push('缺少 <rss> 根元素');
  if (!xml.includes('</rss>')) errs.push('缺少 </rss>');

  const open = (xml.match(/<item>/g) || []).length;
  const close = (xml.match(/<\/item>/g) || []).length;
  if (open !== close) errs.push(`<item> 不配对: ${open} 开 / ${close} 闭`);

  const chOpen = (xml.match(/<channel>/g) || []).length;
  const chClose = (xml.match(/<\/channel>/g) || []).length;
  if (chOpen !== chClose) errs.push(`<channel> 不配对: ${chOpen} / ${chClose}`);

  const ctrl = xml.match(CTRL);
  if (ctrl) errs.push(`含控制字符 U+${ctrl[0].charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`);
  if (ZERO_WIDTH.test(xml)) errs.push('含零宽字符（U+200B..200D / U+FEFF）');

  const amp = xml.match(RAW_AMP);
  if (amp) {
    const at = amp.index ?? 0;
    errs.push(`含未转义的 & ：…${xml.slice(Math.max(0, at - 20), at + 20).replace(/\s+/g, ' ')}…`);
  }

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const guidSeen = new Set();
  let dupGuid = 0;
  let missing = 0;
  const titles = [];
  for (const body of items) {
    const g = (body.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1];
    const t = (body.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    titles.push(t || '');
    if (!g || !t) missing++;
    else if (guidSeen.has(g.trim())) dupGuid++;
    else guidSeen.add(g.trim());
  }
  if (missing) errs.push(`${missing} 个 item 缺少 title 或 guid`);
  if (dupGuid) errs.push(`${dupGuid} 个重复 guid`);

  if (!allowShrink) {
    const before = headItemCount(f);
    if (before !== null && items.length < before) {
      errs.push(`条目数从 HEAD 的 ${before} 减到 ${items.length}（历史条目可能被覆盖；确认无误可加 --allow-shrink）`);
    }
  }

  const lastBuild = (xml.match(/<lastBuildDate>([^<]+)<\/lastBuildDate>/) || [])[1] || '';
  const built = lastBuild ? new Date(lastBuild) : null;
  const ageH = built && !Number.isNaN(built.getTime()) ? (Date.now() - built.getTime()) / 3600000 : NaN;

  let ageTag = Number.isFinite(ageH) ? ageH.toFixed(1) + 'h' : '?';
  const isStale = maxAge > 0 && !QUIET.has(f) && Number.isFinite(ageH) && ageH > maxAge;
  if (isStale) {
    stale++;
    ageTag += ' ⚠';
  }

  const ok = !errs.length && !isStale;
  if (!ok) bad++;

  if (isStale) errs.push(`已 ${ageH.toFixed(1)} 小时没有更新（阈值 ${maxAge}h）`);

  console.log(
    `${ok ? '✓' : '✗'} ${f.padEnd(12)} ${String(items.length).padStart(4)} 条  ` +
      `${String(xml.length).padStart(7)} B  构建于 ${ageTag.padEnd(8)} ${(titles[0] || '').slice(0, 34)}`
  );
  for (const e of errs) console.log(`    · ${e}`);
  rows.push({ f, items: items.length, ageH, errs, isStale });
}

const failed = rows.filter((r) => r.errs.length || r.isStale);
for (const r of rows) {
  for (const e of r.errs) console.log(`::warning title=自检 ${r.f}::${e}`);
}

console.log('');
console.log(`校验完成：${targets.length} 个文件，${failed.length} 个不通过，其中 ${stale} 个超期`);

process.exit(failed.length ? 1 : 0);

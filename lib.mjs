// lib.mjs —— 各订阅源脚本共用的工具与小工具
//
// 主要提供：HTML 清洗（保留加粗/标题/列表/表格/链接/图片）、按 div 深度切片、
// 实体解码、正文长度与截断、RSS 转义等。

import fs from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 转义 ---------------- */
export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export const cdata = (s) => '<![CDATA[' + String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';

export const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

/** 去掉 XML 非法控制字符与零宽字符（页面上常见的隐形垃圾，会让 RSS 校验失败） */
export const stripInvisible = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');

export const cleanText = (s) =>
  stripInvisible(decodeEntities(String(s).replace(/<[^>]+>/g, ' '))).replace(/[ \t\u00a0]+/g, ' ').trim();

/* ---------------- HTML 切片 ---------------- */
/** 从 startIdx（指向 <div）开始按 div 深度截取整个元素 */
export function sliceDiv(html, startIdx) {
  let depth = 0;
  let j = startIdx;
  while (j < html.length) {
    const o = html.indexOf('<div', j);
    const c = html.indexOf('</div>', j);
    if (c === -1) break;
    if (o !== -1 && o < c) {
      depth++;
      j = o + 4;
    } else {
      depth--;
      j = c + 6;
      if (depth === 0) return html.slice(startIdx, j);
    }
  }
  return html.slice(startIdx);
}

/* ---------------- 正文清洗 ---------------- */
/** 清洗规则版本：改动清洗逻辑时 +1，缓存里版本不一致会自动重抓 */
export const SANITIZER_VERSION = 3;

const KEEP_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'pre', 'code',
  'a', 'img',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const ATTR_KEEP = { a: ['href'], img: ['src', 'alt'] };

/** 判断一段加粗文字是不是小标题（一、 / （一） / 1. 开头） */
export const isSectionHeading = (t) =>
  /^([一二三四五六七八九十百]+[、.．]|（[一二三四五六七八九十百]+）|\([一二三四五六七八九十百]+\)|\d+[、.．])/.test(t);

export function sanitizeContent(raw) {
  let s = String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<o:p[\s\S]*?<\/o:p>/gi, '');

  // 逐个标签处理：白名单外的标签剥掉（保留内部文字），白名单内的只留必要属性
  s = s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*?)?)(\/?)>/g, (m, close, tag, attrs) => {
    const name = tag.toLowerCase();
    if (!KEEP_TAGS.has(name)) return '';
    if (close) return `</${name}>`;

    let kept = '';
    for (const attr of ATTR_KEEP[name] || []) {
      const re = new RegExp(`\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
      const mm = attrs.match(re);
      const v = ((mm && (mm[2] ?? mm[3] ?? mm[4])) || '').trim();
      if (!v) continue;
      if (name === 'a' && !/^(https?:|mailto:|\/)/i.test(v)) continue;
      kept += ` ${attr}="${v.replace(/"/g, '&quot;')}"`;
    }
    return VOID_TAGS.has(name) ? `<${name}${kept}/>` : `<${name}${kept}>`;
  });

  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .replace(/<p>(?:<br\/?>|\s)*<\/p>/gi, '')
    .replace(/<p>&#160;<\/p>/gi, '')
    .trim();

  if (s && !s.startsWith('<')) s = '<p>' + s;

  // 小标题升级为块级标题标签：部分阅读器会丢掉行内 <strong>，但标题标签一定按粗体渲染
  s = s.replace(/<p>\s*<strong>([^<]{1,80})<\/strong>([\s\S]*?)<\/p>/g, (m, strongText, rest) => {
    const t = strongText.trim();
    const body = rest.trim();
    if (isSectionHeading(t)) return body ? `<h4>${t}</h4><p>${body}</p>` : `<h4>${t}</h4>`;
    if (!body) return `<h3>${t}</h3>`;
    return m;
  });

  return stripInvisible(s);
}

/** 把 HTML 里的相对链接/图片地址补成绝对地址（阅读器无法解析相对路径） */
export function absolutizeUrls(html, origin) {
  return String(html ?? '').replace(/\s(href|src)="([^"]*)"/gi, (m, attr, url) => {
    const u = url.trim();
    if (!u || /^(?:https?:|mailto:|data:|#|\/\/)/i.test(u)) {
      if (u.startsWith('//')) return ` ${attr}="https:${u}"`;
      return m;
    }
    const abs = origin + (u.startsWith('/') ? '' : '/') + u;
    return ` ${attr}="${abs}"`;
  });
}

/** 纯文本长度（用于截断判断） */
export const textLength = (html) =>
  decodeEntities(String(html).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().length;

/** 超出字数上限时，按 </p> 边界截断并补省略号 */
export function truncateHtml(html, max) {
  if (max <= 0 || textLength(html) <= max) return html;
  const parts = html.split(/(?<=<\/p>)/);
  let out = '';
  let len = 0;
  for (const p of parts) {
    const l = textLength(p);
    if (len + l > max) break;
    out += p;
    len += l;
  }
  return (out || html.slice(0, max)) + '<p>……（全文请点原文链接）</p>';
}

/* ---------------- 缓存 ---------------- */
export function loadContentCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && typeof c === 'object') return c;
  } catch {
    /* 首次运行 */
  }
  return {};
}

export function saveContentCache(file, cache) {
  try {
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[warn] 正文缓存写入失败：${e.message}`);
  }
}

/** 只保留当前条目用到的缓存，避免文件无限增长 */
export function pruneCache(cache, keepUrls) {
  const keep = new Set(keepUrls);
  let dropped = 0;
  for (const k of Object.keys(cache)) {
    if (!keep.has(k)) {
      delete cache[k];
      dropped++;
    }
  }
  return dropped;
}

/** 除构建时间外内容没变就不重写文件，返回 true 表示“无变化” */
export function unchangedFile(file, xml) {
  const signature = (s) =>
    s.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, '').replace(/<pubDate>[^<]*<\/pubDate>/, '');
  try {
    return signature(fs.readFileSync(file, 'utf8')) === signature(xml);
  } catch {
    return false;
  }
}

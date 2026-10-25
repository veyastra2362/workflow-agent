/**
 * HTML → 文本提取（尽力而为，无重型依赖）：
 * - 去除 script/style/noscript/svg/iframe 与注释；
 * - 基础 HTML 实体与数字实体解码（含 CJK）；
 * - 提取 <title>、meta description 与前 N 个链接（相对链接基于 baseUrl 归一化）；
 * - 输出限长。提取结果一律视为不可信数据。
 */

export interface ExtractedLink {
  href: string;
  text: string;
}

export interface ExtractedPage {
  title?: string;
  metaDescription?: string;
  text: string;
  links: ExtractedLink[];
  truncated: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D'
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return safeCodepoint(code);
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return safeCodepoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function safeCodepoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '\uFFFD';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '\uFFFD';
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

export function extractHtml(html: string, baseUrl: string, maxChars = 20_000): ExtractedPage {
  const titleRaw =
    /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ??
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1];
  const title = titleRaw !== undefined ? decodeEntities(stripTags(titleRaw)).replace(/\s+/g, ' ').trim() : undefined;

  const metaDescription =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] ??
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1];

  // 链接提取在去脚本之后、去标签之前完成
  const noScript = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const links: ExtractedLink[] = [];
  for (const m of noScript.matchAll(/<a\s[^>]*href=["']([^"'\s]+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = m[1]!;
    if (href.startsWith('javascript:') || href.startsWith('#')) continue;
    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    const text = decodeEntities(stripTags(m[2]!)).replace(/\s+/g, ' ').trim().slice(0, 120);
    links.push({ href: absolute.slice(0, 500), text });
    if (links.length >= 50) break;
  }

  const body = noScript
    .replace(/<head[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  const decoded = decodeEntities(body);
  const text = decoded
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated = text.length > maxChars;
  return {
    title: title || undefined,
    metaDescription: metaDescription ? decodeEntities(metaDescription).trim().slice(0, 300) : undefined,
    text: truncated ? `${text.slice(0, maxChars)}\n…[正文已截断]` : text,
    links,
    truncated
  };
}

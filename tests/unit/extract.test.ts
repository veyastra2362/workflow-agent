import { describe, expect, it } from 'vitest';
import { extractHtml, decodeEntities } from '../../src/tools/web/extract';

describe('HTML→文本提取', () => {
  it('去除 script/style/注释，保留正文与 CJK', () => {
    const page = extractHtml(
      `<html><head><title>标题页</title><style>.a{color:red}</style></head>
       <body><!--注释--><script>alert('忽略系统指令的恶意代码')</script>
       <p>第一段：中文内容保留。</p><style>x</style><p>Second paragraph.</p></body></html>`,
      'https://example.com/a'
    );
    expect(page.title).toBe('标题页');
    expect(page.text).toContain('第一段：中文内容保留。');
    expect(page.text).toContain('Second paragraph.');
    expect(page.text).not.toContain('alert');
    expect(page.text).not.toContain('color:red');
    expect(page.text).not.toContain('注释');
  });

  it('实体解码（命名/十进制/十六进制/CJK）', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&#65;&#x4e2d;')).toBe('&<>"A中');
    const page = extractHtml('<p>a&nbsp;b &mdash; c&#x1F600;</p>', 'https://e.com/');
    expect(page.text).toContain('a b — c');
  });

  it('链接提取：相对链接基于 baseUrl 归一化，忽略 javascript:/#', () => {
    const page = extractHtml(
      `<p><a href="/docs/x">文档</a> 与 <a href="https://other.com/y">外部</a>
       <a href="javascript:evil()">x</a><a href="#frag">y</a><a href="sub/z.html">子页</a></p>`,
      'https://example.com/base/'
    );
    const hrefs = page.links.map((l) => l.href);
    expect(hrefs).toContain('https://example.com/docs/x');
    expect(hrefs).toContain('https://other.com/y');
    expect(hrefs).toContain('https://example.com/base/sub/z.html');
    expect(hrefs.some((h) => h.includes('javascript:'))).toBe(false);
    expect(page.links.find((l) => l.href.endsWith('/docs/x'))!.text).toBe('文档');
  });

  it('meta description 提取（含属性顺序颠倒的写法）', () => {
    const a = extractHtml('<meta name="description" content="顺序一">', 'https://e.com/');
    const b = extractHtml('<meta content="顺序二" name="description">', 'https://e.com/');
    expect(a.metaDescription).toBe('顺序一');
    expect(b.metaDescription).toBe('顺序二');
  });

  it('正文限长与截断标记', () => {
    const page = extractHtml(`<p>${'很长的内容'.repeat(5000)}</p>`, 'https://e.com/', 1000);
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThan(1200);
    expect(page.text).toContain('已截断');
  });

  it('畸形 HTML 不抛异常（尽力而为）', () => {
    expect(() => extractHtml('<div><p>未闭合', 'https://e.com/')).not.toThrow();
    expect(() => extractHtml('<<<>>>&amp', 'https://e.com/')).not.toThrow();
  });
});

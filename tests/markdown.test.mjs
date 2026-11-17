import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, markdownChunks } from '../dist/markdown.js';

const spans = rendered => rendered.entities.map(e => [e.type, rendered.text.slice(e.offset, e.offset + e.length), e.url, e.language]);

test('Markdown headings, nested emphasis, links and code become Telegram entities', () => {
  const r = renderMarkdown('# Heading\n\n**Bold _nested_** and ~~gone~~ with [docs](https://example.com/a_(b)?x=1&y=2) and `a_b < c`.');
  assert.equal(r.text, 'Heading\n\nBold nested and gone with docs and a_b < c.');
  assert.deepEqual(spans(r).map(s => s.slice(0, 2)), [
    ['bold', 'Heading'], ['bold', 'Bold nested'], ['italic', 'nested'], ['strikethrough', 'gone'], ['text_link', 'docs'], ['code', 'a_b < c'],
  ]);
  assert.equal(r.entities.find(e => e.type === 'text_link').url, 'https://example.com/a_(b)?x=1&y=2');
});

test('raw HTML stays literal, character references decode, and escapes stay visible', () => {
  const r = renderMarkdown('<b>Literal</b> &amp; &lt;safe&gt; \\*stars\\*');
  assert.equal(r.text, '<b>Literal</b> & <safe> *stars*');
  assert.equal(r.entities.length, 0);
});

test('links to local files or unsupported schemes remain readable text', () => {
  const r = renderMarkdown('[local](/tmp/file.py) [bad](javascript:alert) [email](mailto:test@example.com)');
  assert.match(r.text, /local \(\/tmp\/file.py\)/); assert.match(r.text, /bad \(javascript:alert\)/);
  assert.deepEqual(r.entities.map(e => e.url), ['mailto:test@example.com']);
});

test('code within emphasis or links never overlaps incompatible entities', () => {
  const r = renderMarkdown('**before `code` after** [start `literal` end](https://example.com)');
  for (const code of r.entities.filter(e => e.type === 'code')) {
    assert.ok(r.entities.every(e => e === code || e.offset + e.length <= code.offset || e.offset >= code.offset + code.length));
  }
});

test('lists, task lists, quotes and tables have readable Telegram text', () => {
  const r = renderMarkdown('- First\n- [x] Done\n\n> **Quoted**\n\n| Name | Status |\n| --- | --- |\n| Bridge | Ready |');
  assert.match(r.text, /• First\n• ☑ Done/); assert.match(r.text, /│ Quoted/);
  assert.match(r.text, /Name \| Status\nBridge \| Ready/);
  assert.ok(spans(r).some(s => s[0] === 'bold' && s[1] === 'Quoted'));
});

test('incomplete Markdown and unclosed code fences remain deliverable', () => {
  assert.match(renderMarkdown('**unfinished and [broken').text, /\*\*unfinished and \[broken/);
  const r = renderMarkdown('```python\nprint("hi")');
  assert.equal(r.text, 'print("hi")'); assert.equal(r.entities[0].type, 'pre'); assert.equal(r.entities[0].language, 'python');
});

test('long code blocks retain exact whitespace and pre entities in each labelled chunk', () => {
  const code = ('    print("😀 <>&_")\n').repeat(450) + '  last';
  const chunks = markdownChunks('```python\n' + code + '\n```', '[Thread · 12345678]');
  assert.ok(chunks.length > 2);
  assert.equal(chunks.map(c => c.text.slice(c.text.indexOf('\n') + 1)).join(''), code);
  for (const c of chunks) {
    assert.ok(c.text.length <= 3800); assert.ok(c.text.startsWith('[Thread · 12345678]'));
    assert.deepEqual(c.entities, [{ type: 'pre', language: 'python', offset: c.text.indexOf('\n') + 1, length: c.text.length - c.text.indexOf('\n') - 1 }]);
    assert.ok(!/[\uD800-\uDBFF]$/.test(c.text));
  }
});

test('Unicode offsets and formatting across hard chunk boundaries use UTF-16 units', () => {
  const source = '**' + '😀'.repeat(6000) + '**';
  const chunks = markdownChunks(source, '[😀]');
  assert.equal(chunks.map(c => c.text.slice(c.text.indexOf('\n') + 1)).join(''), '😀'.repeat(6000));
  for (const c of chunks) {
    const body = c.text.slice(c.text.indexOf('\n') + 1);
    assert.ok(!/[\uD800-\uDBFF]$/.test(c.text)); assert.ok(!/^[\uDC00-\uDFFF]/.test(body));
    assert.deepEqual(c.entities, [{ type: 'bold', offset: c.text.indexOf('\n') + 1, length: body.length }]);
  }
});


test('nested lists retain their hierarchy', () => {
  assert.equal(renderMarkdown('- Parent\n  - Child\n- Next').text, '• Parent\n  • Child\n• Next');
});

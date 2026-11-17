import { Lexer, type Token } from 'marked';
import { decodeHTML } from 'entities';

export type Entity = { type: 'bold' | 'italic' | 'strikethrough' | 'code' | 'pre' | 'text_link'; offset: number; length: number; url?: string; language?: string };
type Style = Omit<Entity, 'offset' | 'length'>;
export type Formatted = { text: string; entities: Entity[] };

// Render the Markdown AST directly to text/entities: raw HTML never becomes markup.
export function renderMarkdown(source: string): Formatted {
  let text = '';
  const entities: Entity[] = [];
  const write = (value: string, styles: Style[] = []) => {
    const offset = text.length; text += value;
    for (const style of styles) if (value.length) entities.push({ ...style, offset, length: value.length });
  };
  const newline = (count = 2) => {
    const have = /\n*$/.exec(text)![0].length;
    if (have < count) write('\n'.repeat(count - have));
  };
  const walk = (tokens: Token[], styles: Style[] = [], depth = 0, compact = false, listLevel = 0): void => {
    for (const t of tokens) {
      if (depth > 40) { write(t.raw, styles); continue; }
      const inner = (next = styles) => walk(('tokens' in t ? t.tokens : undefined) ?? [], next, depth + 1, compact, listLevel);
      const styled = (style: Style) => inner([...styles.filter(s => s.type !== style.type), style]);
      switch (t.type) {
        case 'space': newline(compact ? 1 : 2); break;
        case 'def': break;
        case 'checkbox': write(t.checked ? '☑ ' : '☐ ', styles); break;
        case 'strong': styled({ type: 'bold' }); break;
        case 'em': styled({ type: 'italic' }); break;
        case 'del': styled({ type: 'strikethrough' }); break;
        case 'heading': styled({ type: 'bold' }); newline(); break;
        case 'paragraph': inner(); newline(compact ? 1 : 2); break;
        case 'text': if (t.tokens) inner(); else write(decodeHTML(t.text), styles); break;
        case 'escape': write(t.text, styles); break;
        case 'html': write(t.raw, styles); break;
        case 'br': write('\n'); break;
        case 'hr': write('────────'); newline(); break;
        case 'codespan': write(t.text, [{ type: 'code' }]); break;
        case 'code': {
          const language = String(t.lang ?? '').split(/\s/)[0];
          write(t.text, [{ type: 'pre', ...(/^[\w+-]{1,40}$/.test(language) ? { language } : {}) }]);
          newline(); break;
        }
        case 'link': case 'image': {
          const url = decodeHTML(t.href);
          const safe = /^(https?:\/\/|mailto:|tg:\/\/)/i.test(url) && !/[\x00-\x20\x7f]/.test(url);
          if (safe) styled({ type: 'text_link', url });
          else { inner(); write(` (${url})`, styles); }
          break;
        }
        case 'blockquote':
          // A visible quote prefix also works around Telegram's nesting limits.
          write('│ ', styles); inner(); newline(); break;
        case 'list': {
          if (text && !text.endsWith('\n')) newline(1);
          let number = Number(t.start) || 1;
          for (const item of t.items) {
            write('  '.repeat(listLevel) + (t.ordered ? `${number++}. ` : '• '));
            walk(item.tokens, styles, depth + 1, true, listLevel + 1); newline(1);
          }
          newline(compact ? 1 : 2); break;
        }
        case 'table': {
          // Keep tables readable on narrow clients without unsupported HTML tags.
          const rows = [t.header, ...t.rows];
          for (let row = 0; row < rows.length; row++) {
            rows[row].forEach((cell: { tokens: Token[] }, index: number) => {
              if (index) write(' | ');
              walk(cell.tokens, row === 0 ? [...styles.filter(s => s.type !== 'bold'), { type: 'bold' }] : styles, depth + 1, true);
            });
            write('\n');
          }
          newline(); break;
        }
        default: write(t.raw, styles);
      }
    }
  };
  try { walk(Lexer.lex(source, { gfm: true })); }
  catch { return { text: source, entities: [] }; }
  text = text.replace(/\n+$/, '');
  // Merge adjacent runs of the same style; leave code/pre isolated from emphasis.
  const groups = new Map<string, Entity[]>();
  for (const entity of entities) {
    entity.length = Math.min(entity.length, text.length - entity.offset);
    if (entity.length <= 0) continue;
    const key = JSON.stringify([entity.type, entity.url, entity.language]);
    const runs = groups.get(key) ?? [];
    const last = runs.at(-1);
    if (last && last.offset + last.length === entity.offset) last.length += entity.length;
    else runs.push(entity);
    groups.set(key, runs);
  }
  return { text, entities: [...groups.values()].flat().sort((a, b) => a.offset - b.offset || b.length - a.length) };
}

export function markdownChunks(source: string, header: string, limit = 3800): Formatted[] {
  const rendered = renderMarkdown(source);
  // Preserve whitespace/code and UTF-16 offsets; never split a surrogate pair.
  const capacity = limit - header.length - 40;
  if (capacity < 2) throw new Error('Thread label exceeds Telegram message capacity');
  const slices: { start: number; end: number }[] = [];
  for (let start = 0; start < rendered.text.length;) {
    let end = Math.min(start + capacity, rendered.text.length);
    if (end < rendered.text.length) {
      const line = rendered.text.lastIndexOf('\n', end - 1);
      if (line >= start + capacity / 2) end = line + 1;
      if (/[\uD800-\uDBFF]/.test(rendered.text[end - 1])) end--;
    }
    slices.push({ start, end }); start = end;
  }
  if (!slices.length) slices.push({ start: 0, end: 0 });
  return slices.map(({ start, end }, i) => {
    const prefix = header ? `${header}${slices.length > 1 ? ` (${i + 1}/${slices.length})` : ''}\n` : '';
    const entities = rendered.entities.flatMap(entity => {
      const left = Math.max(start, entity.offset), right = Math.min(end, entity.offset + entity.length);
      return right > left ? [{ ...entity, offset: prefix.length + left - start, length: right - left }] : [];
    });
    return { text: prefix + rendered.text.slice(start, end), entities };
  });
}

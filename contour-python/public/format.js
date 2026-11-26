import renderMathInElement from '/vendor/katex/contrib/auto-render.mjs';

const mathDelimiters = [
  { left: '\\(', right: '\\)', display: false },
  { left: '\\[', right: '\\]', display: true },
  { left: '$$', right: '$$', display: true },
];
const displayDelimiters = new Map(mathDelimiters.filter(({ display }) => display).map(({ left, right }) => [left, right]));

function displayEnd(lines, start) {
  const closing = displayDelimiters.get(lines[start].trim());
  if (!closing) return -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === closing) return i;
    if (displayDelimiters.has(line) || line.startsWith('```')) break;
  }
  return -1;
}

export function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function inline(target, text) {
  for (const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) target.append(node('code', '', part.slice(1, -1)));
    else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) target.append(node('strong', '', part.slice(2, -2)));
    else target.append(document.createTextNode(part));
  }
}

export function markdown(target, text) {
  const fragment = document.createDocumentFragment();
  const lines = text.split(/\r?\n/);
  let paragraph = [], list = null;
  const flush = () => {
    if (!paragraph.length) return;
    const p = node('p');
    inline(p, paragraph.join('\n'));
    fragment.append(p);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    const item = line.match(/^\s*([-*]|\d+\.)\s+(.+)/);
    if (!item) list = null;
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i]);
      const pre = node('pre');
      pre.append(node('code', '', code.join('\n')));
      fragment.append(pre);
    } else if (displayDelimiters.has(line.trim())) {
      const end = displayEnd(lines, i);
      if (end === -1) paragraph.push(line);
      else {
        flush();
        fragment.append(node('div', 'math-block', lines.slice(i, end + 1).join('\n')));
        i = end;
      }
    } else if (heading) {
      flush();
      const title = node(`h${Math.min(5, heading[1].length + 2)}`);
      inline(title, heading[2]);
      fragment.append(title);
    } else if (item) {
      flush();
      const type = /^\d/.test(item[1]) ? 'ol' : 'ul';
      if (!list || list.localName !== type) { list = node(type); fragment.append(list); }
      const li = node('li');
      inline(li, item[2]);
      list.append(li);
    } else if (line.trim()) paragraph.push(line);
    else flush();
  }
  flush();
  if (mathDelimiters.some(({ left }) => text.includes(left))) {
    renderMathInElement(fragment, {
      delimiters: mathDelimiters, output: 'mathml', trust: false, maxExpand: 250, maxSize: 30,
      errorCallback: () => {},
    });
  }
  target.replaceChildren(fragment);
}

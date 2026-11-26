import { node, icon, markdown } from './format.js';
import { setupAccess } from './access.js';
import { attachmentsUI } from './attachments.js';
import { fileText, MAX_CONTEXT_BINARY_DATA, MAX_CONTEXT_TEXT, MAX_MESSAGE_TEXT } from './attachment-policy.js';

const $ = id => document.getElementById(id);
const prompt = $('prompt');
const mobile = matchMedia('(max-width: 760px)');
const storageKey = 'contour:chats';
let session = { role: null, configured: false };
let chats = loadChats();
let current = null, running = null, noticeVersion = 0;
let thinking = false, streaming = true, preparing = false;

function loadChats() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(data)) return data.filter(chat => typeof chat?.id === 'string' && typeof chat?.title === 'string' && Array.isArray(chat?.messages));
  } catch { /* Storage can be disabled or unavailable. */ }
  return [];
}

function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify(chats, (key, value) => key === 'files' ? value.map(({ name, mime }) => ({ name, mime })) : value)); }
  catch { notice('Не удалось сохранить историю в этом браузере.'); }
}

function notice(text, disappear = false) {
  const version = ++noticeVersion;
  $('notice').textContent = text;
  $('notice').hidden = !text;
  if (text && disappear) setTimeout(() => { if (noticeVersion === version) notice(''); }, 5000);
}

function updateSession(data) {
  const previous = session.role;
  session = data;
  $('account').replaceChildren(icon(session.role ? 'user' : 'lock'), node('span', '', session.role ? 'Выйти' : 'Войти'));
  $('model-label').textContent = session.configured ? session.model : 'Модель не подключена';
  $('model-status').classList.toggle('connected', session.configured);
  $('model-status').title = session.configured ? `Модель: ${session.model}` : 'Владелец ещё не настроил API';
  paintModes();
  if (previous !== session.role) renderChat();
}

function paintModes() {
  $('thinking').setAttribute('aria-pressed', String(thinking && (!session.configured || session.thinking)));
  $('streaming').setAttribute('aria-pressed', String(streaming && (!session.configured || session.streaming)));
}

function togglePanel(open, focus = true) {
  $('workspace').classList.toggle('sidebar-open', open);
  $('side-overlay').hidden = !open;
  $('mobile-menu').setAttribute('aria-expanded', String(open));
  $('sidebar').inert = mobile.matches && !open;
  if (mobile.matches && focus) (open ? $('new-chat') : $('mobile-menu')).focus();
}

function renderHistory() {
  const list = $('history-list');
  list.replaceChildren();
  const visible = session.role ? chats : [];
  $('history-count').textContent = String(visible.length).padStart(2, '0');
  $('history-empty').hidden = visible.length > 0;
  for (const chat of visible) {
    const li = node('li', chat === current ? 'current' : '');
    const item = node('button', 'history-item');
    item.type = 'button';
    item.title = chat.title;
    if (chat === current) item.setAttribute('aria-current', 'true');
    item.append(icon('chat'), node('span', '', chat.title));
    item.addEventListener('click', () => selectChat(chat));
    const remove = node('button', 'icon-btn history-delete');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Удалить диалог: ${chat.title}`);
    remove.append(icon('trash'));
    remove.addEventListener('click', () => {
      if (!confirm('Удалить этот диалог из истории браузера?')) return;
      if (running?.chat === chat) running.controller.abort();
      chats = chats.filter(item => item !== chat);
      if (chat === current) selectChat(null);
      else renderHistory();
      persist();
    });
    li.append(item, remove);
    list.append(li);
  }
}

function appendMessage(message, pending = false) {
  const user = message.role === 'user';
  const article = node('article', `message ${user ? 'user' : 'assistant'}`);
  article.dataset.role = message.role;
  const avatar = node('div', `message-icon${user ? ' message-user-icon' : ''}`);
  if (user) avatar.append(icon('user'));
  else {
    const img = node('img');
    img.src = '/mark.svg'; img.alt = '';
    avatar.append(img);
  }
  const content = node('div', 'message-text');
  const body = node('div', 'message-body');
  if (user) body.textContent = message.content;
  else {
    content.append(node('span', 'message-name', message.model || session.model || 'Контур'));
    if (message.content) markdown(body, message.content);
    else if (pending) body.append(node('span', 'pending', running?.thinking ? 'Модель думает' : 'Готовлю ответ'));
  }
  content.append(body);
  if (message.files?.length) {
    const list = node('ul', 'attachment-list');
    list.setAttribute('aria-label', 'Вложения');
    for (const file of message.files) {
      const item = node('li', 'attachment-chip');
      item.title = file.data === undefined ? `${file.name} · в истории сохранено только имя` : file.name;
      item.append(icon('file'), node('span', '', file.name));
      list.append(item);
    }
    content.append(list);
  }
  if (!pending) content.append(copyButton(message, user));
  article.append(avatar, content);
  $('messages').append(article);
}

function copyButton(message, user) {
  const copy = node('button', 'icon-btn message-copy');
  const label = node('span', '', 'Копировать целиком');
  copy.type = 'button';
  copy.setAttribute('aria-label', user ? 'Копировать сообщение целиком' : 'Копировать ответ целиком');
  copy.append(icon('copy'), label);
  let timer;
  copy.addEventListener('click', async () => {
    const names = message.files?.map(file => file.name).join(', ');
    const text = names ? [message.content, `Вложения: ${names}`].filter(Boolean).join('\n\n') : message.content;
    try {
      await copyText(text);
      copy.dataset.copied = '';
      copy.replaceChildren(icon('check'), label);
      label.textContent = 'Скопировано';
      notice(user ? 'Сообщение скопировано.' : 'Ответ скопирован целиком.', true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        delete copy.dataset.copied;
        copy.replaceChildren(icon('copy'), label);
        label.textContent = 'Копировать целиком';
      }, 2200);
    } catch { notice('Не удалось скопировать. Выделите текст и скопируйте вручную.', true); }
  });
  return copy;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try legacy clipboard support. */ }
  }
  const input = node('textarea', 'clipboard-fallback');
  const focused = document.activeElement;
  input.value = text;
  input.readOnly = true;
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    input.remove();
    focused?.focus({ preventScroll: true });
  }
}

function scrollToEnd() { $('content').scrollTop = $('content').scrollHeight; }

function paintSend() {
  const stop = running && running.chat === current;
  $('send').replaceChildren(icon(stop ? 'stop' : 'send'));
  $('send').setAttribute('aria-label', stop ? 'Остановить генерацию' : 'Отправить сообщение');
}

function renderChat(stick = true) {
  const opened = Boolean(session.role && current?.messages.length);
  $('welcome').hidden = opened;
  $('messages').hidden = !opened;
  $('chat-heading').textContent = opened ? current.title : 'Новый диалог';
  $('messages').replaceChildren();
  if (opened) {
    for (const message of current.messages) appendMessage(message);
    if (running?.chat === current) appendMessage(running.reply, true);
    if (stick) scrollToEnd();
  } else $('content').scrollTop = 0;
  renderHistory();
  paintSend();
}

function selectChat(chat) {
  current = chat;
  prompt.value = '';
  attachments.set([]);
  notice('');
  renderChat();
  togglePanel(false, false);
  (mobile.matches ? $('mobile-menu') : prompt).focus();
}

function context(messages) {
  const selected = [];
  let usedText = 0, usedBinary = 0;
  for (const { role, content, files = [] } of messages.slice(-32).reverse()) {
    const text = content.slice(0, MAX_MESSAGE_TEXT);
    const available = files.filter(file => typeof file.data === 'string');
    if (!text.trim() && !available.length) continue;
    const textSize = [text, ...available.filter(file => file.mime === 'text/plain').map(file => fileText(file.name, file.data))].filter(Boolean).join('\n\n').length;
    const binarySize = available.reduce((total, file) => total + (file.mime === 'text/plain' ? 0 : file.data.length), 0);
    if (usedText + textSize > MAX_CONTEXT_TEXT || usedBinary + binarySize > MAX_CONTEXT_BINARY_DATA) break;
    usedText += textSize;
    usedBinary += binarySize;
    selected.unshift({ role, content: text, ...(available.length && { files: available }) });
  }
  return selected;
}

function nearEnd() {
  const panel = $('content');
  return panel.scrollHeight - panel.clientHeight - panel.scrollTop < 90;
}

async function answer(chat) {
  const request = { chat, controller: new AbortController(), thinking: session.thinking && thinking,
    reply: { role: 'assistant', content: '', model: session.model } };
  running = request;
  renderChat();
  let completed = false, frame = 0;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', signal: request.controller.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: context(chat.messages), stream: streaming, thinking: request.thinking }),
    });
    if (!response.ok) {
      if (response.status === 401) await access.refresh();
      throw new Error((await response.json()).error || 'Не удалось отправить сообщение.');
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const ingest = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'done') completed = true;
      if (event.type !== 'delta') return;
      request.reply.content += event.text;
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (current !== chat || !session.role) return;
        const stick = nearEnd();
        const last = $('messages').lastElementChild;
        if (last?.dataset.role === 'assistant') markdown(last.querySelector('.message-body'), request.reply.content);
        if (stick) scrollToEnd();
      });
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const lines = (buffer + value).split('\n');
        buffer = lines.pop();
        lines.forEach(ingest);
      }
      if (buffer) ingest(buffer);
    } finally { await reader.cancel().catch(() => {}); }
    if (!completed) throw new Error('Соединение прервалось до окончания ответа.');
  } catch (error) {
    if (current === chat) notice(error.name === 'AbortError' ? 'Генерация остановлена.' : error.message);
    if (!request.reply.content && current === chat && chats.includes(chat) && !prompt.value && !attachments.files.length && !attachments.busy) {
      const failed = chat.messages.pop();
      if (failed) {
        prompt.value = failed.content;
        attachments.set(failed.files ?? []);
      }
      if (!chat.messages.length) { chats = chats.filter(item => item !== chat); current = null; }
    }
  } finally {
    cancelAnimationFrame(frame);
    if (request.reply.content) chat.messages.push(request.reply);
    running = null;
    persist();
    if (current === chat || current === null) renderChat(nearEnd());
    else paintSend();
  }
}

async function submit() {
  if (attachments.busy) { notice('Дождись, пока прочитаются файлы.', true); return; }
  if ((!prompt.value.trim() && !attachments.files.length) || preparing) { prompt.focus(); return; }
  if (running) { notice('Дождитесь завершения ответа в другом диалоге.', true); return; }
  if (!session.role) { access.login('guest', true); return; }
  if (!session.configured) {
    preparing = true;
    try { await access.refresh(); }
    catch { notice('Не удалось проверить подключение к серверу.', true); return; }
    finally { preparing = false; }
    if (!session.role) { access.login('guest', true); return; }
    if (!session.configured) {
      if (session.role === 'admin') await access.settings();
      else notice('Модель ещё не подключена. Попросите администратора настроить API.');
      return;
    }
  }
  const text = prompt.value.trim(), files = attachments.files;
  if (attachments.busy || (!text && !files.length)) return;
  if (!current) {
    const title = (text || files[0].name).replace(/\s+/g, ' ');
    current = { id: crypto.randomUUID?.() ?? String(Date.now()), title: title.length > 55 ? `${title.slice(0, 55)}…` : title, messages: [] };
    chats = [current, ...chats].slice(0, 30);
  }
  current.messages.push({ role: 'user', content: text, ...(files.length && { files }) });
  prompt.value = '';
  attachments.set([]);
  notice('');
  persist();
  await answer(current);
}

const attachments = attachmentsUI({ composer: $('composer'), input: $('attachment-input'), button: $('attach'), tray: $('attachment-tray'), notice });

const access = setupAccess({
  session: () => session, updateSession, notice, submit,
  onLogout: () => {
    current = null;
    prompt.value = '';
    running?.controller.abort();
    attachments.set([]);
    chats = loadChats();
    notice('');
  },
});
$('mobile-menu').addEventListener('click', () => togglePanel(!$('workspace').classList.contains('sidebar-open')));
$('side-overlay').addEventListener('click', () => togglePanel(false));
mobile.addEventListener('change', () => togglePanel(false, false));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('dialog').open && !$('side-overlay').hidden) togglePanel(false); });
togglePanel(false, false);
$('new-chat').addEventListener('click', () => selectChat(null));
$('settings').addEventListener('click', () => { togglePanel(false); access.settings(); });
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => {
  prompt.value = button.dataset.prompt;
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
});
$('thinking').addEventListener('click', () => {
  if (session.configured && !session.thinking) { notice('Для этой модели режим рассуждения не настроен.', true); return; }
  thinking = !thinking;
  paintModes();
});
$('streaming').addEventListener('click', () => {
  if (session.configured && !session.streaming) { notice('Потоковый ответ отключён в настройках API.', true); return; }
  streaming = !streaming;
  paintModes();
});
$('composer').addEventListener('submit', event => {
  event.preventDefault();
  if (running && current === running.chat) running.controller.abort();
  else submit();
});
prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!running) $('composer').requestSubmit();
  }
});

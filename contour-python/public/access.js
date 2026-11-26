const $ = id => document.getElementById(id);
const dialog = $('dialog');

async function api(path, payload, method = 'POST') {
  const response = await fetch(path, payload === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Не удалось выполнить запрос.'), { status: response.status });
  return data;
}

function formError(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}

function resetSecret(input, reveal, label) {
  $(input).value = '';
  $(input).type = 'password';
  $(reveal).setAttribute('aria-pressed', 'false');
  $(reveal).setAttribute('aria-label', `Показать ${label}`);
}

export function setupAccess({ session, updateSession, notice, submit, onLogout }) {
  let dialogMode, dialogVersion = 0, sendAfterLogin = false, sessionVersion = 0;

  function showDialog(mode) {
    dialogMode = mode;
    const version = ++dialogVersion;
    const settings = mode === 'settings', admin = mode === 'admin';
    $('dialog-title').textContent = settings ? 'Подключение модели' : admin ? 'Вход администратора' : 'Войти в Контур';
    $('dialog-subtitle').textContent = settings ? 'Эта модель будет доступна всем, кто войдёт в чат. Ключ остаётся на сервере.' : admin ? 'Введите отдельный пароль владельца, чтобы изменить настройки API.' : 'Введите общий пароль, чтобы общаться с моделью.';
    $('dialog-symbol').setAttribute('href', settings ? '#i-settings' : '#i-lock');
    $('login-form').hidden = settings;
    $('settings-form').hidden = !settings;
    $('switch-login').textContent = admin ? 'Вернуться к входу в чат' : 'Вход для администратора';
    resetSecret('password', 'reveal-password', 'пароль');
    formError('login-error', '');
    if (!dialog.open) dialog.showModal();
    (settings ? $('api-url') : $('password')).focus();
    return version;
  }

  function login(mode = 'guest', pending = false) {
    sendAfterLogin = pending;
    showDialog(mode);
  }

  async function settings() {
    sendAfterLogin = false;
    if (session().role !== 'admin') { login('admin'); return; }
    const version = showDialog('settings');
    $('settings-form').reset();
    resetSecret('api-key', 'reveal-key', 'ключ');
    $('api-key').placeholder = 'Ключ провайдера';
    $('api-key').required = true;
    $('api-effort').disabled = true;
    $('save-settings').disabled = true;
    formError('settings-error', '');
    try {
      const data = await api('/api/settings');
      if (!dialog.open || dialogVersion !== version) return;
      $('api-url').value = data.url || '';
      $('api-model').value = data.model || '';
      $('api-key').placeholder = data.hasKey ? 'Ключ сохранён · введите новый для замены' : 'Ключ провайдера';
      $('api-key').required = !data.hasKey;
      $('api-stream').checked = data.streaming ?? true;
      $('api-reasoning').value = data.reasoning || 'off';
      $('api-effort').value = data.effort || 'medium';
      $('api-effort').disabled = $('api-reasoning').value === 'off';
      $('save-settings').disabled = false;
    } catch (error) {
      if (!dialog.open || dialogVersion !== version) return;
      if (error.status === 403) { login('admin'); return; }
      formError('settings-error', error.message);
    }
  }

  async function refresh() {
    const version = sessionVersion;
    const data = await api('/api/session');
    if (version === sessionVersion) updateSession(data);
  }

  const tryRefresh = () => refresh().catch(() => notice('Не удалось связаться с сервером. Попробуйте обновить страницу.', true));
  window.addEventListener('focus', tryRefresh);
  tryRefresh();
  $('account').addEventListener('click', async () => {
    if (!session().role) { login(); return; }
    $('account').disabled = true;
    try {
      const data = await api('/api/logout', {});
      sessionVersion++;
      onLogout();
      updateSession(data);
    } catch (error) { notice(error.message); }
    finally { $('account').disabled = false; }
  });
  $('close-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    ++dialogVersion;
    sendAfterLogin = false;
    resetSecret('password', 'reveal-password', 'пароль');
    resetSecret('api-key', 'reveal-key', 'ключ');
  });
  $('switch-login').addEventListener('click', () => showDialog(dialogMode === 'guest' ? 'admin' : 'guest'));
  for (const [input, button, label] of [['password', 'reveal-password', 'пароль'], ['api-key', 'reveal-key', 'ключ']]) {
    $(button).addEventListener('click', () => {
      const show = $(input).type === 'password';
      $(input).type = show ? 'text' : 'password';
      $(button).setAttribute('aria-pressed', String(show));
      $(button).setAttribute('aria-label', `${show ? 'Скрыть' : 'Показать'} ${label}`);
    });
  }
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    formError('login-error', '');
    $('login-submit').disabled = true;
    const admin = dialogMode === 'admin';
    const version = dialogVersion;
    const pending = sendAfterLogin;
    try {
      const data = await api('/api/login', { password: $('password').value, admin });
      sessionVersion++;
      updateSession(data);
      if (!dialog.open || version !== dialogVersion) return;
      if (admin) await settings();
      else {
        dialog.close();
        $('prompt').focus();
        if (pending) submit();
      }
    } catch (error) {
      if (dialog.open && version === dialogVersion) formError('login-error', error.message);
    } finally { $('login-submit').disabled = false; }
  });
  $('api-reasoning').addEventListener('change', () => { $('api-effort').disabled = $('api-reasoning').value === 'off'; });
  $('settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    formError('settings-error', '');
    $('save-settings').disabled = true;
    const version = dialogVersion;
    try {
      const data = await api('/api/settings', {
        url: $('api-url').value, key: $('api-key').value, model: $('api-model').value,
        streaming: $('api-stream').checked, reasoning: $('api-reasoning').value, effort: $('api-effort').value,
      }, 'PUT');
      sessionVersion++;
      updateSession({ ...data, role: session().role });
      if (dialog.open && version === dialogVersion) dialog.close();
      notice('Подключение сохранено для всех участников.', true);
    } catch (error) {
      if (dialog.open && version === dialogVersion) {
        formError('settings-error', error.message);
        $('save-settings').disabled = false;
      }
    }
  });
  return { login, settings, refresh };
}

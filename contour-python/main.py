import asyncio
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import tempfile
import time

import aiohttp
from aiohttp import web

from provider import MAX_CONTEXT_BINARY, ProviderError, endpoint, generate, normalize_messages, provider_client

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public' if (ROOT / 'public').is_dir() else ROOT.parent / 'public'
KATEX = PUBLIC / 'vendor' / 'katex'
if not KATEX.is_dir():
    KATEX = ROOT.parent / 'node_modules' / 'katex' / 'dist'
DAY = 86400
COOKIE = 'contour_session'
JSON_LIMIT = 512_000
CHAT_LIMIT = JSON_LIMIT + MAX_CONTEXT_BINARY
JS = 'text/javascript'
ASSETS = {
    '/': (PUBLIC / 'index.html', 'text/html'),
    '/style.css': (PUBLIC / 'style.css', 'text/css'),
    **{f'/{name}.js': (PUBLIC / f'{name}.js', JS) for name in (
        'app', 'access', 'attachment-policy', 'attachments', 'format')},
    **{f'/{name}.svg': (PUBLIC / f'{name}.svg', 'image/svg+xml') for name in ('mark', 'orbit')},
    **{f'/{name}.woff2': (PUBLIC / f'{name}.woff2', 'font/woff2') for name in (
        'golos', 'golos-latin', 'lora', 'lora-latin')},
    '/vendor/katex/katex.mjs': (KATEX / 'katex.mjs', JS),
    '/vendor/katex/contrib/auto-render.mjs': (KATEX / 'contrib' / 'auto-render.mjs', JS),
}


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def write_private(path, value):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(value)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def digest(value):
    return hashlib.sha256(value.encode('utf-8', errors='surrogatepass')).digest()


def send_json(value, status=200):
    return web.json_response(value, status=status, headers={'Cache-Control': 'no-store'})


async def read_json(request, limit=JSON_LIMIT):
    if request.content_type != 'application/json' or request.headers.get('Sec-Fetch-Site') == 'cross-site':
        raise RequestError(415, 'Ожидался JSON-запрос с этого сайта.')
    if request.content_length is not None and request.content_length > limit:
        raise RequestError(413, 'Запрос слишком большой.')
    data = bytearray()
    try:
        async with asyncio.timeout(15):
            async for chunk in request.content.iter_chunked(32_768):
                data.extend(chunk)
                if len(data) > limit:
                    raise RequestError(413, 'Запрос слишком большой.')
    except TimeoutError:
        raise RequestError(408, 'Время ожидания запроса истекло.') from None
    try:
        value = json.loads(data)
        if isinstance(value, dict):
            return value
    except (ValueError, RecursionError):
        pass
    raise RequestError(400, 'Не удалось прочитать запрос.')


def rate_limit(store, key, limit, span):
    now = time.monotonic()
    for expired in [item for item, (_, end) in store.items() if end <= now]:
        store.pop(expired)
    count, until = store.get(key, (0, now + span))
    if count >= limit or (key not in store and len(store) >= 5000):
        raise RequestError(429, 'Слишком много запросов. Попробуйте позже.')
    store[key] = (count + 1, until)


def clean(value, cap):
    return value.strip()[:cap + 1] if isinstance(value, str) else ''


def parse_settings(data, previous):
    url, model, submitted = (clean(data.get(name), cap) for name, cap in (('url', 512), ('model', 160), ('key', 2048)))
    key = submitted or (previous or {}).get('key', '')
    if (not 1 <= len(url) <= 512 or not 1 <= len(model) <= 160 or not 1 <= len(key) <= 2048
            or not re.fullmatch(r'[\x21-\x7e]+', key)):
        raise RequestError(400, 'Заполните URL API, ключ и название модели.')
    try:
        destination = endpoint(url)
        if previous and not submitted and endpoint(previous['url']).origin() != destination.origin():
            raise RequestError(400, 'При смене сервера API введите ключ заново.')
    except ProviderError as error:
        raise RequestError(400, str(error)) from None
    reasoning, effort = data.get('reasoning'), data.get('effort')
    return {
        'url': url, 'model': model, 'key': key, 'streaming': data.get('streaming') is True,
        'reasoning': reasoning if reasoning in ('effort', 'nested') else 'off',
        'effort': effort if effort in ('low', 'medium', 'high') else 'medium',
    }


def create_app(password, admin_password, data_dir, trust_proxy=False, complete=generate):
    if not password or len(password) > 1024:
        raise ValueError('Укажите пароль чата в CHAT_PASSWORD (до 1024 символов).')
    data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not admin_password:
        target = data_dir / 'admin-password'
        if not target.exists():
            write_private(target, secrets.token_urlsafe(24) + '\n')
        admin_password = target.read_text(encoding='utf-8').strip()
    if not admin_password or len(admin_password) > 1024 or hmac.compare_digest(digest(password), digest(admin_password)):
        raise ValueError('Задайте отдельный пароль администратора, отличный от гостевого.')
    guest_hash, admin_hash = digest(password), digest(admin_password)
    config_file = data_dir / 'provider.json'
    config = json.loads(config_file.read_text(encoding='utf-8')) if config_file.exists() else None
    sessions, auth_limit, chat_limit = {}, {}, {}
    active = set()
    client = None

    async def pool(_app):
        nonlocal client
        client, resolver = provider_client()
        try:
            yield
        finally:
            await client.close()
            await resolver.close()

    def visible():
        if not config:
            return {'configured': False}
        return {'configured': True, 'model': config['model'], 'streaming': config['streaming'],
                'thinking': config['reasoning'] != 'off'}

    def signed_in(request):
        saved = sessions.get(request.cookies.get(COOKIE, ''))
        return saved[0] if saved and saved[1] > time.monotonic() else None

    def is_proxy(request):
        return trust_proxy and request.remote in ('127.0.0.1', '::1')

    def address(request):
        forwarded = request.headers.get('X-Forwarded-For', '').split(',')[-1].strip() if is_proxy(request) else ''
        return forwarded or request.remote

    def set_cookie(response, request, value='', age=0):
        secure = request.secure or (is_proxy(request) and request.headers.get('X-Forwarded-Proto') == 'https')
        response.set_cookie(COOKIE, value, path='/', httponly=True, secure=secure, samesite='Strict', max_age=age)
        return response

    async def session(request):
        return send_json({'role': signed_in(request), **visible()})

    async def login(request):
        rate_limit(auth_limit, address(request), 12, 900)
        data = await read_json(request)
        admin, candidate = data.get('admin') is True, data.get('password')
        if not isinstance(candidate, str) or len(candidate) > 1024:
            candidate = ''
        if not hmac.compare_digest(digest(candidate), admin_hash if admin else guest_hash):
            raise RequestError(401, 'Неверный пароль.')
        now = time.monotonic()
        for expired in [token for token, (_, end) in sessions.items() if end <= now]:
            sessions.pop(expired)
        sessions.pop(request.cookies.get(COOKIE, ''), None)
        if len(sessions) >= 5000:
            raise RequestError(503, 'Слишком много активных сессий.')
        token, role = secrets.token_hex(32), 'admin' if admin else 'guest'
        sessions[token] = (role, now + DAY)
        return set_cookie(send_json({'role': role, **visible()}), request, token, DAY)

    async def logout(request):
        await read_json(request)
        sessions.pop(request.cookies.get(COOKIE, ''), None)
        return set_cookie(send_json({'role': None, **visible()}), request)

    async def settings(request):
        nonlocal config
        if signed_in(request) != 'admin':
            raise RequestError(403, 'Войдите как администратор, чтобы настроить подключение.')
        if request.method == 'GET':
            return send_json({**{k: v for k, v in config.items() if k != 'key'}, 'hasKey': True} if config else {})
        next_config = parse_settings(await read_json(request), config)
        write_private(config_file, json.dumps(next_config))
        config = next_config
        return send_json(visible())

    async def chat(request):
        if not signed_in(request):
            raise RequestError(401, 'Введите пароль, чтобы отправить сообщение.')
        selected = config
        if not selected:
            raise RequestError(409, 'Администратор ещё не подключил модель.')
        token = request.cookies[COOKIE]
        if token in active or len(active) >= 8:
            raise RequestError(429, 'Уже выполняется запрос. Попробуйте чуть позже.')
        rate_limit(chat_limit, address(request), 35, 60)
        active.add(token)
        try:
            data = await read_json(request, CHAT_LIMIT)
            try:
                messages = normalize_messages(data.get('messages'))
            except ValueError as error:
                raise RequestError(400, str(error)) from None
            response = web.StreamResponse(headers={
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
            })
            await response.prepare(request)
            async def emit(event):
                await response.write(json.dumps(event).encode() + b'\n')

            try:
                async with asyncio.timeout(120):
                    async for event in complete(client, selected, messages,
                                                selected['streaming'] and data.get('stream') is not False,
                                                data.get('thinking') is True):
                        await emit(event)
            except (ProviderError, TimeoutError, aiohttp.ClientError, ValueError) as error:
                message = str(error) if isinstance(error, ProviderError) else (
                    'Время ожидания ответа истекло.' if isinstance(error, TimeoutError)
                    else 'Не удалось связаться с API. Проверьте подключение.')
                await emit({'type': 'error', 'message': message})
            await response.write_eof()
            return response
        finally:
            active.discard(token)

    async def asset(request):
        path, content_type = ASSETS[request.path]
        return web.FileResponse(path, headers={'Content-Type': content_type, 'Cache-Control': 'no-cache'})

    @web.middleware
    async def errors(request, handler):
        try:
            return await handler(request)
        except RequestError as error:
            return send_json({'error': str(error)}, error.status)
        except web.HTTPException as error:
            return send_json({'error': 'Страница не найдена или запрос не поддерживается.'}, error.status)
        except ConnectionError:
            raise
        except Exception as error:
            logging.error('Contour server error: %s', type(error).__name__)
            return send_json({'error': 'Ошибка сервера.'}, 500)

    async def headers(request, response):
        response.headers.update({
            'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        })

    app = web.Application(middlewares=[errors], client_max_size=CHAT_LIMIT)
    app.cleanup_ctx.append(pool)
    app.on_response_prepare.append(headers)
    app.router.add_get('/api/session', session)
    app.router.add_post('/api/login', login)
    app.router.add_post('/api/logout', logout)
    app.router.add_get('/api/settings', settings, allow_head=False)
    app.router.add_put('/api/settings', settings)
    app.router.add_post('/api/chat', chat)
    for route in ASSETS:
        app.router.add_get(route, asset)
    return app


def load_env(path):
    if not path.is_file():
        return
    allowed = {'CHAT_PASSWORD', 'CHAT_ADMIN_PASSWORD', 'CHAT_DATA_DIR', 'TRUST_PROXY', 'HOST', 'PORT'}
    for index, raw in enumerate(path.read_text(encoding='utf-8-sig').splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        key, value = key.strip(), value.strip()
        if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', key):
            raise ValueError(f'Неверный формат .env (строка {index}).')
        if key not in allowed:
            continue
        if value.startswith(('"', "'")):
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError(f'Незакрытые кавычки в .env (строка {index}).')
            value = value[1:-1]
        if '\0' in value:
            raise ValueError(f'Некорректное значение в .env (строка {index}).')
        os.environ.setdefault(key, value)


if __name__ == '__main__':
    try:
        load_env(ROOT / '.env')
        app = create_app(os.getenv('CHAT_PASSWORD'), os.getenv('CHAT_ADMIN_PASSWORD'),
                         Path(os.getenv('CHAT_DATA_DIR', str(ROOT / '.data'))), os.getenv('TRUST_PROXY') == '1')
    except ValueError as error:
        raise SystemExit(str(error)) from None
    web.run_app(app, host=os.getenv('HOST', '127.0.0.1'), port=int(os.getenv('PORT', '8000')),
                access_log=None, handler_cancellation=True)

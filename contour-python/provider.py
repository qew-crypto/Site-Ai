import base64
import binascii
import ipaddress
import json
import re
import socket

import aiohttp
from aiohttp.abc import AbstractResolver
from aiohttp.resolver import ThreadedResolver
from yarl import URL

MAX_BINARY = 1024 * 1024
MAX_ENCODED = 4 * ((MAX_BINARY + 2) // 3)
MAX_CONTEXT_BINARY = 2 * MAX_ENCODED
MAX_RESPONSE = 2_000_000


class ProviderError(Exception):
    pass


def public_ipv4(address):
    try:
        ip = ipaddress.IPv4Address(address)
        return ip.is_global and not ip.is_multicast and not ip.is_reserved
    except ValueError:
        return False


def endpoint(address):
    try:
        url = URL(address)
        host = url.raw_host or ''
        if (url.scheme != 'https' or '.' not in host or url.raw_user is not None
                or url.query_string or url.fragment or ':' in host):
            raise ValueError
        try:
            ip = ipaddress.IPv4Address(host)
        except ValueError:
            ip = None
        if ip is not None and not public_ipv4(host):
            raise ValueError
        url.port  # Validate an explicit port before it reaches the client.
        path = url.path.rstrip('/')
        if not path.endswith('/chat/completions'):
            path += '/chat/completions'
        return url.with_path(path)
    except (ValueError, UnicodeError):
        raise ProviderError('Нужен публичный HTTPS-адрес API без логина, параметров и фрагмента.') from None


class PublicResolver(AbstractResolver):
    def __init__(self):
        self.resolver = ThreadedResolver()

    async def resolve(self, host, port=0, family=socket.AF_INET):
        addresses = await self.resolver.resolve(host, port, socket.AF_INET)
        if not addresses or any(not public_ipv4(entry['host']) for entry in addresses):
            raise OSError('Provider must resolve to public IPv4 addresses')
        return addresses

    async def close(self):
        await self.resolver.close()


def normalize_messages(messages):
    invalid = 'История или сообщение слишком длинные либо имеют неверный формат.'
    bad_file = 'Вложение повреждено, слишком большое или имеет неподдерживаемый формат.'
    if (not isinstance(messages, list) or not 1 <= len(messages) <= 32
            or not isinstance(messages[-1], dict) or messages[-1].get('role') != 'user'):
        raise ValueError('Нужно отправить сообщение.')
    text_size = binary_size = 0
    output = []
    for message in messages:
        if not isinstance(message, dict):
            raise ValueError(invalid)
        role, content, files = message.get('role'), message.get('content'), message.get('files', [])
        if (role not in ('user', 'assistant') or not isinstance(content, str) or len(content) > 30_000
                or not isinstance(files, list) or len(files) > 3 or (files and role != 'user')
                or (not content.strip() and not files)):
            raise ValueError(invalid)
        text = [content] if content.strip() else []
        parts = []
        for file in files:
            if not isinstance(file, dict):
                raise ValueError(bad_file)
            name, mime, data = file.get('name'), file.get('mime'), file.get('data')
            if (not isinstance(name, str) or not name.strip() or len(name) > 160
                    or re.search(r'[\x00-\x1f\x7f/\\]', name) or not isinstance(data, str) or not data):
                raise ValueError(bad_file)
            if mime == 'text/plain':
                if len(data) > 20_000 or '\0' in data:
                    raise ValueError(bad_file)
                text.append(f'Прикреплённый файл {json.dumps(name, ensure_ascii=False)} (содержимое):\n{data}')
                continue
            binary_size += len(data)
            if (mime not in ('image/png', 'image/jpeg', 'image/webp', 'application/pdf')
                    or len(data) > MAX_ENCODED or binary_size > MAX_CONTEXT_BINARY):
                raise ValueError(bad_file)
            try:
                decoded = base64.b64decode(data, validate=True)
            except (ValueError, binascii.Error):
                raise ValueError(bad_file) from None
            matches = (
                (mime == 'image/png' and decoded.startswith(b'\x89PNG\r\n\x1a\n'))
                or (mime == 'image/jpeg' and decoded.startswith(b'\xff\xd8\xff'))
                or (mime == 'image/webp' and decoded.startswith(b'RIFF') and decoded[8:12] == b'WEBP')
                or (mime == 'application/pdf' and decoded.startswith(b'%PDF-'))
            )
            if not matches or len(decoded) > MAX_BINARY or base64.b64encode(decoded).decode() != data:
                raise ValueError(bad_file)
            url = f'data:{mime};base64,{data}'
            parts.append({'type': 'file', 'file': {'filename': name, 'file_data': url}} if mime == 'application/pdf'
                         else {'type': 'image_url', 'image_url': {'url': url}})
        full_text = '\n\n'.join(text)
        text_size += len(full_text)
        if text_size > 80_000:
            raise ValueError(invalid)
        output.append({'role': role, 'content': full_text if not parts else [
            {'type': 'text', 'text': full_text or 'Проанализируй прикреплённые файлы.'}, *parts]})
    return output


def parse_packet(data):
    try:
        packet = json.loads(data)
    except (ValueError, RecursionError):
        raise ProviderError('API вернул ответ в неизвестном формате.') from None
    if not isinstance(packet, dict):
        raise ProviderError('API вернул ответ в неизвестном формате.')
    return packet


async def read_limited(stream, maximum=MAX_RESPONSE):
    data = bytearray()
    async for chunk in stream.iter_chunked(16384):
        data.extend(chunk)
        if len(data) > maximum:
            raise ProviderError('Ответ API слишком большой.')
    return bytes(data)


async def packets(response, streaming):
    if not streaming:
        yield parse_packet(await read_limited(response.content))
        return
    data = []
    size = 0
    async for line in response.content:
        size += len(line)
        if size > MAX_RESPONSE:
            raise ProviderError('Ответ API слишком большой.')
        line = line.rstrip(b'\r\n')
        if not line and data:
            raw = b'\n'.join(data)
            if raw.strip() == b'[DONE]':
                return
            yield parse_packet(raw)
            data.clear()
        elif line.startswith(b'data:'):
            data.append(line[5:].lstrip(b' '))
    if data and b'\n'.join(data).strip() != b'[DONE]':
        yield parse_packet(b'\n'.join(data))


def answer_text(packet, streaming):
    if packet.get('error'):
        raise ProviderError('Провайдер вернул ошибку при генерации.')
    choices = packet.get('choices')
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ''
    choice = choices[0].get('delta' if streaming else 'message')
    if not isinstance(choice, dict):
        return ''
    text = choice.get('content') or choice.get('refusal')
    if isinstance(text, str):
        return text
    if isinstance(text, list):
        return ''.join(part['text'] for part in text if isinstance(part, dict) and isinstance(part.get('text'), str))
    return ''


def upstream_error(status, messages):
    if status in (400, 415, 422) and any(isinstance(message['content'], list) for message in messages):
        return 'Провайдер отклонил вложения. Проверьте поддержку изображений и PDF у этой модели.'
    return {
        400: 'Модель отклонила запрос. Проверьте имя модели и выбранные режимы.',
        401: 'API отклонил ключ. Попросите владельца проверить подключение.',
        402: 'Провайдер требует пополнить баланс API.',
        403: 'API отклонил ключ или запретил доступ к модели.',
        404: 'Не найдена модель или маршрут. Проверьте URL и название модели.',
        422: 'Модель отклонила запрос. Проверьте имя модели и выбранные режимы.',
        429: 'Достигнут лимит провайдера. Попробуйте чуть позже.',
    }.get(status, f'Провайдер не смог ответить (HTTP {status}).')


async def generate(client, settings, messages, stream, thinking):
    payload = {'model': settings['model'], 'messages': messages, 'stream': stream}
    if thinking and settings['reasoning'] == 'effort':
        payload['reasoning_effort'] = settings['effort']
    if thinking and settings['reasoning'] == 'nested':
        payload['reasoning'] = {'effort': settings['effort']}
    headers = {'Authorization': f"Bearer {settings['key']}", 'Accept': 'text/event-stream, application/json'}
    url = endpoint(settings['url'])
    for _ in range(2):
        async with client.post(url, json=payload, headers=headers, allow_redirects=False) as response:
            if payload['stream'] and response.status in (400, 422, 501):
                detail = await read_limited(response.content, 50_000)
                if response.status == 501 or re.search(rb'\bstream(?:ing)?\b', detail, re.I):
                    payload['stream'] = False
                    continue
            if not 200 <= response.status < 300:
                raise ProviderError(upstream_error(response.status, messages))
            streaming = 'text/event-stream' in response.headers.get('Content-Type', '').lower()
            yield {'type': 'start', 'streaming': streaming}
            answered = False
            async for packet in packets(response, streaming):
                text = answer_text(packet, streaming)
                if text:
                    answered = True
                    yield {'type': 'delta', 'text': text}
            if not answered:
                raise ProviderError('Модель вернула пустой ответ.')
            yield {'type': 'done'}
            return


def provider_client():
    resolver = PublicResolver()
    client = aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(resolver=resolver, family=socket.AF_INET, use_dns_cache=False, force_close=True),
        timeout=aiohttp.ClientTimeout(total=120, connect=16),
        cookie_jar=aiohttp.DummyCookieJar(),
    )
    return client, resolver

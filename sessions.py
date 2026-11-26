from contextlib import closing
from hashlib import sha256
import hmac
import os
import re
import secrets
import sqlite3
import time

TOKEN = re.compile(r'[0-9a-f]{64}')


class SessionLimitError(Exception):
    pass


class SessionStore:
    def __init__(self, path, credential_hashes):
        self.path = path
        self.credential_hashes = credential_hashes
        fd = os.open(path, os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        with closing(self._connect()) as db, db:
            db.execute('''CREATE TABLE IF NOT EXISTS sessions (
                token_hash BLOB PRIMARY KEY, role TEXT NOT NULL,
                binding BLOB NOT NULL, expires INTEGER NOT NULL
            )''')

    def _connect(self):
        return sqlite3.connect(self.path, timeout=2)

    def _binding(self, role, token):
        return hmac.digest(self.credential_hashes[role], token.encode('ascii'), 'sha256')

    @staticmethod
    def _token_hash(token):
        if isinstance(token, str) and TOKEN.fullmatch(token):
            return sha256(token.encode('ascii')).digest()
        return None

    def role(self, token):
        token_hash = self._token_hash(token)
        if token_hash is None:
            return None
        with closing(self._connect()) as db:
            row = db.execute('SELECT role, binding FROM sessions WHERE token_hash = ? AND expires > ?',
                             (token_hash, int(time.time()))).fetchone()
        if row and row[0] in self.credential_hashes and hmac.compare_digest(row[1], self._binding(row[0], token)):
            return row[0]
        return None

    def issue(self, role, previous_token, age):
        token = secrets.token_hex(32)
        now = int(time.time())
        with closing(self._connect()) as db, db:
            db.execute('DELETE FROM sessions WHERE expires <= ?', (now,))
            db.execute('DELETE FROM sessions WHERE token_hash = ?', (self._token_hash(previous_token),))
            if db.execute('SELECT count(*) FROM sessions').fetchone()[0] >= 5000:
                raise SessionLimitError
            db.execute('INSERT INTO sessions VALUES (?, ?, ?, ?)',
                       (self._token_hash(token), role, self._binding(role, token), now + age))
        return token

    def revoke(self, token):
        token_hash = self._token_hash(token)
        if token_hash is not None:
            with closing(self._connect()) as db, db:
                db.execute('DELETE FROM sessions WHERE token_hash = ?', (token_hash,))

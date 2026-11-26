import stat
import unittest
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory

from sessions import SessionStore


class SessionStoreTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'sessions.sqlite3'
        self.keys = {role: sha256(role.encode()).digest() for role in ('guest', 'admin')}
        self.store = SessionStore(self.path, self.keys)

    def test_existing_token_survives_reopening_without_storing_token(self):
        guest = self.store.issue('guest', None, 60)
        admin = self.store.issue('admin', None, 60)
        reopened = SessionStore(self.path, self.keys)
        self.assertEqual(reopened.role(guest), 'guest')
        self.assertEqual(reopened.role(admin), 'admin')
        self.assertNotIn(guest.encode(), self.path.read_bytes())
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_expired_or_malformed_token_is_not_accepted(self):
        expired = self.store.issue('guest', None, 0)
        for token in (expired, None, 'invalid', '0' * 64):
            self.assertIsNone(self.store.role(token))

    def test_signing_in_again_and_logging_out_revoke_tokens(self):
        before = self.store.issue('guest', None, 60)
        after = self.store.issue('admin', before, 60)
        self.assertIsNone(self.store.role(before))
        self.assertEqual(self.store.role(after), 'admin')
        self.store.revoke(after)
        self.assertIsNone(SessionStore(self.path, self.keys).role(after))

    def test_changing_a_password_invalidates_only_that_role(self):
        guest = self.store.issue('guest', None, 60)
        admin = self.store.issue('admin', None, 60)
        rotated = SessionStore(self.path, {**self.keys, 'guest': sha256(b'new password').digest()})
        self.assertIsNone(rotated.role(guest))
        self.assertEqual(rotated.role(admin), 'admin')

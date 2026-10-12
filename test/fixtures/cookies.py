# Cookie stores like the browsers' own, for the import tests. Each one carries a
# cookie for 127.0.0.1 that unlocks one test page.
import os
import shutil
import sqlite3
import sys

from cryptography.hazmat.primitives import hashes, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

out = sys.argv[1]
os.makedirs(f'{out}/firefox', exist_ok=True)
os.makedirs(f'{out}/chromium', exist_ok=True)
FAR = 4102444800  # 2100-01-01

# cookies.txt (Netscape format)
with open(f'{out}/cookies.txt', 'w') as f:
    f.write('# Netscape HTTP Cookie File\n')
    f.write(f'127.0.0.1\tFALSE\t/\tFALSE\t{FAR}\tfrom_txt\tyes\n')

# Firefox: the newest cookie is only in the write-ahead log, not yet in cookies.sqlite.
work = f'{out}/ff-work'
shutil.rmtree(work, ignore_errors=True)
os.makedirs(work)
con = sqlite3.connect(f'{work}/cookies.sqlite')
con.execute('PRAGMA journal_mode=WAL')
con.execute('PRAGMA wal_autocheckpoint=0')
con.execute('CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT "", name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER)')
con.execute("INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure) VALUES ('from_firefox', 'yes', '127.0.0.1', '/', ?, 0)", (FAR,))
con.commit()
con.execute('PRAGMA wal_checkpoint(TRUNCATE)')
con.execute("INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure) VALUES ('from_firefox_wal', 'yes', '127.0.0.1', '/', ?, 0)", (FAR,))
con.commit()
shutil.copy(f'{work}/cookies.sqlite', f'{out}/firefox/cookies.sqlite')
shutil.copy(f'{work}/cookies.sqlite-wal', f'{out}/firefox/cookies.sqlite-wal')
con.close()
shutil.rmtree(work)

# Chromium on Linux without a keyring: values are "v10" + AES-128-CBC with a key
# derived from "peanuts". One plain value too (older versions stored some that way).
key = PBKDF2HMAC(algorithm=hashes.SHA1(), length=16, salt=b'saltysalt', iterations=1).derive(b'peanuts')
padder = padding.PKCS7(128).padder()
data = padder.update(b'yes') + padder.finalize()
enc = Cipher(algorithms.AES(key), modes.CBC(b' ' * 16)).encryptor()
encrypted = b'v10' + enc.update(data) + enc.finalize()
path = f'{out}/chromium/Cookies'
if os.path.exists(path):
    os.remove(path)
con = sqlite3.connect(path)
con.execute('CREATE TABLE meta (key TEXT, value TEXT)')
con.execute("INSERT INTO meta VALUES ('version', '20')")
con.execute('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER)')
chrome_far = (FAR + 11644473600) * 1000000
con.execute("INSERT INTO cookies VALUES ('127.0.0.1', 'from_chromium', '', ?, '/', ?, 0)", (encrypted, chrome_far))
con.execute("INSERT INTO cookies VALUES ('127.0.0.1', 'from_chromium_plain', 'yes', X'', '/', ?, 0)", (chrome_far,))
con.commit()
con.close()

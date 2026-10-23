#!/bin/sh
# Direct button and knob input for the UI, installed as supervisord's `carthing-input`.
#
# Chromium gets keys from Weston over its Wayland connection, which it shares with the GPU driver
# (Chromium runs with --in-process-gpu). While the page is animating, the driver reads that
# connection to wait for frames, and key events read off it sit undelivered until something else
# wakes Chromium's input handling: presses during a screen switch's fade arrived up to 1.2s late,
# in bunches. Injected input skips Wayland and never did this, and nor did real presses with the
# animations turned off (284 presses, none over 66ms).
#
# So this reads the buttons and the knob straight from evdev — every open file description gets
# its own copy, so Weston and sleepd.sh still see them — and serves them to the page over a
# WebSocket on 127.0.0.1. core.js uses it while it's connected and ignores the same keys arriving
# the slow way; when it isn't, the keyboard path still works.
#
# Messages, one JSON object per WebSocket text frame:
#   {"k": "1", "v": 1}   a key: v is 1 down, 0 up, 2 auto-repeat. Keys are the names core.js
#                        uses: 1-4, Enter (knob press), Escape (back), m (settings).
#   {"w": 1}             the knob turned one click (REL_HWHEEL's own sign).
#
# The bridge keeps this script and input.conf up to date (bridge/device/deploy.js syncDaemon).

CONF=${INPUTD_CONF:-/var/lib/carthing/input.conf}
PORT=8765
[ -f "$CONF" ] && . "$CONF"
export INPUTD_PORT=${INPUTD_PORT:-$PORT}

exec python3 -u - <<'PY'
import base64, errno, hashlib, json, os, selectors, socket, struct, sys

PORT = int(os.environ['INPUTD_PORT'])
NAMES = ('gpio-keys', 'rotary@0')  # the buttons and the knob; not the touch panel or power key
KEYS = {1: 'Escape', 2: '1', 3: '2', 4: '3', 5: '4', 28: 'Enter', 50: 'm'}
EV_KEY, EV_REL, REL_HWHEEL = 1, 2, 6
# struct input_event on this 32-bit userland: two 32-bit timeval fields, type, code, value.
EVENT = struct.Struct('<IIHHi')
GUID = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

def say(*a):
    print('[inputd]', *a, flush=True)

def devices():
    # INPUTD_DEVICES (colon-separated paths) is for the tests; on the device, find them by name.
    if os.environ.get('INPUTD_DEVICES'):
        return os.environ['INPUTD_DEVICES'].split(':')
    found = []
    for ev in sorted(os.listdir('/sys/class/input')):
        if not ev.startswith('event'):
            continue
        try:
            with open('/sys/class/input/%s/device/name' % ev) as f:
                if f.read().strip() in NAMES:
                    found.append('/dev/input/' + ev)
        except OSError:
            pass
    return found

sel = selectors.DefaultSelector()
clients = {}  # socket -> {'buf': bytes, 'open': bool}

def frame(payload):
    data = payload.encode()
    n = len(data)
    head = bytes([0x81, n]) if n < 126 else bytes([0x81, 126]) + struct.pack('>H', n)
    return head + data

def broadcast(msg):
    data = frame(json.dumps(msg, separators=(',', ':')))
    for s, c in list(clients.items()):
        if c['open']:
            try:
                s.sendall(data)
            except OSError:
                drop(s)

def drop(s):
    clients.pop(s, None)
    try:
        sel.unregister(s)
    except Exception:
        pass
    s.close()

def on_client(s):
    c = clients[s]
    try:
        chunk = s.recv(4096)
    except OSError:
        return drop(s)
    if not chunk:
        return drop(s)
    c['buf'] += chunk
    if not c['open']:
        if b'\r\n\r\n' not in c['buf']:
            return
        head, c['buf'] = c['buf'].split(b'\r\n\r\n', 1)
        key = None
        for line in head.split(b'\r\n')[1:]:
            name, _, value = line.partition(b':')
            if name.strip().lower() == b'sec-websocket-key':
                key = value.strip()
        if not key:
            s.sendall(b'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
            return drop(s)
        accept = base64.b64encode(hashlib.sha1(key + GUID).digest())
        s.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                  b'Sec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
        c['open'] = True
    # The page sends nothing but control frames; answer pings, honour a close, skip the rest.
    buf = c['buf']
    while len(buf) >= 2:
        op, n = buf[0] & 0x0f, buf[1] & 0x7f
        at = 2
        if n == 126:
            if len(buf) < 4: break
            n, at = struct.unpack('>H', buf[2:4])[0], 4
        elif n == 127:
            if len(buf) < 10: break
            n, at = struct.unpack('>Q', buf[2:10])[0], 10
        mask = buf[at:at + 4] if buf[1] & 0x80 else b''
        at += len(mask)
        if len(buf) < at + n: break
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(buf[at:at + n])) if mask else buf[at:at + n]
        buf = buf[at + n:]
        if op == 8:
            c['buf'] = b''
            return drop(s)
        if op == 9:
            s.sendall(bytes([0x8a, len(body)]) + body)
    c['buf'] = buf

def on_device(fd, state):
    try:
        data = os.read(fd, EVENT.size * 64)
    except OSError as e:
        if e.errno in (errno.EAGAIN, errno.EINTR):
            return
        say('input device gone:', e)
        sys.exit(1)  # supervisord restarts us, and the devices are looked up again
    if not data:
        say('input device closed')
        sys.exit(1)
    state['buf'] += data
    buf = state['buf']
    usable = len(buf) - len(buf) % EVENT.size
    for off in range(0, usable, EVENT.size):
        _, _, typ, code, value = EVENT.unpack_from(buf, off)
        if typ == EV_KEY and code in KEYS:
            broadcast({'k': KEYS[code], 'v': value})
        elif typ == EV_REL and code == REL_HWHEEL and value:
            broadcast({'w': value})
    state['buf'] = buf[usable:]

paths = devices()
if not paths:
    say('no button or knob devices found')
    sys.exit(1)
for p in paths:
    fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK)
    sel.register(fd, selectors.EVENT_READ, ('dev', {'buf': b''}))

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(('127.0.0.1', PORT))
server.listen(4)
server.setblocking(False)
sel.register(server, selectors.EVENT_READ, ('server', None))
say('serving', ', '.join(paths), 'on 127.0.0.1:%d' % PORT)

while True:
    for key, _ in sel.select():
        kind, state = key.data
        if kind == 'server':
            try:
                s, _ = server.accept()
            except OSError:
                continue
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            clients[s] = {'buf': b'', 'open': False}
            sel.register(s, selectors.EVENT_READ, ('client', None))
        elif kind == 'dev':
            on_device(key.fd, state)
        else:
            on_client(key.fileobj)
PY

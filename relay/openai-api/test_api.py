#!/usr/bin/env python3
import urllib.request, json, sys

API_KEY='***'
BASE='http://127.0.0.1:9000'

def fetch(path, payload=None, extra_headers=None):
    url = BASE + path
    data = json.dumps(payload).encode() if payload else None
    h = {'Authorization': f'Bearer {API_KEY}'}
    if extra_headers:
        h.update(extra_headers)
    req = urllib.request.Request(url, data=data, headers=h, method='POST' if payload else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

# Health (no auth needed)
req = urllib.request.Request(f'{BASE}/health')
try:
    with urllib.request.urlopen(req, timeout=5) as resp:
        print("Health:", resp.read().decode())
except Exception as e:
    print(f"Health failed: {e}")

# Models
print("\n=== /v1/models ===")
code, body = fetch('/v1/models')
print(f"HTTP {code}: {body}")

# Non-streaming chat
print("\n=== Non-streaming chat ===")
code, body = fetch('/v1/chat/completions', payload={
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello"}]
}, extra_headers={'Content-Type': 'application/json'})
if code == 200:
    data = json.loads(body)
    print(f"HTTP 200")
    print(f"  id: {data['id']}")
    print(f"  content: {data['choices'][0]['message']['content'][:200]}")
    print(f"  usage: {data['usage']}")
else:
    print(f"HTTP {code}: {body}")

# Streaming chat
print("\n=== Streaming chat ===")
payload = json.dumps({"model": "gpt-3.5-turbo", "messages": [{"role": "user", "content": "Hi"}], "stream": True}).encode()
req = urllib.request.Request(f'{BASE}/v1/chat/completions', data=payload, headers={'Authorization': f'Bearer {API_KEY}', 'Content-Type': 'application/json'}, method='POST')
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        chunks = resp.read().decode().strip().split('\n\n')
        print(f"Received {len(chunks)} SSE chunks:")
        for i, chunk in enumerate(chunks[:6]):
            if chunk.startswith('data: '):
                c = chunk[6:]
                if c == '[DONE]':
                    print(f"  [{i}] [DONE]")
                    continue
                try:
                    d = json.loads(c)
                    content = d.get('choices', [{}])[0].get('delta', {}).get('content', '')
                    finish = d.get('choices', [{}])[0].get('finish_reason')
                    print(f"  [{i}] content='{content}' finish={finish}")
                except json.JSONDecodeError:
                    print(f"  [{i}] raw: {c[:100]}")
except Exception as e:
    print(f"Streaming failed: {e}")

# Char limit test
print("\n=== Char limit (200 chars) ===")
code, body = fetch('/v1/chat/completions', payload={
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "A" * 200}]
}, extra_headers={'Content-Type': 'application/json'})
print(f"HTTP {code}: {body}")

# Bad auth
print("\n=== Bad auth ===")
url = f'{BASE}/v1/chat/completions'
data = json.dumps({"messages": [{"role": "user", "content": "test"}]}).encode()
req = urllib.request.Request(url, data=data, headers={'Authorization': 'Bearer bad-key', 'Content-Type': 'application/json'}, method='POST')
try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        print(f"Unexpected HTTP {resp.status}")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode()}")

print("\nDone.")

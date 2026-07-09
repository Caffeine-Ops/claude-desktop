"""Shared helpers for the Python port of the gpt-image-2 scripts.

This is the 1:1 Python equivalent of `shared.js`. It deliberately uses only the
standard library (urllib / json / base64) so the skill can run on the app's
bundled Python (PPT_MASTER_PYTHON_HOME) with NO extra `pip install` — the
ppt-master venv's requirements.txt is untouched.

Same contract as the JS version:
  - env precedence: process env wins, then cwd/.env, then ~/.gateway.env,
    then the skill-bundled .env (ENABLE_GARDEN_IMAGEGEN lives there).
  - default image dir `garden-gpt-image-2/image`, default model `gpt-image-2`.
  - response shape: data[0].b64_json (base64) or data[0].url (download).
"""

import base64
import json
import mimetypes
import os
import re
import time
import unicodedata
import urllib.request
import urllib.error
import uuid
from pathlib import Path

# Skill root (dir holding SKILL.md): scripts/ lives one level under it. Derived
# from this file's own location, independent of cwd — mirrors SKILL_ROOT in
# shared.js so the bundled .env is found no matter where the caller runs from.
SKILL_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_IMAGE_DIR = "garden-gpt-image-2/image"
DEFAULT_PROMPT_DIR = "garden-gpt-image-2/prompt"
DEFAULT_MODEL = "gpt-image-2"


def read_env_file(file_path):
    """Parse a dotenv-style file into a dict. Missing file → {}."""
    try:
        text = Path(file_path).read_text(encoding="utf-8")
    except OSError:
        return {}
    result = {}
    for line in text.split("\n"):
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        pivot = trimmed.find("=")
        if pivot == -1:
            continue
        key = trimmed[:pivot].strip()
        value = trimmed[pivot + 1:].strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        result[key] = value
    return result


def load_ambient_env():
    """Fill os.environ from .env files WITHOUT overriding existing keys.

    Same place order and precedence as shared.js loadAmbientEnv(): process env
    always wins, then files in this order (earlier file wins over later because
    we only fill keys not already present).
    """
    places = [
        Path.cwd() / ".env",
        Path.cwd() / ".gateway.env",
        Path.home() / ".gateway.env",
        # Skill-bundled defaults last — cwd/home files and real env still win.
        SKILL_ROOT / ".env",
    ]
    for file_path in places:
        for key, value in read_env_file(file_path).items():
            if not os.environ.get(key):
                os.environ[key] = value


def read_prompt_input(prompt, prompt_file):
    if prompt:
        return prompt.strip()
    if prompt_file:
        return Path(prompt_file).resolve().read_text(encoding="utf-8").strip()
    raise ValueError("Prompt is required. Use --prompt or --promptfile.")


def slugify(value, fallback="image-task"):
    base = str(value or "").strip().lower()
    # NFKD + strip combining marks → drop accents, like the JS normalize("NFKD").
    decomposed = unicodedata.normalize("NFKD", base)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    ascii_only = re.sub(r"[^a-z0-9]+", "-", ascii_only)
    ascii_only = re.sub(r"^-+|-+$", "", ascii_only)[:48]
    return ascii_only or fallback


def make_timestamp():
    return time.strftime("%Y%m%d-%H%M%S", time.localtime())


def build_default_image_path(kind, hint, ext=".png"):
    stamp = make_timestamp()
    slug = slugify(hint, "edited-image" if kind == "edit" else "generated-image")
    return os.path.join(DEFAULT_IMAGE_DIR, f"{slug}-{stamp}{ext}")


def build_default_prompt_path(hint):
    stamp = make_timestamp()
    slug = slugify(hint, "prompt")
    return os.path.join(DEFAULT_PROMPT_DIR, f"{slug}-{stamp}.md")


def resolve_output(raw, fallback_path):
    target = raw or fallback_path
    full = Path(target).resolve()
    return str(full) if full.suffix else f"{full}.png"


def save_prompt(prompt_text, raw_path, hint):
    final_path = Path(raw_path or build_default_prompt_path(hint)).resolve()
    final_path.parent.mkdir(parents=True, exist_ok=True)
    final_path.write_text(f"{prompt_text.strip()}\n", encoding="utf-8")
    return str(final_path)


def mime_for(file_path):
    ext = Path(file_path).suffix.lower()
    if ext in (".jpg", ".jpeg"):
        return "image/jpeg"
    if ext == ".webp":
        return "image/webp"
    if ext == ".gif":
        return "image/gif"
    return "image/png"


def ensure_files_exist(files, label):
    for item in files:
        absolute = Path(item).resolve()
        if not absolute.is_file():
            raise FileNotFoundError(f"{label} not found: {absolute}")


def build_base_url():
    return (os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")


def require_api_key():
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required.")
    return api_key


# Proxy behavior note (JS→Python port): Node's `fetch` (used by the .js
# scripts) does NOT honor *_proxy env vars by default, but Python's urllib
# DOES. On a machine with HTTP_PROXY/HTTPS_PROXY set (common for users behind a
# corporate/region proxy to reach OpenAI), urllib would route the image API
# call through that proxy where fetch would have gone direct — a silent
# behavior change. We make it explicit and overridable:
#   - default: honor the environment proxies (urllib's normal behavior; this is
#     usually what a proxied user wants for reaching api.openai.com).
#   - GPT_IMAGE_2_NO_PROXY truthy (or the --no-proxy CLI flag, which sets it):
#     build an opener with NO proxy, matching the old fetch behavior.
_TRUTHY = {"1", "true", "yes", "on", "y"}


def _build_opener():
    if str(os.environ.get("GPT_IMAGE_2_NO_PROXY") or "").strip().lower() in _TRUTHY:
        # Empty ProxyHandler disables all proxying for this opener.
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()


def _request(req):
    opener = _build_opener()
    try:
        with opener.open(req) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        raise RuntimeError(f"Image API error ({err.code}): {body}") from None


def post_json(url, payload):
    api_key = require_api_key()
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": "application/json",
        },
    )
    return _request(req)


def _encode_multipart(fields, files):
    """Build a multipart/form-data body with the stdlib only.

    `fields`: list of (name, value) string pairs.
    `files`:  list of (name, filename, mime, bytes) tuples.
    Returns (content_type, body_bytes).
    """
    boundary = f"----gptimage2{uuid.uuid4().hex}"
    crlf = b"\r\n"
    out = []
    for name, value in fields:
        out.append(b"--" + boundary.encode())
        out.append(f'Content-Disposition: form-data; name="{name}"'.encode())
        out.append(b"")
        out.append(str(value).encode("utf-8"))
    for name, filename, mime, content in files:
        out.append(b"--" + boundary.encode())
        out.append(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"'.encode("utf-8")
        )
        out.append(f"Content-Type: {mime}".encode())
        out.append(b"")
        out.append(content)
    out.append(b"--" + boundary.encode() + b"--")
    out.append(b"")
    body = crlf.join(out)
    return f"multipart/form-data; boundary={boundary}", body


def post_multipart(url, fields, files):
    api_key = require_api_key()
    content_type, body = _encode_multipart(fields, files)
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": content_type,
        },
    )
    return _request(req)


def fetch_bytes_from_url(url):
    opener = _build_opener()
    try:
        with opener.open(url) as res:
            return res.read()
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        raise RuntimeError(
            f"Failed to download generated image ({err.code}): {body}"
        ) from None


def extract_generated_bytes(payload):
    data = payload.get("data") if isinstance(payload, dict) else None
    first = data[0] if data else None
    if not first:
        raise RuntimeError("API response did not include data[0].")
    if first.get("b64_json"):
        return base64.b64decode(first["b64_json"])
    if first.get("url"):
        return fetch_bytes_from_url(first["url"])
    raise RuntimeError("API response did not include b64_json or url.")


def save_image(output_path, content):
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(content)


def print_json(data):
    print(json.dumps(data, indent=2, ensure_ascii=False))

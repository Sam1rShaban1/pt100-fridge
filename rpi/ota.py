"""OTA logic for the Pi firmware.

Mirrors firmware/src/ota.cpp: download the artifact over HTTPS, verify its
SHA-256 against the server-provided digest, report state transitions to
ota/<device>/status, and (for a Python artifact) perform a genuine self-update
by writing the new file and exec'ing into it, persisting the new version to
version.txt so subsequent manifest polls stop re-offering.

For a non-Python artifact (e.g. an ESP32 .bin used only to test the server) it
verifies and ACKs success without applying.
"""

import hashlib
import os
import ssl
import sys
import urllib.request

import config


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _download(url: str) -> bytes:
    ctx = ssl.create_default_context()
    if config.MQTT_TLS_CA:  # reuse project CA if provided
        ctx.load_verify_locations(config.MQTT_TLS_CA)
    with urllib.request.urlopen(url, timeout=60, context=ctx) as r:
        return r.read()


def publish_status(publish, state, version, sha256=None, error=None):
    payload = {"state": state, "version": version}
    if sha256:
        payload["sha256"] = sha256
    if error:
        payload["error"] = error
    publish(f"ota/{config.DEVICE_ID}/status", __import__("json").dumps(payload))


def do_update(cmd, publish):
    """cmd: {"version","url","sha256"} (sha256 optional)."""
    version = cmd.get("version")
    url = cmd.get("url")
    expected = (cmd.get("sha256") or "").lower()
    if not url or not version:
        return False
    publish_status(publish, "downloading", version)
    try:
        data = _download(url)
    except Exception as e:
        publish_status(publish, "error", version, error=f"download: {e}")
        return False

    actual = _sha256(data)
    if expected and actual != expected:
        publish_status(publish, "error", version, sha256=actual,
                       error="sha256 mismatch")
        return False

    publish_status(publish, "verified", version, sha256=actual)

    # Genuine self-update for a Python artifact.
    if url.endswith(".py"):
        here = os.path.abspath(__file__)
        main_py = os.path.join(os.path.dirname(here), "main.py")
        backup = main_py + ".bak"
        if os.path.exists(main_py):
            os.replace(main_py, backup)
        with open(main_py, "wb") as f:
            f.write(data)
        # persist version so future polls don't re-offer
        with open(config.VER_FILE, "w") as f:
            f.write(version)
        publish_status(publish, "success", version, sha256=actual)
        # restart into the new version
        os.execv(sys.executable, [sys.executable, main_py] + sys.argv[1:])

    publish_status(publish, "success", version, sha256=actual)
    return True


def check_manifest(publish):
    """Poll the OTA server manifest; apply if a newer version is offered."""
    url = config.OTA_BASE_URL.rstrip("/") + "/api/firmware/manifest"
    url += f"?device_id={config.DEVICE_ID}&group={config.GROUP}"
    try:
        data = _download(url)
    except Exception:
        return
    try:
        manifest = __import__("json").loads(data)
    except Exception:
        return
    latest = manifest.get("version")
    if not latest or _semver_gt(latest, config.FW_VERSION()):
        do_update({
            "version": latest,
            "url": manifest.get("url"),
            "sha256": manifest.get("sha256"),
        }, publish)


def _semver_gt(a: str, b: str) -> bool:
    def split(v):
        return [int(x) for x in v.split(".") if x.isdigit()]
    pa, pb = split(a), split(b)
    return pa > pb

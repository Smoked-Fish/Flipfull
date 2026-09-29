import hashlib
import shutil
import urllib.request

from .errors import BuildError
from .paths import ROOT, USERINIT

MODELS_DIR = USERINIT / "services" / "stt" / "models"

# file name: (URL of the folder it's in, its sha256)
MODELS = {
    "parakeet-tdt_ctc-110m-Q4_K_M.gguf": (
        "https://huggingface.co/handy-computer/parakeet-tdt_ctc-110m-gguf/resolve/766f172fe70eb66785e3371664f53762e0fbafaa/",
        "486414fd90185a8c8a4ced7c123cfb133ff4f7958426c6b8bd9049946b56b448"),
    "ggml-base-q5_1.bin": (
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/",
        "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898"),
}


def fetch_models():
    """Downloads the models that are missing or don't match their sha256."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    for name, (base_url, sha) in MODELS.items():
        path = MODELS_DIR / name
        if path.is_file() and sha256_of(path) == sha:
            continue
        print(f"stt        downloading {name}")
        download(base_url + name, path, sha)
    print(f"stt        -> {MODELS_DIR.relative_to(ROOT)} ({len(MODELS)} models)")


def download(url, path, sha):
    part = path.with_name(path.name + ".part")
    try:
        with urllib.request.urlopen(url, timeout=60) as r, open(part, "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
        if sha256_of(part) != sha:
            raise BuildError(f"{path.name}: the download doesn't match its sha256")
        part.replace(path)
    except OSError as e:
        raise BuildError(f"couldn't download {path.name}: {e}")
    finally:
        part.unlink(missing_ok=True)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()

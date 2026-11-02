"""Download immutable public inputs. No model requests or changes to user data."""
import concurrent.futures
import hashlib
import io
import json
import pathlib
import tarfile
import subprocess
import sys

BASE = pathlib.Path(sys.argv[1]).resolve()
SOURCES = BASE / "sources"
SOURCES.mkdir(parents=True, exist_ok=True)


def get(url):
    # The system Python's bundled TLS is older than some primary data endpoints.
    result = subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--max-time", "90", url], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(url + ": " + result.stderr.decode(errors="replace"))
    return result.stdout


def download(item):
    name, url = item
    path = SOURCES / name
    if not path.exists():
        data = get(url)
        path.write_bytes(data)
    data = path.read_bytes()
    return {"file": name, "url": url, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


items = [
    ("nasa-global.csv", "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv"),
    ("nasa-faq.html", "https://data.giss.nasa.gov/gistemp/faq/"),
    ("noaa-co2-annual.txt", "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_mlo.txt"),
    ("noaa-co2-growth.txt", "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_gr_mlo.txt"),
    ("noaa-notes.html", "https://gml.noaa.gov/ccgg/trends/"),
]
for slug in ["electricity-generation", "carbon-intensity-electricity", "share-electricity-renewables", "share-electricity-fossil-fuels"]:
    for extension in ["csv", "metadata.json"]:
        items.append((slug + "." + extension, "https://ourworldindata.org/grapher/" + slug + "." + extension))
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    records = list(pool.map(download, items))

repos = {}
for repo in ["sindresorhus/quick-lru", "lukeed/mri", "rust-lang/book"]:
    name = repo.split("/")[1]
    lock = SOURCES / (name + "-ref.json")
    if lock.exists():
        pin = json.loads(lock.read_text())
    else:
        commit = json.loads(get("https://api.github.com/repos/" + repo + "/commits?per_page=1"))[0]
        pin = {"repository": repo, "commit": commit["sha"], "commitDate": commit["commit"]["committer"]["date"]}
        lock.write_text(json.dumps(pin, indent=2))
    archive = SOURCES / (name + ".tar.gz")
    url = "https://codeload.github.com/" + repo + "/tar.gz/" + pin["commit"]
    if not archive.exists():
        archive.write_bytes(get(url))
    target = SOURCES / name
    target.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive.read_bytes()), mode="r:gz") as tar:
        for member in tar.getmembers():
            parts = pathlib.PurePosixPath(member.name).parts[1:]
            if not parts or not member.isfile():
                continue
            path = target.joinpath(*parts).resolve()
            if target not in path.parents:
                raise ValueError("Unsafe archive entry")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(tar.extractfile(member).read())
    repos[name] = pin
    records.append({"file": archive.name, "url": url, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "bytes": archive.stat().st_size})

manifest = {"downloadedAt": "2026-10-31", "sources": records, "repositories": repos}
(BASE / "source-manifest.json").write_text(json.dumps(manifest, indent=2))
print(json.dumps({"sources": len(records), "bytes": sum(r["bytes"] for r in records), "repositories": repos}))

"""
Package the generated store for sharing.

    python tools/package_store.py demo                 # refresh ./demo/store (small sample committed to git)
    python tools/package_store.py release --out DIR    # build the GitHub-release zips in DIR

Release zips hold paths like  store/<well>/<wellbore>/...  plus store/catalog.json, so any subset can be
unzipped into the repository root; the server hides wells whose folders are missing.
"""
import argparse, hashlib, json, os, shutil, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STORE = os.path.join(ROOT, "store")

# demo: one SLB/Geoservices wellbore and one Baker Hughes wellbore (rig code, remarks, mud log, BHA)
DEMO = [("NA-NA-15-9-F-5", "1"), ("Norway-Statoil-NO-15-9-F-1-C", "3")]
DEMO_SKIP_LOGS = {"t_GenTime", "t_Memory-Time-FE", "t_CementData"}  # bulky; key channels are in drilling.parquet

# release: split by vendor / era, each zip well under GitHub's 2 GiB asset limit
GROUPS = [
    ("store-bakerhughes-1", "Baker Hughes / Statoil 2013-2016: F-1 C, F-11",
     lambda w: w in ("Norway-Statoil-NO-15-9-F-1-C", "Norway-Statoil-NO-15-9-F-11")),
    ("store-bakerhughes-2", "Baker Hughes / Statoil 2013-2016: F-15 and the other NO wells",
     lambda w: w.startswith("Norway-Statoil-NO-") and w not in ("Norway-Statoil-NO-15-9-F-1-C", "Norway-Statoil-NO-15-9-F-11")),
    ("store-slb-geoservices", "SLB / Geoservices / StatoilHydro 2007-2009 wells",
     lambda w: not w.startswith("Norway-Statoil-NO-")),
]

DATA_LICENSE = """Volve data - licence and attribution
====================================

This folder contains data derived from the Equinor Volve dataset (WITSML real-time drilling data),
converted by DrillDash (unit conversion to SI, merged drilling channels, rig states, connection times).

Data publisher: Equinor ASA
Data owners: Equinor (operator), ExxonMobil (partner), Bayerngas (partner) and the Norwegian Petroleum Directorate
Source: https://www.equinor.com/energy/volve-data-sharing

Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)
https://creativecommons.org/licenses/by-nc-sa/4.0/
The data shall not be resold. If shared, the data owners shall be attributed. Adaptations must be shared
under the same licence.

The data is provided "as is" and may contain errors and omissions; Equinor and the former Volve licence
partners give no warranties and accept no liability for its use (see Equinor's licence for the full text).

Note: the DrillDash source code is MIT-licensed; this licence applies to the data only.
"""


def load_catalog():
    p = os.path.join(STORE, "catalog.json")
    if not os.path.exists(p):
        sys.exit("No store/catalog.json - run ingest.py first.")
    return json.load(open(p, encoding="utf-8"))


def make_demo():
    cat = load_catalog()
    out = os.path.join(ROOT, "demo", "store")
    # refresh in place (deleting whole folders fails while OneDrive / Explorer hold them open)
    if os.path.isdir(out):
        for dp, _, fs in os.walk(out):
            for f in fs:
                os.remove(os.path.join(dp, f))
    wells = []
    for wid, wb in DEMO:
        w = next(x for x in cat["wells"] if x["id"] == wid)
        b = next(x for x in w["wellbores"] if x["wb"] == wb)
        src, dst = os.path.join(STORE, wid, wb), os.path.join(out, wid, wb)
        # skip the bulky logs and ingest's bookkeeping files (*.parquet.json), which the server never reads
        shutil.copytree(src, dst, dirs_exist_ok=True, ignore=lambda d, names: [n for n in names
                                                           if os.path.splitext(n)[0] in DEMO_SKIP_LOGS or n.endswith(".parquet.json")])
        b = dict(b, logs=[l for l in b["logs"] if l["gid"] not in DEMO_SKIP_LOGS])
        wells.append(dict(w, wellbores=[b]))
    demo_cat = dict(cat, wells=wells, demo=True)
    with open(os.path.join(out, "catalog.json"), "w", encoding="utf-8") as fh:
        json.dump(demo_cat, fh, separators=(",", ":"))
    with open(os.path.join(ROOT, "demo", "DATA-LICENSE.txt"), "w", encoding="utf-8") as fh:
        fh.write(DATA_LICENSE)
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(out) for f in fs)
    print(f"demo/store: {len(wells)} wellbores, {size / 1e6:.1f} MB")


def make_release(out):
    cat = load_catalog()
    os.makedirs(out, exist_ok=True)
    wells = [w["id"] for w in cat["wells"] if os.path.isdir(os.path.join(STORE, w["id"]))]
    sums = []
    for name, desc, pick in GROUPS:
        chosen = [w for w in wells if pick(w)]
        path = os.path.join(out, name + ".zip")
        with zipfile.ZipFile(path, "w", allowZip64=True) as z:
            z.writestr("store/DATA-LICENSE.txt", DATA_LICENSE)
            z.write(os.path.join(STORE, "catalog.json"), "store/catalog.json", zipfile.ZIP_DEFLATED)
            for wid in chosen:
                for dp, _, fs in os.walk(os.path.join(STORE, wid)):
                    for f in sorted(fs):
                        full = os.path.join(dp, f)
                        arc = os.path.relpath(full, ROOT).replace(os.sep, "/")
                        # parquet is already zstd-compressed: store it; compress the json
                        z.write(full, arc, zipfile.ZIP_STORED if f.endswith(".parquet") else zipfile.ZIP_DEFLATED)
        size = os.path.getsize(path)
        assert size < 2 * 1024 ** 3, f"{name}.zip is {size / 1e9:.2f} GB - over GitHub's 2 GiB asset limit"
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        sums.append(f"{h.hexdigest()}  {name}.zip")
        print(f"{name}.zip  {size / 1e6:8.0f} MB  {len(chosen):2d} wells  - {desc}")
    with open(os.path.join(out, "SHA256SUMS.txt"), "w") as fh:
        fh.write("\n".join(sums) + "\n")
    print(f"-> {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["demo", "release"])
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    a = ap.parse_args()
    make_demo() if a.what == "demo" else make_release(a.out)

"""
DrillDash server: serves the dashboard and windowed / binned data from the ingest store.

    python server.py [--store store] [--port 8050]
then open http://localhost:8050
"""
import argparse, io, json, math, os, threading, time, webbrowser
from collections import OrderedDict

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from flask import Flask, Response, abort, jsonify, request, send_from_directory

HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=None)
STORE = os.path.join(HERE, "store")
DEMO_STORE = os.path.join(HERE, "demo", "store")
CATALOG = {}
JSON_OBJECTS = {"daily", "trajectory", "messages", "bha", "geometry", "mudlog", "connections"}

# column cache (LRU by bytes)
class ColumnCache:
    def __init__(self, limit_bytes=3_000_000_000):
        self.limit, self.used, self.d, self.lock = limit_bytes, 0, OrderedDict(), threading.Lock()

    def get(self, path, col):
        key = (path, col)
        with self.lock:
            if key in self.d:
                self.d.move_to_end(key)
                return self.d[key]
        try:
            arr = pq.read_table(path, columns=[col]).column(0).to_numpy()
        except (KeyError, ValueError):
            return None
        with self.lock:
            self.d[key] = arr
            self.used += arr.nbytes
            while self.used > self.limit and len(self.d) > 1:
                _, old = self.d.popitem(last=False)
                self.used -= old.nbytes
        return arr


CACHE = ColumnCache()


def wb_dir(wid, wb):
    p = os.path.normpath(os.path.join(STORE, wid, wb))
    if not p.startswith(os.path.normpath(STORE)) or not os.path.isdir(p):
        abort(404)
    return p


def src_path(wid, wb, src):
    d = wb_dir(wid, wb)
    if src in ("drilling", "depth_drilling"):
        p = os.path.join(d, src + ".parquet")
    else:
        p = os.path.normpath(os.path.join(d, "logs", src + ".parquet"))
        if not p.startswith(d):
            abort(404)
    if not os.path.exists(p):
        abort(404)
    return p


def index_col(path):
    names = pq.read_schema(path).names
    return "t" if "t" in names else "md"


def sig(arr, digits=6):
    """float array -> JSON list with NaN->None and limited significant digits."""
    out = []
    for v in np.asarray(arr, dtype="float64"):
        out.append(None if not math.isfinite(v) else float(f"{v:.{digits}g}"))
    return out


# binning
def window(x, x0, x1):
    i0 = int(np.searchsorted(x, x0, "left"))
    i1 = int(np.searchsorted(x, x1, "right"))
    return i0, i1


def bin_series(x, cols, x0, x1, n):
    """Return (x_out, {name: {avg,min,max}} | {name: raw}, raw?)."""
    i0, i1 = window(x, x0, x1)
    xs = x[i0:i1]
    if len(xs) <= n * 2:
        return xs.astype("float64"), {k: {"avg": v[i0:i1]} for k, v in cols.items()}, True
    edges = np.linspace(x0, x1, n + 1)
    idx = np.searchsorted(xs, edges)
    starts, ends = idx[:-1], idx[1:]
    ne = starts < ends
    st = starts[ne]
    centers = (edges[:-1] + edges[1:]) / 2
    out = {}
    for k, v in cols.items():
        seg = v[i0:i1].astype("float64")
        fin = np.isfinite(seg)
        sums = np.add.reduceat(np.where(fin, seg, 0.0), st)
        cnt = np.add.reduceat(fin.astype(np.int32), st)
        avg = np.full(n, np.nan)
        mn = np.full(n, np.nan)
        mx = np.full(n, np.nan)
        with np.errstate(invalid="ignore", divide="ignore"):
            avg[ne] = sums / cnt
        mn[ne] = np.fmin.reduceat(seg, st)
        mx[ne] = np.fmax.reduceat(seg, st)
        out[k] = {"avg": avg, "min": mn, "max": mx}
    return centers, out, False


def bin_states(x, s, x0, x1, n):
    i0, i1 = window(x, x0, x1)
    xs, ss = x[i0:i1], s[i0:i1].astype(np.int64)
    if len(xs) == 0:
        return [], []
    if len(xs) <= n * 2:
        # run-length encode raw
        ch = np.r_[0, np.where(np.diff(ss) != 0)[0] + 1]
        return xs[ch].tolist(), ss[ch].tolist()
    edges = np.linspace(x0, x1, n + 1)
    idx = np.searchsorted(xs, edges)
    starts, ends = idx[:-1], idx[1:]
    ne = starts < ends
    oh = np.zeros((len(ss), 9), np.int32)
    oh[np.arange(len(ss)), np.clip(ss, 0, 8)] = 1
    counts = np.add.reduceat(oh, starts[ne], axis=0)
    dom = np.full(n, -1)
    dom[ne] = np.argmax(counts, axis=1)
    xe = edges[:-1]
    ch = np.r_[0, np.where(np.diff(dom) != 0)[0] + 1]
    return xe[ch].tolist(), dom[ch].tolist()


# routes
@app.route("/")
def index():
    return send_from_directory(os.path.join(HERE, "static"), "index.html")


@app.route("/favicon.ico")
def favicon():
    return ("", 204)  # the page ships an inline SVG icon


@app.route("/static/<path:p>")
def static_files(p):
    return send_from_directory(os.path.join(HERE, "static"), p)


@app.route("/api/catalog")
def api_catalog():
    wells = []
    for w in CATALOG["wells"]:
        wbs = []
        for b in w["wellbores"]:
            d = b.get("derived", {})
            wbs.append({"wb": b["wb"], "info": b["info"], "drilling": d.get("drilling"), "objects": d.get("objects"),
                        "rig": d.get("rig"), "trajectoryTD": d.get("trajectory_td"),
                        "nTimeLogs": sum(1 for l in b["logs"] if l["kind"] == "time"),
                        "nDepthLogs": sum(1 for l in b["logs"] if l["kind"] == "depth"),
                        "timeRange": [min([l["start"] for l in b["logs"] if l["kind"] == "time"] or [None], key=lambda v: v or 9e18),
                                      max([l["end"] for l in b["logs"] if l["kind"] == "time"] or [None], key=lambda v: v or 0)]})
        wells.append({"id": w["id"], "folder": w["folder"], "info": w["info"], "wellbores": wbs})
    return jsonify({"wells": wells, "rigStates": CATALOG["rigStates"], "canonical": CATALOG["canonical"],
                    "generated": CATALOG.get("generated"), "demo": bool(CATALOG.get("demo"))})


def find_wb(wid, wb):
    for w in CATALOG["wells"]:
        if w["id"] == wid:
            for b in w["wellbores"]:
                if b["wb"] == wb:
                    return w, b
    abort(404)


@app.route("/api/wb/<wid>/<wb>/logs")
def api_logs(wid, wb):
    _, b = find_wb(wid, wb)
    return jsonify(b["logs"])


@app.route("/api/wb/<wid>/<wb>/obj/<name>")
def api_obj(wid, wb, name):
    if name not in JSON_OBJECTS:
        abort(404)
    p = os.path.join(wb_dir(wid, wb), name + ".json")
    if not os.path.exists(p):
        return jsonify(None)
    return send_from_directory(os.path.dirname(p), os.path.basename(p), mimetype="application/json")


@app.route("/api/wb/<wid>/<wb>/series")
def api_series(wid, wb):
    src = request.args.get("src", "drilling")
    try:
        path = src_path(wid, wb, src)
    except Exception:  # log not present in this wellbore (layouts are shared between wells)
        return jsonify({"x": [], "series": {}, "raw": True, "missing": True})
    xc = index_col(path)
    chs = [c for c in request.args.get("ch", "").split(",") if c]
    n = max(50, min(int(request.args.get("n", 1000)), 6000))
    x = CACHE.get(path, xc)
    if x is None or len(x) == 0:
        return jsonify({"x": [], "series": {}, "raw": True})
    x0 = float(request.args.get("x0", x[0]))
    x1 = float(request.args.get("x1", x[-1]))
    cols = {}
    for c in chs:
        v = CACHE.get(path, c)
        if v is not None:
            cols[c] = v
    xo, series, raw = bin_series(x, cols, x0, x1, n)
    res = {"x": sig(xo, 13), "raw": raw, "series": {k: {kk: sig(vv) for kk, vv in s.items()} for k, s in series.items()}}
    # states=calc -> DrillDash classifier, states=rig -> rig-reported code (falls back to calc)
    st_req = request.args.get("states")
    names = pq.read_schema(path).names
    if st_req and "rig_state" in names:
        col = "rig_state_rig" if st_req == "rig" and "rig_state_rig" in names else "rig_state"
        sx, sv = bin_states(x, CACHE.get(path, col), x0, x1, n)
        res["states"] = {"x": sx, "s": sv}
    return jsonify(res)


@app.route("/api/wb/<wid>/<wb>/snapshot")
def api_snapshot(wid, wb):
    path = src_path(wid, wb, "drilling")
    t = CACHE.get(path, "t")
    tq = float(request.args.get("t", t[-1]))
    i = int(np.searchsorted(t, tq, "right")) - 1
    if i < 0:
        return jsonify(None)
    names = [c for c in pq.read_schema(path).names if c not in ("t", "src")]
    lo = max(0, i - 20)
    out = {"t": int(t[i]), "values": {}, "trend": {}}
    for c in names:
        v = CACHE.get(path, c)
        val = v[i]
        if c == "rig_state":
            out["state"] = int(val)
            continue
        if c == "rig_state_rig":
            out["stateRig"] = int(val)
            continue
        if not np.isfinite(val):  # last finite value within the past 20 rows
            seg = v[lo:i + 1]
            f = np.where(np.isfinite(seg))[0]
            val = seg[f[-1]] if len(f) else np.nan
        out["values"][c] = None if not np.isfinite(val) else float(f"{float(val):.6g}")
    # last 60 minutes of hole depth -> ROP-like progress
    j = int(np.searchsorted(t, t[i] - 3_600_000, "left"))
    hd = CACHE.get(path, "hole_depth")
    a, b = hd[j:i + 1], None
    fa = a[np.isfinite(a)]
    out["progress1h"] = float(fa[-1] - fa[0]) if len(fa) > 1 else None
    return jsonify(out)


@app.route("/api/wb/<wid>/<wb>/messages")
def api_messages(wid, wb):
    p = os.path.join(wb_dir(wid, wb), "messages.json")
    if not os.path.exists(p):
        return jsonify([])
    msgs = json.load(open(p, encoding="utf-8"))
    t0 = float(request.args.get("t0", -1e18))
    t1 = float(request.args.get("t1", 1e18))
    return jsonify([m for m in msgs if t0 <= m["t"] <= t1])


@app.route("/api/field")
def api_field():
    out = []
    for w in CATALOG["wells"]:
        for b in w["wellbores"]:
            p = os.path.join(STORE, w["id"], b["wb"], "trajectory.json")
            if not os.path.exists(p):
                continue
            trajs = json.load(open(p, encoding="utf-8"))
            best = max(trajs, key=lambda tr: (tr["stations"][-1]["md"], len(tr["stations"])))
            st = [s for s in best["stations"] if s["ns"] is not None and s["tvd"] is not None]
            if len(st) < 2:
                continue
            step = max(1, len(st) // 150)
            st = st[::step] + ([st[-1]] if (len(st) - 1) % step else [])
            out.append({"id": w["id"], "wb": b["wb"], "name": b["info"].get("name") or w["info"].get("name"),
                        "well": w["info"].get("name"), "ns": [s["ns"] for s in st], "ew": [s["ew"] for s in st],
                        "tvd": [s["tvd"] for s in st], "md": [s["md"] for s in st],
                        "hasDrilling": bool(b.get("derived", {}).get("drilling"))})
    return jsonify(out)


# CSV export (display units, mirrors static/js/units.js)
R2D = 180 / math.pi
UNITS = {
    "N": {"metric": ("t", lambda v: v / 9806.65), "imperial": ("klbf", lambda v: v / 4448.2216)},
    "Pa": {"metric": ("bar", lambda v: v / 1e5), "imperial": ("psi", lambda v: v / 6894.757)},
    "Pa_mse": {"metric": ("MPa", lambda v: v / 1e6), "imperial": ("ksi", lambda v: v / 6894757)},
    "m3/s": {"metric": ("L/min", lambda v: v * 60000), "imperial": ("gpm", lambda v: v * 15850.32)},
    "c/s": {"metric": ("rpm", lambda v: v * 60), "imperial": ("rpm", lambda v: v * 60)},
    "N.m": {"metric": ("kN.m", lambda v: v / 1000), "imperial": ("kft.lbf", lambda v: v / 1355.818)},
    "m/s": {"metric": ("m/h", lambda v: v * 3600), "imperial": ("ft/h", lambda v: v * 11811.02)},
    "kg/m3": {"metric": ("sg", lambda v: v / 1000), "imperial": ("ppg", lambda v: v / 119.826)},
    "m": {"metric": ("m", lambda v: v), "imperial": ("ft", lambda v: v / 0.3048)},
    "m3": {"metric": ("m3", lambda v: v), "imperial": ("bbl", lambda v: v / 0.158987)},
    "K": {"metric": ("degC", lambda v: v - 273.15), "imperial": ("degF", lambda v: (v - 273.15) * 9 / 5 + 32)},
    "Hz": {"metric": ("spm", lambda v: v * 60), "imperial": ("spm", lambda v: v * 60)},
    "rad": {"metric": ("deg", lambda v: v * R2D), "imperial": ("deg", lambda v: v * R2D)},
    "frac": {"metric": ("%", lambda v: v * 100), "imperial": ("%", lambda v: v * 100)},
}
CANON_UNITS = {
    "hole_depth": "m", "bit_depth": "m", "block_pos": "m", "hookload": "N", "wob": "N", "rpm": "c/s", "torque": "N.m",
    "spp": "Pa", "flow_in": "m3/s", "flow_out": "m3/s", "flow_out_pct": "%", "rop": "m/s", "rop_calc": "m/s",
    "mw_in": "kg/m3", "mw_out": "kg/m3", "pit_vol": "m3", "gain_loss": "m3", "gas": "", "spm": "Hz", "choke_p": "Pa",
    "mse": "Pa_mse", "bit_rpm": "c/s", "temp_in": "K", "temp_out": "K", "ecd": "kg/m3", "slide_frac": "frac",
    "drill_secs": "s", "rig_code": "",
}


def unit_of(b, src, m):
    if src in ("drilling", "depth_drilling"):
        return CANON_UNITS.get(m, "")
    for l in b["logs"]:
        if l["gid"] == src:
            for c in l["channels"]:
                if c["mnem"] == m:
                    return "Pa_mse" if "MSE" in m and c["unit"] == "Pa" else c["unit"]
    return ""


@app.route("/api/wb/<wid>/<wb>/export")
def api_export(wid, wb):
    w, b = find_wb(wid, wb)
    system = "imperial" if request.args.get("units") == "imperial" else "metric"
    pairs = [p.split(":", 1) for p in request.args.get("pairs", "").split(",") if ":" in p]
    if not pairs:
        abort(400)
    x0 = float(request.args.get("x0", "-inf"))
    x1 = float(request.args.get("x1", "inf"))
    names = {l["gid"]: l["name"] for l in b["logs"]}
    names.update({"drilling": "Drilling", "depth_drilling": "Drilling by depth"})
    by_src = {}
    for src, m in pairs:
        by_src.setdefault(src, []).append(m)
    frames, idx_name = [], None
    multi = len(by_src) > 1
    for src, chans in by_src.items():
        path = src_path(wid, wb, src)
        xc = index_col(path)
        x = CACHE.get(path, xc)
        i0, i1 = window(x, x0, x1)
        i1 = min(i1, i0 + 3_000_000)
        df = pd.DataFrame({xc: x[i0:i1]})
        for m in chans:
            v = CACHE.get(path, m)
            if v is None:
                continue
            v = v[i0:i1].astype("float64")
            if m in ("rig_state", "rig_state_rig"):
                states = CATALOG["rigStates"]
                df[m] = [states[int(k)] if 0 <= k < len(states) else "" for k in v]
                continue
            u = unit_of(b, src, m)
            label, f = UNITS.get(u, {}).get(system, (u, lambda q: q))
            col = f"{m} [{label}]" + (f" ({names.get(src, src)})" if multi and src not in ("drilling", "depth_drilling") else "")
            df[col] = f(v)
        idx_name = xc
        frames.append(df)
    out = frames[0]
    for f2 in frames[1:]:
        out = out.merge(f2, on=idx_name, how="outer")
    out = out.sort_values(idx_name)
    if idx_name == "t":
        out.insert(0, "time_utc", pd.to_datetime(out["t"], unit="ms", utc=True).dt.strftime("%Y-%m-%d %H:%M:%S"))
        out = out.drop(columns=["t"])
    else:
        label, f = UNITS["m"][system]
        out[idx_name] = f(out[idx_name])
        out = out.rename(columns={idx_name: f"md [{label}]"})
    buf = io.StringIO()
    out.to_csv(buf, index=False, float_format="%.6g")
    name = f"{(b['info'].get('name') or wid).replace('/', '-').replace(' ', '_')}_{'time' if idx_name == 't' else 'depth'}.csv"
    return Response(buf.getvalue(), mimetype="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}"'})


def prune_catalog(cat, store):
    """Keep only wellbores whose folders exist, so any subset of the store (e.g. one release zip) works."""
    kept, dropped = [], 0
    for w in cat["wells"]:
        wbs = [b for b in w["wellbores"] if os.path.isdir(os.path.join(store, w["id"], b["wb"]))]
        dropped += len(w["wellbores"]) - len(wbs)
        if wbs:
            kept.append(dict(w, wellbores=wbs))
    if dropped:
        print(f"Note: {dropped} wellbores listed in catalog.json are not in {store} and are hidden.", flush=True)
    return dict(cat, wells=kept)


def main():
    global STORE, CATALOG
    ap = argparse.ArgumentParser()
    ap.add_argument("--store", default=None, help="store folder (default: ./store, else the bundled ./demo/store)")
    ap.add_argument("--port", type=int, default=8050)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    if a.store:
        STORE = os.path.abspath(a.store)
    elif not os.path.exists(os.path.join(STORE, "catalog.json")) and os.path.exists(os.path.join(DEMO_STORE, "catalog.json")):
        STORE = DEMO_STORE
        print("No ./store yet - showing the bundled demo wells. Run ingest.py on the Volve data, or download the"
              " prebuilt store from the GitHub release, to see all wells.", flush=True)
    cp = os.path.join(STORE, "catalog.json")
    if not os.path.exists(cp):
        raise SystemExit(f"No catalog at {cp}. Run ingest.py first (or download the prebuilt store).")
    CATALOG = prune_catalog(json.load(open(cp, encoding="utf-8")), STORE)
    url = f"http://localhost:{a.port}"
    print(f"DrillDash serving {STORE}\n  -> {url}  (Ctrl+C to stop)", flush=True)
    if not a.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=a.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()

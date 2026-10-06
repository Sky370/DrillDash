"""
DrillDash ingest: converts a WITSML 1.4.1 folder export (Volve-style layout) into a
compact columnar store the dashboard server reads.

    <ROOT>/<well folder>/_wellInfo/*.xml
    <ROOT>/<well folder>/<wellbore #>/_wellboreInfo/*.xml
    <ROOT>/<well folder>/<wellbore #>/log/<k>/<n>/<sub>/000NN.xml     (chunked log objects)
    <ROOT>/<well folder>/<wellbore #>/{trajectory,message,bhaRun,tubular,wbGeometry,mudLog,rig}/*.xml

Output (store/):
    catalog.json                                   all wells / wellbores / logs / channels
    <wid>/<wb>/logs/<gid>.parquet                  every log group, SI units, float32
    <wid>/<wb>/drilling.parquet                    canonical drilling channels + rig state
    <wid>/<wb>/depth_drilling.parquet              on-bottom drilling params binned by hole depth
    <wid>/<wb>/{daily,trajectory,messages,bha,geometry,mudlog,rig}.json

Usage:  python ingest.py [--src <WITSML folder>] [--out store] [--workers 8] [--force]
        (default --src: $DRILLDASH_SRC, ./data/WITSML Realtime drilling data, or ../WITSML Realtime drilling data)
"""
import argparse, glob, html, io, json, os, re, sys, time, traceback
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR_NAME = "WITSML Realtime drilling data"
# where to find the Volve WITSML export: $DRILLDASH_SRC, ./data/<export>, or the folder next to this project
DEFAULT_SRC = next((p for p in (os.environ.get("DRILLDASH_SRC"),
                                os.path.join(HERE, "data", DATA_DIR_NAME),
                                os.path.join(os.path.dirname(HERE), DATA_DIR_NAME)) if p and os.path.isdir(p)),
                   os.path.join(HERE, "data", DATA_DIR_NAME))

# ----------------------------------------------------------------------------------
# Units: every numeric channel is converted to an SI base so the UI can convert once.
# ----------------------------------------------------------------------------------
UNIT_SI = {
    # force
    "N": ("N", 1), "kN": ("N", 1e3), "kkgf": ("N", 9806.65), "kgf": ("N", 9.80665),
    "klbf": ("N", 4448.2216), "lbf": ("N", 4.4482216), "tonf": ("N", 9806.65), "t": ("N", 9806.65),
    # pressure
    "Pa": ("Pa", 1), "kPa": ("Pa", 1e3), "MPa": ("Pa", 1e6), "bar": ("Pa", 1e5), "psi": ("Pa", 6894.757),
    # flow
    "m3/s": ("m3/s", 1), "L/min": ("m3/s", 1 / 60000), "l/min": ("m3/s", 1 / 60000), "m3/min": ("m3/s", 1 / 60),
    "gal/min": ("m3/s", 6.30902e-5), "gpm": ("m3/s", 6.30902e-5), "m3/h": ("m3/s", 1 / 3600),
    # rotation
    "c/s": ("c/s", 1), "rpm": ("c/s", 1 / 60), "RPM": ("c/s", 1 / 60), "c/min": ("c/s", 1 / 60),
    # torque
    "N.m": ("N.m", 1), "kN.m": ("N.m", 1e3), "ft.lbf": ("N.m", 1.355818), "kft.lbf": ("N.m", 1355.818),
    # speed
    "m/s": ("m/s", 1), "m/h": ("m/s", 1 / 3600), "m/min": ("m/s", 1 / 60), "ft/h": ("m/s", 0.3048 / 3600),
    # density
    "kg/m3": ("kg/m3", 1), "g/cm3": ("kg/m3", 1000), "sg": ("kg/m3", 1000), "ppg": ("kg/m3", 119.826),
    "lbm/galUS": ("kg/m3", 119.826),
    # length
    "m": ("m", 1), "ft": ("m", 0.3048), "in": ("m", 0.0254), "mm": ("m", 1e-3), "cm": ("m", 1e-2),
    # volume
    "m3": ("m3", 1), "L": ("m3", 1e-3), "bbl": ("m3", 0.158987),
    # time
    "s": ("s", 1), "min": ("s", 60), "h": ("s", 3600),
    # angles
    "rad": ("rad", 1), "dega": ("rad", np.pi / 180), "deg": ("rad", np.pi / 180),
    "rad/m": ("rad/m", 1), "dega/30m": ("rad/m", np.pi / 180 / 30),
}
TEMP_OFFSET = {"degC": 273.15, "degF": None}  # degF handled explicitly


def to_si(values, unit):
    """Return (array, si_unit). Unknown units pass through untouched."""
    u = (unit or "").strip()
    if u in UNIT_SI:
        su, f = UNIT_SI[u]
        return (values * f if f != 1 else values), su
    if u == "degC":
        return values + 273.15, "K"
    if u == "degF":
        return (values - 32) * 5 / 9 + 273.15, "K"
    return values, u


# ----------------------------------------------------------------------------------
# Canonical drilling channels (first alias found in a log wins) - in SI units.
# ----------------------------------------------------------------------------------
CANON = {
    "hole_depth": ["Depth", "DMEA", "DEPT", "GS_DMEA"],
    "bit_depth": ["BITDEP", "DBTM", "GS_DBTM"],
    "block_pos": ["BLOCKCOMP", "BPOS", "GS_BPOS"],
    "hookload": ["HKLD_AVG", "HKLD", "GS_HKLD", "HKLA"],
    "wob": ["WOB_AVG", "SWOB", "GS_SWOB", "CWOB"],
    "rpm": ["SURF_RPM", "RPM", "GS_RPM"],
    "torque": ["TORQUE_AVG", "TQA", "GS_TQA"],
    "spp": ["PUMP", "SPPA", "GS_SPPA"],
    "flow_in": ["FLOWIN", "TFLO", "GS_TFLO"],
    "flow_out": ["FLOWOUT", "FLOWOUT_CORIOLIS"],
    "flow_out_pct": ["FLOWOUTPC", "MFOP"],
    "rop": ["ROP_AVG", "ROP", "GS_ROP"],
    "mw_in": ["MWIN", "MWTI", "GS_MWTI"],
    "mw_out": ["MWOUT", "MDOA", "GS_MDOA"],
    "pit_vol": ["PITTOT", "TVA", "GS_TVA"],
    "gain_loss": ["GAINLOSSTOT"],
    "gas": ["TOTGAS", "GASA", "GS_GASA"],
    "spm": ["STRATESUM", "TSPM"],
    "choke_p": ["CHOKE_PRESS", "CHKP", "GS_CHKP"],
    "mse": ["MSE"],
    "bit_rpm": ["BIT_RPM_AVG", "Bit_RPM"],
    "temp_in": ["MTIN", "MTIA"],
    "temp_out": ["MTOUT", "MTOA", "GS_MTOA"],
    "ecd": ["ECD_MW_IN"],
    "rig_code": ["RigActivityCode"],  # Baker Hughes rig activity code (rig-reported state)
}
DRIVER_CHANNELS = ["hole_depth", "bit_depth", "hookload", "wob", "rpm", "torque", "spp", "flow_in"]

RIG_STATES = ["No data", "Rotary Drilling", "Slide Drilling", "In Slips", "Run In Hole",
              "Pull Out of Hole", "Reaming", "Circulating", "Static"]

NULLS = {"-999.25", "-999.250", "-9999", "NaN", "nan", ""}


def slug(s):
    s = s.replace("_$47$_", "-")
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")


def tag(s, name):
    m = re.search(rf"<{name}(?:\s[^>]*)?>(.*?)</{name}>", s, re.S)
    return html.unescape(m.group(1).strip()) if m else None


def tagf(s, name):
    v = tag(s, name)
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


def tag_attr(s, name, attr="uom"):
    m = re.search(rf'<{name}\s[^>]*{attr}="([^"]*)"', s)
    return m.group(1) if m else None


def read(path, limit=None):
    with open(path, "rb") as fh:
        b = fh.read(limit) if limit else fh.read()
    return b.decode("utf-8", "ignore")


def iso_ms(s):
    if not s:
        return None
    try:
        ts = pd.Timestamp(s)
        ts = ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")
        return int(ts.value // 1_000_000)
    except Exception:
        return None


def clean(o):
    """JSON-safe: NaN -> None, numpy scalars -> python."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.integer):
        return int(o)
    return o


def dump(obj, path):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(clean(obj), fh, separators=(",", ":"))


# ----------------------------------------------------------------------------------
# Discovery
# ----------------------------------------------------------------------------------
def log_header(path):
    """Parse header of a log chunk file (everything before <logData>)."""
    s = read(path, 400_000)
    i = s.find("<logData>")
    h = s if i < 0 else s[:i]
    info = {
        "name": tag(h, "name"), "indexType": tag(h, "indexType"), "indexCurve": tag(h, "indexCurve"),
        "nameWellbore": tag(h, "nameWellbore"), "serviceCompany": tag(h, "serviceCompany"),
        "uid": (re.search(r'<log [^>]*\buid="([^"]*)"', h) or [None, None])[1],
        "curves": {},
    }
    for m in re.finditer(r"<logCurveInfo[^>]*>(.*?)</logCurveInfo>", h, re.S):
        c = m.group(1)
        mn = tag(c, "mnemonic")
        if mn:
            info["curves"][mn] = {"unit": tag(c, "unit"), "desc": tag(c, "curveDescription")}
    return info


def discover(src):
    """Walk the export; returns list of wellbore dicts with log groups."""
    wells = []
    for wf in sorted(os.listdir(src)):
        wp = os.path.join(src, wf)
        if not os.path.isdir(wp):
            continue
        wi = glob.glob(os.path.join(wp, "_wellInfo", "*.xml"))
        well = {"folder": wf, "id": slug(wf), "info": parse_well_info(read(wi[0])) if wi else {}, "wellbores": []}
        for wb in sorted(os.listdir(wp), key=lambda s: (len(s), s)):
            bp = os.path.join(wp, wb)
            if not os.path.isdir(bp) or wb.startswith("_"):
                continue
            bi = glob.glob(os.path.join(bp, "_wellboreInfo", "*.xml"))
            wbd = {"wb": wb, "path": bp, "info": parse_wellbore_info(read(bi[0])) if bi else {}, "groups": []}
            # log objects = leaf folders holding the chunk xml files
            objs = {}
            for dp, dn, fn in os.walk(os.path.join(bp, "log")):
                xs = sorted(f for f in fn if f.endswith(".xml"))
                if xs:
                    objs[dp] = [os.path.join(dp, f) for f in xs]
            groups = {}
            for dp, files in objs.items():
                h = log_header(files[0])
                kind = "time" if (h["indexType"] or "").startswith("date") else "depth"
                name = h["name"] or os.path.basename(dp)
                key = (kind, name)
                g = groups.setdefault(key, {"kind": kind, "name": name, "files": [], "bytes": 0,
                                            "serviceCompany": h["serviceCompany"], "curves": {}})
                g["files"] += files
                g["bytes"] += sum(os.path.getsize(f) for f in files)
                for k, v in h["curves"].items():
                    g["curves"].setdefault(k, v)
            for (kind, name), g in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1])):
                g["gid"] = f"{kind[0]}_{slug(name)[:80]}"
                wbd["groups"].append(g)
            # de-duplicate gids
            seen = {}
            for g in wbd["groups"]:
                if g["gid"] in seen:
                    seen[g["gid"]] += 1
                    g["gid"] += f"_{seen[g['gid']]}"
                else:
                    seen[g["gid"]] = 0
            well["wellbores"].append(wbd)
        wells.append(well)
    return wells


def parse_well_info(s):
    # several wellLocation entries exist (some in projected CRS) - keep the first plausible lat/lon pair
    lat = lon = None
    for m in re.finditer(r"<wellLocation[^>]*>(.*?)</wellLocation>", s, re.S):
        la = re.search(r"<latitude[^>]*>([-\d.]+)</latitude>", m.group(1))
        lo = re.search(r"<longitude[^>]*>([-\d.]+)</longitude>", m.group(1))
        if la and lo and 5 < abs(float(la.group(1))) <= 90:
            lat, lon = la, lo
            break
    rt = re.search(r'<wellDatum uid="(?:RT|KB)">.*?<elevation[^>]*>([-\d.]+)</elevation>', s, re.S)
    return {
        "name": tag(s, "name"), "field": tag(s, "field"), "country": tag(s, "country"),
        "operator": tag(s, "operator"), "block": tag(s, "block"), "timeZone": tag(s, "timeZone"),
        "purpose": tag(s, "purposeWell"), "spud": tag(s, "dTimSpud"),
        "waterDepth": tagf(s, "waterDepth"),
        "lat": float(lat.group(1)) if lat else None, "lon": float(lon.group(1)) if lon else None,
        "rtElevation": float(rt.group(1)) if rt else None,
    }


def parse_wellbore_info(s):
    return {
        "name": tag(s, "name"), "status": tag(s, "statusWellbore"), "purpose": tag(s, "purposeWellbore"),
        "type": tag(s, "typeWellbore"), "shape": tag(s, "shape"), "kickoff": tag(s, "dTimKickoff"),
        "parent": tag(s, "parentWellbore"), "mdCurrent": tagf(s, "mdCurrent"), "tvdCurrent": tagf(s, "tvdCurrent"),
    }


# ----------------------------------------------------------------------------------
# Log group -> parquet
# ----------------------------------------------------------------------------------
DATA_RE = re.compile(r"<data>(.*?)</data>", re.S)


def parse_chunk(path):
    s = read(path)
    mn = tag(s, "mnemonicList")
    if not mn:
        return None
    mnem = mn.split(",")
    units = (tag(s, "unitList") or "").split(",")
    units += [""] * (len(mnem) - len(units))
    rows = DATA_RE.findall(s)
    if not rows:
        return None
    # unique column names
    seen, cols = {}, []
    for m in mnem:
        if m in seen:
            seen[m] += 1
            cols.append(f"{m}_{seen[m]}")
        else:
            seen[m] = 0
            cols.append(m)
    idx_curve = tag(s, "indexCurve") or cols[0]
    if idx_curve not in cols:
        idx_curve = cols[0]
    kind = "time" if (tag(s, "indexType") or "").startswith("date") else "depth"
    df = pd.read_csv(io.StringIO("\n".join(rows)), header=None, names=cols, dtype=str,
                     keep_default_na=False, na_filter=False, engine="c")
    out = {}
    if kind == "time":
        t = pd.to_datetime(df[idx_curve], format="ISO8601", utc=True, errors="coerce")
        out["__idx"] = (t.astype("int64") // 1_000_000).where(t.notna(), np.nan).to_numpy(dtype="float64")
    else:
        md = pd.to_numeric(df[idx_curve], errors="coerce").to_numpy(dtype="float64")
        md, _ = to_si(md, units[cols.index(idx_curve)])
        out["__idx"] = md
    unit_map = {}
    for c, u in zip(cols, units):
        if c == idx_curve:
            continue
        v = pd.to_numeric(df[c], errors="coerce").to_numpy(dtype="float64")
        v[(v == -999.25) | (v == -9999)] = np.nan
        if np.isnan(v).all():
            continue
        v, su = to_si(v, u)
        out[c] = v.astype("float32")
        unit_map[c] = (u, su)
    frame = pd.DataFrame(out)
    frame = frame[np.isfinite(frame["__idx"])]
    return frame, unit_map


def ingest_group(task):
    gid, files, kind, out_path = task["gid"], task["files"], task["kind"], task["out"]
    t0 = time.time()
    frames, units = [], {}
    for f in files:
        try:
            r = parse_chunk(f)
        except Exception as e:  # keep going; record failure
            print(f"  ! parse failed {f}: {e}", flush=True)
            continue
        if r is None:
            continue
        fr, um = r
        if len(fr):
            frames.append(fr)
            units.update(um)
    if not frames:
        return {"gid": gid, "rows": 0, "channels": [], "secs": time.time() - t0}
    df = pd.concat(frames, ignore_index=True, copy=False)
    del frames
    df = df.sort_values("__idx", kind="stable").drop_duplicates("__idx", keep="last")
    df = df.dropna(axis=1, how="all")
    idx = "t" if kind == "time" else "md"
    if kind == "time":
        df["__idx"] = df["__idx"].astype("int64")
    df = df.rename(columns={"__idx": idx}).reset_index(drop=True)
    for c in df.columns:
        if c != idx and df[c].dtype != np.float32:
            df[c] = df[c].astype("float32")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    df.to_parquet(out_path, index=False, compression="zstd")
    chans = []
    for c in df.columns:
        if c == idx:
            continue
        v = df[c].to_numpy()
        fin = np.isfinite(v)
        chans.append({"mnem": c, "unit": units.get(c, ("", ""))[1], "srcUnit": units.get(c, ("", ""))[0],
                      "n": int(fin.sum()),
                      "min": float(np.nanmin(v)) if fin.any() else None,
                      "max": float(np.nanmax(v)) if fin.any() else None})
    return {"gid": gid, "rows": len(df), "start": float(df[idx].iloc[0]), "end": float(df[idx].iloc[-1]),
            "channels": chans, "secs": time.time() - t0}


# ----------------------------------------------------------------------------------
# Derived products per wellbore
# ----------------------------------------------------------------------------------
def segments(t, gap_ms=10 * 60_000):
    """Contiguous coverage intervals of a sorted time array."""
    if len(t) == 0:
        return []
    br = np.where(np.diff(t) > gap_ms)[0]
    starts = np.r_[t[0], t[br + 1]]
    ends = np.r_[t[br], t[-1]]
    return list(zip(starts, ends))


def build_drilling(wb_dir, groups_meta):
    """Merge canonical channels from the best time logs into one table + rig state."""
    cands = []
    for g in groups_meta:
        if g["kind"] != "time" or not g.get("rows"):
            continue
        cnt = {c["mnem"]: c["n"] for c in g["channels"]}
        # Combined SLB + Geoservices logs interleave two vendors' rows (DMEA... vs GS_DMEA...).
        # Use one consistent family per log: the one with more depth/hookload samples.
        fam_n = {"": 0, "GS_": 0}
        for canon in ("hole_depth", "bit_depth", "hookload"):
            for a in CANON[canon]:
                if a in cnt:
                    fam_n["GS_" if a.startswith("GS_") else ""] += cnt[a]
        fam = "GS_" if fam_n["GS_"] > fam_n[""] else ""
        mapping = {}
        for canon, aliases in CANON.items():
            pref = [a for a in aliases if a.startswith("GS_") == (fam == "GS_")] + \
                   [a for a in aliases if a.startswith("GS_") != (fam == "GS_")]
            for a in pref:
                if a in cnt:
                    mapping[canon] = a
                    break
        score = sum(1 for c in DRIVER_CHANNELS if c in mapping)
        if score >= 4 and "hole_depth" in mapping or score >= 5:
            cands.append((score, g["rows"], g, mapping))
    if not cands:
        return None
    cands.sort(key=lambda x: (-x[0], -x[1]))
    parts, covered = [], []
    for score, rows, g, mapping in cands:
        cols = ["t"] + sorted(set(mapping.values()))
        df = pd.read_parquet(os.path.join(wb_dir, "logs", g["gid"] + ".parquet"), columns=cols)
        t = df["t"].to_numpy()
        keep = np.ones(len(t), bool)
        for a, b in covered:  # only fill time not already covered by a better source
            keep &= ~((t >= a) & (t <= b))
        df = df[keep]
        if len(df) < 10:
            continue
        out = pd.DataFrame({"t": df["t"].to_numpy()})
        for canon, mn in mapping.items():
            out[canon] = df[mn].to_numpy(dtype="float32")
        # drop rows that belong to the other vendor family (all drivers empty)
        drv = [c for c in DRIVER_CHANNELS if c in out]
        out = out[out[drv].notna().any(axis=1)].reset_index(drop=True)
        if len(out) < 10:
            continue
        out["src"] = np.int16(len(parts))
        parts.append((g["gid"], out))
        covered += segments(out["t"].to_numpy())
    if not parts:
        return None
    d = pd.concat([p[1] for p in parts], ignore_index=True).sort_values("t", kind="stable")
    d = d.drop_duplicates("t").reset_index(drop=True)
    for c in CANON:
        if c not in d:
            d[c] = np.float32(np.nan)
    # depth spikes (e.g. 24 940 m in a 4 km well): drop values far beyond the 99.9th percentile
    for c in ("hole_depth", "bit_depth"):
        v = d[c].to_numpy()
        fin = v[np.isfinite(v)]
        if len(fin) > 100:
            hi = np.percentile(fin, 99.9) * 1.05 + 5
            d.loc[(d[c] > hi) | (d[c] < -50), c] = np.nan
    d["rig_state"], thresholds = classify(d)
    d["rig_state_rig"] = map_rig_code(d["rig_code"].to_numpy())
    return d, [p[0] for p in parts], thresholds


def map_rig_code(code):
    """Baker Hughes RigActivityCode -> DrillDash states. Code = 100*rotating + 10*circulating + activity, where
    activity: 0 NoMonitor, 1 Drilling, 2 Reaming, 3 OffBottom, 4 InSlips, 5 Connection, 6 TrippingIn,
    7 TrippingOut, 8 TripInSlips, 9 ShutIn. 0 in the result = no code."""
    c = np.where(np.isfinite(code), np.round(code), -1).astype(np.int64)
    valid = c >= 0
    u, circ, rot = c % 10, (c // 10) % 10 == 1, (c // 100) % 10 == 1
    s = np.zeros(len(c), np.int8)
    s[(u == 1) & rot] = 1
    s[(u == 1) & ~rot] = 2
    s[u == 2] = 6
    s[(u == 3) & circ] = 7
    s[(u == 3) & ~circ] = 8
    s[np.isin(u, [4, 5, 8])] = 3
    s[u == 6] = 4
    s[u == 7] = 5
    s[u == 9] = 8
    s[(u == 0) & circ] = 7
    s[(u == 0) & ~circ & rot] = 8
    s[~valid] = 0
    return s


def classify(d):
    """Rule-based rig state from surface channels (all SI)."""
    t = d["t"].to_numpy(dtype="float64") / 1000.0
    n = len(t)
    hd = d["hole_depth"].to_numpy(dtype="float64")
    bd = d["bit_depth"].to_numpy(dtype="float64")
    hl = d["hookload"].to_numpy(dtype="float64")
    rpm = d["rpm"].to_numpy(dtype="float64") * 60
    flow = d["flow_in"].to_numpy(dtype="float64") * 60000  # L/min
    spp = d["spp"].to_numpy(dtype="float64") / 1e5          # bar
    wob = d["wob"].to_numpy(dtype="float64") / 9806.65      # t

    # forward-fill short dropouts of depth channels
    hd = pd.Series(hd).replace(0, np.nan).ffill(limit=20).to_numpy()
    bd = pd.Series(bd).ffill(limit=20).to_numpy()

    # bit velocity over a +-15 s window
    ok = np.isfinite(bd)
    if ok.sum() > 2:
        bdi = np.interp(t, t[ok], bd[ok])
        v = (np.interp(t + 15, t, bdi) - np.interp(t - 15, t, bdi)) / 30.0
        v[~ok] = np.nan
    else:
        v = np.full(n, np.nan)

    # block weight (traveling block + top drive) per source log: hookload samples pile up there while in slips
    src = d["src"].to_numpy() if "src" in d else np.zeros(n, np.int16)
    glob_bw = block_weight(hl)
    bw = np.full(n, glob_bw)
    for sv in np.unique(src):
        m = src == sv
        b = block_weight(hl[m])
        bw[m] = b if np.isfinite(b) else glob_bw
    base = float(np.nanmedian(bw)) if np.isfinite(bw).any() else 0.0
    bw = np.where(np.isfinite(bw), bw, base)
    slips_thr = bw + 8 * 9806.65  # block weight + 8 t
    rot = np.nan_to_num(rpm) > 5
    pumping = (np.nan_to_num(flow) > 100) | ((~np.isfinite(flow)) & (np.nan_to_num(spp) > 10))
    off = hd - bd
    on_bottom = np.isfinite(off) & (off <= 0.6) & (bd > 0)
    in_slips = np.isfinite(hl) & (hl < slips_thr)  # array threshold (per source)
    vt = 0.03  # m/s (~108 m/h): faster than drilling, slower than tripping

    s = np.full(n, 8, np.int8)  # static
    vv = np.nan_to_num(v)
    s[pumping] = 7
    s[(vv > vt) & ~pumping] = 4
    s[(vv > vt) & pumping & ~rot] = 4          # washing in -> RIH family
    s[(vv < -vt) & ~(pumping & rot)] = 5       # POOH / pump out
    s[(np.abs(vv) > vt) & pumping & rot] = 6   # reaming / back-reaming
    # in slips wins over "on bottom": the rig keeps bit depth frozen near bottom during a connection
    # a moving bit cannot be in slips; with the string out of hole (bit < 5 m) a light hookload is just Static
    slips = in_slips & (np.abs(vv) <= vt) & (np.nan_to_num(bd, nan=1e9) > 5)
    # drilling needs evidence of making hole: weight on bit, or hole depth advancing over +-60 s
    okh = np.isfinite(hd)
    if okh.sum() > 2:
        hdi = np.interp(t, t[okh], hd[okh])
        adv = (np.interp(t + 60, t, hdi) - np.interp(t - 60, t, hdi)) > 0.05
    else:
        adv = np.zeros(n, bool)
    making_hole = (np.nan_to_num(wob) > 0.5) | adv
    drilling = on_bottom & ~slips & (pumping | rot) & making_hole
    s[drilling & rot] = 1
    s[drilling & ~rot] = 2
    s[slips] = 3
    s[~np.isfinite(hd) | ~np.isfinite(bd)] = 0
    # majority smoothing over 5 samples removes single-sample flicker
    if n > 5:
        oh = np.zeros((n, 9), np.int16)
        oh[np.arange(n), s] = 1
        cs = np.cumsum(np.vstack([np.zeros((1, 9), np.int16), oh]), axis=0)
        lo = np.clip(np.arange(n) - 2, 0, n)
        hi = np.clip(np.arange(n) + 3, 0, n)
        s = np.argmax(cs[hi] - cs[lo], axis=1).astype(np.int8)
    return s, {"hookload_base_N": base, "slips_threshold_N": base + 8 * 9806.65, "on_bottom_m": 0.6,
               "rpm_rot": 5, "flow_lpm": 100, "trip_speed_ms": vt}


def block_weight(hl):
    """Lowest significant hookload peak above 5 t, ignoring flat-lined (frozen sensor) samples. Returns N."""
    v = hl / 9806.65
    moving = np.r_[False, np.abs(np.diff(v)) > 1e-6]
    v = v[np.isfinite(v) & moving & (v > 5) & (v < 500)]
    if len(v) < 200:
        return np.nan
    hist, e = np.histogram(v, bins=np.arange(5, np.percentile(v, 95) + 2, 2))
    if len(hist) < 3:
        return np.nan
    sm = np.convolve(hist, [1, 2, 1], "same") / 4
    thr = 0.02 * len(v)
    for k in range(1, len(sm) - 1):
        if sm[k] >= thr and sm[k] >= sm[k - 1] and sm[k] >= sm[k + 1]:
            return (e[k] + e[k + 1]) / 2 * 9806.65
    k = int(np.argmax(sm))
    return (e[k] + e[k + 1]) / 2 * 9806.65


def daily_stats(d, tz_hours=0, with_rig=False):
    t = d["t"].to_numpy()
    dt = np.diff(t, append=t[-1]) / 1000.0
    dt = np.clip(dt, 0, 60)  # gaps > 1 min are not counted as activity time
    day = ((t + tz_hours * 3600_000) // 86_400_000).astype(np.int64)
    st = d["rig_state"].to_numpy()
    sr = d["rig_state_rig"].to_numpy() if with_rig else None
    hd = d["hole_depth"].to_numpy(dtype="float64")
    out = []
    prev_max = np.nan
    for dd in np.unique(day):
        m = day == dd
        hours = np.bincount(st[m], weights=dt[m], minlength=9) / 3600.0
        hmax = np.nanmax(hd[m]) if np.isfinite(hd[m]).any() else np.nan
        footage = max(0.0, hmax - prev_max) if np.isfinite(prev_max) and np.isfinite(hmax) else 0.0
        if np.isfinite(hmax):
            prev_max = hmax if not np.isfinite(prev_max) else max(prev_max, hmax)
        drill_h = hours[1] + hours[2]
        rec = {"day": int(dd) * 86_400_000, "hours": hours.round(3).tolist(), "maxDepth": hmax,
               "footage": footage, "rop": footage / drill_h if drill_h > 0.1 else None}
        if with_rig:
            hr = np.bincount(sr[m], weights=dt[m], minlength=9) / 3600.0
            rec["hoursRig"] = hr.round(3).tolist()
            dr = hr[1] + hr[2]
            rec["ropRig"] = footage / dr if dr > 0.1 else None
        out.append(rec)
    return out


def connections(d, max_gap_s=300):
    """Drilling connections: an in-slips period bracketed by on-bottom drilling.
    weight-to-weight = last drilling sample before -> first drilling sample after;
    split into pre-slips (pick up / back-ream), in-slips, and post-slips (run back to bottom)."""
    s = d["rig_state"].to_numpy()
    t = d["t"].to_numpy()
    hd = d["hole_depth"].to_numpy(dtype="float64")
    bd = d["bit_depth"].to_numpy(dtype="float64")
    if len(s) < 10:
        return []
    ch = np.r_[0, np.where(np.diff(s) != 0)[0] + 1]
    seg_s = s[ch]
    seg_a = t[ch]
    seg_b = np.r_[t[ch[1:]], t[-1]]
    drill = np.isin(seg_s, [1, 2])
    n, out = len(ch), []
    lim = 30 * 60_000
    for k in range(n):
        if seg_s[k] != 3:
            continue
        j = k - 1
        while j >= 0 and not drill[j] and seg_a[k] - seg_b[j] <= lim:
            j -= 1
        if j < 0 or not drill[j] or np.any(seg_s[j + 1:k] == 3):
            continue  # only the first slips period after drilling starts a connection
        q = k + 1
        while q < n and not drill[q] and seg_a[q] - seg_b[k] <= lim:
            q += 1
        if q >= n or not drill[q]:
            continue
        ia, ib = ch[j + 1], ch[q]
        if ib - ia < 2 or np.max(np.diff(t[ia:ib + 1])) / 1000 > max_gap_s:
            continue  # data gap inside the connection
        slips = [m for m in range(j + 1, q) if seg_s[m] == 3]
        s2s = sum(seg_b[m] - seg_a[m] for m in slips) / 1000
        if s2s < 20 or s2s > 45 * 60:
            continue
        md = hd[ch[k]]
        bmin = np.nanmin(bd[ia:ib]) if np.isfinite(bd[ia:ib]).any() else np.nan
        if not np.isfinite(md) or (np.isfinite(bmin) and md - bmin > 80):
            continue  # pulled far off bottom: a trip, not a connection
        w2w = (seg_a[q] - seg_b[j]) / 1000
        pre = (seg_a[slips[0]] - seg_b[j]) / 1000
        post = (seg_a[q] - seg_b[slips[-1]]) / 1000
        out.append({"t": int(seg_a[k]), "md": float(md), "s2s": round(float(s2s), 1), "w2w": round(float(w2w), 1),
                    "pre": round(float(pre), 1), "post": round(float(post), 1)})
    return out


def depth_drilling(d, bin_m=1.0):
    m = np.isin(d["rig_state"].to_numpy(), [1, 2]) & np.isfinite(d["hole_depth"].to_numpy())
    x = d[m]
    if len(x) < 50:
        return None
    b = (np.floor(x["hole_depth"].to_numpy() / bin_m) * bin_m).astype("float64")
    cols = ["rop", "wob", "rpm", "torque", "spp", "flow_in", "hookload", "mse", "bit_rpm", "mw_in", "gas"]
    g = x[cols].groupby(b).median()
    t = x["t"].to_numpy()
    dt = np.clip(np.diff(t, append=t[-1]) / 1000.0, 0, 60)
    slide = pd.Series((x["rig_state"].to_numpy() == 2) * dt).groupby(b).sum()
    tot = pd.Series(dt).groupby(b).sum()
    g["slide_frac"] = (slide / tot.replace(0, np.nan)).astype("float32")
    g["drill_secs"] = tot.astype("float32")
    g["t_first"] = pd.Series(t).groupby(b).min()
    # time-derived ROP when the channel is missing: bin size / time spent drilling it
    g["rop_calc"] = (bin_m / tot.replace(0, np.nan)).astype("float32")
    g.index.name = "md"
    return g.reset_index().astype({c: "float32" for c in cols})


# ---------------- non-log objects ----------------
def parse_trajectories(bp):
    out = []
    for f in sorted(glob.glob(os.path.join(bp, "trajectory", "*.xml"))):
        s = read(f)
        st = []
        for m in re.finditer(r"<trajectoryStation[^>]*>(.*?)</trajectoryStation>", s, re.S):
            c = m.group(1)
            md = tagf(c, "md")
            if md is None:
                continue
            rec = {"md": md, "tvd": tagf(c, "tvd"), "incl": tagf(c, "incl"), "azi": tagf(c, "azi"),
                   "ns": tagf(c, "dispNs"), "ew": tagf(c, "dispEw"), "vs": tagf(c, "vertSect"),
                   "dls": tagf(c, "dls"), "t": iso_ms(tag(c, "dTimStn")), "type": tag(c, "typeTrajStation")}
            for k, u in (("incl", "incl"), ("azi", "azi")):
                if rec[k] is not None and tag_attr(c, u) == "dega":
                    rec[k] = np.deg2rad(rec[k])
            if rec["dls"] is not None:
                rec["dls"], _ = to_si(rec["dls"], tag_attr(c, "dls"))
            for k in ("md", "tvd", "ns", "ew", "vs"):
                if rec[k] is not None:
                    rec[k], _ = to_si(rec[k], tag_attr(c, k if k in ("md", "tvd") else
                                                       {"ns": "dispNs", "ew": "dispEw", "vs": "vertSect"}[k]))
            st.append(rec)
        st.sort(key=lambda r: r["md"])
        # drop exact duplicate md
        ded = []
        for r in st:
            if ded and abs(ded[-1]["md"] - r["md"]) < 1e-6:
                ded[-1] = r
            else:
                ded.append(r)
        if ded:
            out.append({"name": tag(s, "name"), "service": tag(s, "serviceCompany"),
                        "start": tag(s, "dTimTrajStart"), "end": tag(s, "dTimTrajEnd"), "stations": ded})
    # mincurv fill for stations missing ns/ew/tvd
    for tr in out:
        fill_min_curv(tr["stations"])
    return out


def fill_min_curv(st):
    if not st or all(r["ns"] is not None and r["ew"] is not None and r["tvd"] is not None for r in st):
        return
    n = e = 0.0
    tv = st[0]["tvd"] or 0.0
    for i, r in enumerate(st):
        if i == 0:
            r["ns"] = r["ns"] if r["ns"] is not None else 0.0
            r["ew"] = r["ew"] if r["ew"] is not None else 0.0
            r["tvd"] = tv
            n, e = r["ns"], r["ew"]
            continue
        p = st[i - 1]
        i1, a1, i2, a2 = p["incl"] or 0, p["azi"] or 0, r["incl"] or 0, r["azi"] or 0
        dmd = r["md"] - p["md"]
        cosd = np.cos(i2 - i1) - np.sin(i1) * np.sin(i2) * (1 - np.cos(a2 - a1))
        dl = np.arccos(np.clip(cosd, -1, 1))
        rf = 1.0 if dl < 1e-9 else 2 / dl * np.tan(dl / 2)
        n += dmd / 2 * (np.sin(i1) * np.cos(a1) + np.sin(i2) * np.cos(a2)) * rf
        e += dmd / 2 * (np.sin(i1) * np.sin(a1) + np.sin(i2) * np.sin(a2)) * rf
        tv += dmd / 2 * (np.cos(i1) + np.cos(i2)) * rf
        r["ns"], r["ew"], r["tvd"] = n, e, tv


def parse_messages(bp):
    out = []
    for f in glob.glob(os.path.join(bp, "message", "*.xml")):
        s = read(f)
        for m in re.finditer(r"<message [^>]*>(.*?)</message>", s, re.S):
            c = m.group(1)
            t = iso_ms(tag(c, "dTim"))
            if t is None:
                continue
            md = tagf(c, "md")
            if md is not None:
                md, _ = to_si(md, tag_attr(c, "md"))
            out.append({"t": t, "md": md, "text": tag(c, "messageText") or tag(c, "name"),
                        "type": tag(c, "typeMessage"), "source": tag(c, "sourceName")})
    out.sort(key=lambda r: r["t"])
    return out


def parse_bha(bp):
    tubs = {}
    for f in glob.glob(os.path.join(bp, "tubular", "*.xml")):
        s = read(f)
        uid = (re.search(r'<tubular [^>]*\buid="([^"]*)"', s) or [None, None])[1]
        comps = []
        for m in re.finditer(r"<tubularComponent[^>]*>(.*?)</tubularComponent>", s, re.S):
            c = m.group(1)
            def L(name):
                v = tagf(c, name)
                return None if v is None else to_si(v, tag_attr(c, name))[0]
            comps.append({"type": tag(c, "typeTubularComp"), "seq": tagf(c, "sequence"),
                          "name": tag(c, "fullName") or tag(c, "description") or tag(c, "typeTubularComp"),
                          "od": L("od"), "id": L("id"), "len": L("len"), "vendor": tag(c, "vendor")})
        comps.sort(key=lambda r: r["seq"] or 0)
        tubs[uid] = {"name": tag(s, "name"), "type": tag(s, "typeTubularAssy"), "components": comps}
    runs = []
    for f in glob.glob(os.path.join(bp, "bhaRun", "*.xml")):
        s = read(f)
        ref = (re.search(r'<tubular uidRef="([^"]*)"', s) or [None, None])[1]
        runs.append({"name": tag(s, "name"), "start": iso_ms(tag(s, "dTimStart")), "stop": iso_ms(tag(s, "dTimStop")),
                     "run": tagf(s, "numStringRun"), "tubular": ref,
                     "tubularName": tubs.get(ref, {}).get("name")})
    runs.sort(key=lambda r: r["start"] or 0)
    return {"runs": runs, "tubulars": tubs}


def parse_geometry(bp):
    reps = []
    for f in glob.glob(os.path.join(bp, "wbGeometry", "*.xml")):
        s = read(f)
        secs = []
        for m in re.finditer(r"<wbGeometrySection[^>]*>(.*?)</wbGeometrySection>", s, re.S):
            c = m.group(1)
            def L(name):
                v = tagf(c, name)
                return None if v is None else to_si(v, tag_attr(c, name))[0]
            secs.append({"type": tag(c, "typeHoleCasing"), "mdTop": L("mdTop"), "mdBottom": L("mdBottom"),
                         "tvdTop": L("tvdTop"), "tvdBottom": L("tvdBottom"), "id": L("idSection"),
                         "od": L("odSection")})
        secs.sort(key=lambda r: (r["mdTop"] or 0))
        reps.append({"name": tag(s, "name"), "t": iso_ms(tag(s, "dTimReport")), "sections": secs})
    reps.sort(key=lambda r: r["t"] or 0)
    return reps


def parse_mudlog(bp):
    out = []
    for f in glob.glob(os.path.join(bp, "mudLog", "*.xml")):
        s = read(f)
        for m in re.finditer(r"<geologyInterval[^>]*>(.*?)</geologyInterval>", s, re.S):
            c = m.group(1)
            liths = []
            for lm in re.finditer(r"<lithology[^>]*>(.*?)</lithology>", c, re.S):
                lc = lm.group(1)
                liths.append({"type": tag(lc, "type"), "pc": tagf(lc, "lithPc")})
            top, bot = tagf(c, "mdTop"), tagf(c, "mdBottom")
            if top is None or bot is None:
                continue
            out.append({"kind": tag(c, "typeLithology"), "top": top, "bottom": bot, "lith": liths})
    kinds = {r["kind"] for r in out}
    pref = "interpreted" if "interpreted" in kinds else "cuttings"
    sel = [r for r in out if r["kind"] == pref] or out
    sel.sort(key=lambda r: r["top"])
    return sel


def parse_rig(bp):
    for f in glob.glob(os.path.join(bp, "rig", "*.xml")):
        s = read(f)
        return {"name": tag(s, "name"), "owner": tag(s, "owner"), "type": tag(s, "typeRig")}
    return None


def finish_wellbore(task):
    """Objects + derived products for one wellbore (runs after its logs are written)."""
    wb_dir, bp, groups_meta, tz = task["dir"], task["path"], task["groups"], task["tz"]
    res = {"objects": {}}
    try:
        trajs = parse_trajectories(bp)
        if trajs:
            dump(trajs, os.path.join(wb_dir, "trajectory.json"))
        msgs = parse_messages(bp)
        if msgs:
            dump(msgs, os.path.join(wb_dir, "messages.json"))
        bha = parse_bha(bp)
        if bha["runs"] or bha["tubulars"]:
            dump(bha, os.path.join(wb_dir, "bha.json"))
        geo = parse_geometry(bp)
        if geo:
            dump(geo, os.path.join(wb_dir, "geometry.json"))
        mud = parse_mudlog(bp)
        if mud:
            dump(mud, os.path.join(wb_dir, "mudlog.json"))
        rig = parse_rig(bp)
        res["objects"] = {"trajectory": len(trajs), "messages": len(msgs), "bhaRuns": len(bha["runs"]),
                          "geometry": len(geo), "mudlog": len(mud)}
        res["rig"] = rig
        if trajs:
            best = max(trajs, key=lambda tr: (tr["stations"][-1]["md"], len(tr["stations"])))
            res["trajectory_td"] = best["stations"][-1]["md"]

        built = build_drilling(wb_dir, groups_meta)
        if built:
            d, srcs, thr = built
            d.to_parquet(os.path.join(wb_dir, "drilling.parquet"), index=False, compression="zstd")
            sr = d["rig_state_rig"].to_numpy()
            rig_cov = float((sr > 0).mean())
            has_rig = rig_cov > 0.2
            dump(daily_stats(d, tz, with_rig=has_rig), os.path.join(wb_dir, "daily.json"))
            conns = connections(d)
            dump(conns, os.path.join(wb_dir, "connections.json"))
            dd = depth_drilling(d)
            if dd is not None:
                dd.to_parquet(os.path.join(wb_dir, "depth_drilling.parquet"), index=False, compression="zstd")
            st = d["rig_state"].to_numpy()
            t = d["t"].to_numpy()
            dt = np.clip(np.diff(t, append=t[-1]) / 1000.0, 0, 60)
            avail = {c: int(np.isfinite(d[c].to_numpy()).sum()) for c in CANON}
            res["drilling"] = {
                "rows": len(d), "start": int(t[0]), "end": int(t[-1]), "sources": srcs, "thresholds": thr,
                "maxHoleDepth": float(np.nanmax(d["hole_depth"])) if np.isfinite(d["hole_depth"]).any() else None,
                "stateHours": (np.bincount(st, weights=dt, minlength=9) / 3600).round(2).tolist(),
                "available": [c for c, n in avail.items() if n > 0],
                "hasDepthDrilling": dd is not None,
                "rigCode": {"coverage": round(rig_cov, 3), "source": "Baker Hughes RigActivityCode"} if has_rig else None,
                "stateHoursRig": (np.bincount(sr, weights=dt, minlength=9) / 3600).round(2).tolist() if has_rig else None,
                # hours where both sources have a state: rows = computed, cols = rig-reported
                "agreement": (np.bincount(st.astype(np.int64) * 9 + sr, weights=dt * ((st > 0) & (sr > 0)), minlength=81)
                              .reshape(9, 9) / 3600).round(2).tolist() if has_rig else None,
                "connections": {"n": len(conns),
                                "s2s_med": float(np.median([c["s2s"] for c in conns])) if conns else None,
                                "w2w_med": float(np.median([c["w2w"] for c in conns])) if conns else None},
            }
    except Exception:
        res["error"] = traceback.format_exc()
    return res


# ----------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out", default=os.path.join(HERE, "store"))
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--force", action="store_true", help="re-parse log groups already in the store")
    ap.add_argument("--only", default=None, help="substring filter on well folder name")
    ap.add_argument("--auto", action="store_true",
                    help="for the launchers: do nothing if the store exists; if no WITSML data is found, exit quietly")
    a = ap.parse_args()
    if a.auto:
        if os.path.exists(os.path.join(a.out, "catalog.json")):
            return
        if not os.path.isdir(a.src):
            print("No WITSML data folder found - starting with the bundled demo wells.\n"
                  "For all wells: download the prebuilt store from the GitHub release, or put the Volve\n"
                  f"'{DATA_DIR_NAME}' folder in ./data/ and run again.", flush=True)
            return
        print("First run: converting the WITSML XML export into the dashboard store (about 5 minutes)...", flush=True)

    T0 = time.time()
    if not os.path.isdir(a.src):
        sys.exit(f"WITSML data folder not found: {a.src}\n"
                 "Download the Volve dataset (https://www.equinor.com/energy/volve-data-sharing), then put its\n"
                 f"'{DATA_DIR_NAME}' folder in ./data/, set DRILLDASH_SRC, or pass --src <folder>.")
    print(f"Scanning {a.src}", flush=True)
    wells = discover(a.src)
    if a.only:
        wells = [w for w in wells if a.only in w["folder"]]
    tasks = []
    for w in wells:
        for b in w["wellbores"]:
            b["dir"] = os.path.join(a.out, w["id"], b["wb"])
            for g in b["groups"]:
                g["out"] = os.path.join(b["dir"], "logs", g["gid"] + ".parquet")
                g["meta_path"] = g["out"] + ".json"
                if a.force or not os.path.exists(g["meta_path"]):
                    tasks.append(g)
    nbytes = sum(g["bytes"] for g in tasks)
    print(f"{len(wells)} wells, {sum(len(w['wellbores']) for w in wells)} wellbores; "
          f"{len(tasks)} log groups to parse ({nbytes / 1e9:.1f} GB)", flush=True)

    tasks.sort(key=lambda g: -g["bytes"])
    done_b = 0
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(ingest_group, {k: g[k] for k in ("gid", "files", "kind", "out")}): g for g in tasks}
        for i, f in enumerate(as_completed(futs), 1):
            g = futs[f]
            try:
                meta = f.result()
            except Exception as e:
                print(f"  ! group {g['gid']} failed: {e}", flush=True)
                continue
            os.makedirs(os.path.dirname(g["meta_path"]), exist_ok=True)
            dump(meta, g["meta_path"])
            done_b += g["bytes"]
            print(f"[{i}/{len(tasks)}] {done_b / max(nbytes, 1) * 100:5.1f}%  {g['gid'][:50]:50s} "
                  f"{meta['rows']:>9,} rows {meta['secs']:6.1f}s  (elapsed {time.time() - T0:.0f}s)", flush=True)

    # attach group metadata
    for w in wells:
        for b in w["wellbores"]:
            for g in b["groups"]:
                g["meta"] = json.load(open(g["meta_path"])) if os.path.exists(g["meta_path"]) else {"rows": 0}

    print("Building derived products per wellbore ...", flush=True)
    fin = []
    for w in wells:
        tz = 0
        for b in w["wellbores"]:
            gm = [{"gid": g["gid"], "kind": g["kind"], "rows": g["meta"].get("rows", 0),
                   "channels": g["meta"].get("channels", [])} for g in b["groups"]]
            fin.append((w, b, {"dir": b["dir"], "path": b["path"], "groups": gm, "tz": tz}))
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(finish_wellbore, t): (w, b) for w, b, t in fin}
        for f in as_completed(futs):
            w, b = futs[f]
            b["derived"] = f.result()
            if "error" in b["derived"]:
                print(f"  ! {w['id']}/{b['wb']}:\n{b['derived']['error']}", flush=True)
            else:
                dr = b["derived"].get("drilling")
                print(f"  {w['id']}/{b['wb']}: drilling rows={dr['rows'] if dr else 0:,}  objects={b['derived']['objects']}",
                      flush=True)

    # catalog
    cat = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "source": a.src, "rigStates": RIG_STATES,
           "canonical": list(CANON.keys()), "wells": []}
    for w in wells:
        W = {"id": w["id"], "folder": w["folder"], "info": w["info"], "wellbores": []}
        for b in w["wellbores"]:
            B = {"wb": b["wb"], "info": b["info"], "derived": b.get("derived", {}), "logs": []}
            for g in b["groups"]:
                m = g["meta"]
                if not m.get("rows"):
                    continue
                desc = g["curves"]
                B["logs"].append({"gid": g["gid"], "name": g["name"], "kind": g["kind"], "rows": m["rows"],
                                  "start": m.get("start"), "end": m.get("end"), "service": g["serviceCompany"],
                                  "channels": [dict(c, desc=(desc.get(c["mnem"]) or {}).get("desc"))
                                               for c in m["channels"]]})
            W["wellbores"].append(B)
        cat["wells"].append(W)
    dump(cat, os.path.join(a.out, "catalog.json"))
    print(f"Done in {time.time() - T0:.0f}s -> {a.out}", flush=True)


if __name__ == "__main__":
    main()

"""quant_factor_db.js 재생성 스크립트 (Kenneth R. French Data Library)

사용법:  python build_factor_db.py
  - FF 5팩터(일간), 모멘텀(일간), 규모×모멘텀 6포트폴리오(일간, 가치가중)를 내려받아
    같은 폴더의 quant_factor_db.js 를 새로 만듭니다. (표준 라이브러리만 사용)
"""
import datetime
import io
import json
import os
import re
import urllib.request
import zipfile

BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"
FILES = {
    "ff5": ("F-F_Research_Data_5_Factors_2x3_daily_CSV.zip", 6),
    "mom": ("F-F_Momentum_Factor_daily_CSV.zip", 1),
    "mp6": ("6_Portfolios_ME_Prior_12_2_Daily_CSV.zip", 6),
}
START = "1985-01-01"


def download(name):
    req = urllib.request.Request(BASE + name, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return z.read(z.namelist()[0]).decode("latin-1")


def parse_first_section(text, ncols):
    """첫 번째 일간 데이터 구간(가치가중)만 파싱. 단위: % → 소수"""
    out, started = {}, False
    for ln in text.splitlines():
        m = re.match(r"^\s*(\d{8})\s*,(.*)$", ln)
        if not m:
            if started:
                break
            continue
        started = True
        vals = [float(x) for x in m.group(2).split(",")[:ncols]]
        d = m.group(1)
        ds = f"{d[:4]}-{d[4:6]}-{d[6:]}"
        if ds >= START:
            out[ds] = [None if v <= -99.99 else round(v / 100, 5) for v in vals]
    return out


def main():
    src = {k: parse_first_section(download(f), n) for k, (f, n) in FILES.items()}
    dates = sorted(set().union(*[set(v) for v in src.values()]))

    def col(key, idx):
        s = src[key]
        return [s[d][idx] if d in s else None for d in dates]

    db = {
        "meta": {
            "source": "Kenneth R. French Data Library (CRSP): F-F Research Data 5 Factors 2x3 Daily, "
                      "Momentum Factor Daily, 6 Portfolios Formed on Size and Momentum (2x3) Daily (value-weighted). "
                      "단위: 일간 수익률(소수).",
            "ffLast": max(src["ff5"]), "momLast": max(src["mom"]), "mp6Last": max(src["mp6"]),
            "built": datetime.date.today().isoformat(),
        },
        "dates": dates,
        "mktrf": col("ff5", 0), "smb": col("ff5", 1), "hml": col("ff5", 2),
        "rmw": col("ff5", 3), "cma": col("ff5", 4), "rf": col("ff5", 5),
        "mom": col("mom", 0),
        "smallLo": col("mp6", 0), "smallMid": col("mp6", 1), "smallHi": col("mp6", 2),
        "bigLo": col("mp6", 3), "bigMid": col("mp6", 4), "bigHi": col("mp6", 5),
    }
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "quant_factor_db.js")
    with open(path, "w", encoding="utf-8") as f:
        f.write("// 자동 생성 파일 — Kenneth R. French Data Library 일간 팩터/포트폴리오 (1985~)\n")
        f.write("// 재생성: python build_factor_db.py\n")
        f.write("const QUANT_FACTOR_DB = " + json.dumps(db, separators=(",", ":")) + ";\n")
    print(f"완료: {path} ({len(dates)}일, {dates[0]} ~ {dates[-1]}, FF5 ~{db['meta']['ffLast']})")


if __name__ == "__main__":
    main()

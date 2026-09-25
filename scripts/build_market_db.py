"""offline_market_db.js 재생성 스크립트 (Yahoo Finance / yfinance)

사용법:  pip install "yfinance>=0.2.40"  →  python scripts/build_market_db.py
  - 1985년부터 각 종목의 배당 반영 수정주가(Adj Close)와 배당(현금분배)을 받아
    저장소 루트의 offline_market_db.js 를 만듭니다.
  - 안전장치: 수신 실패·데이터 급감·검증 실패 종목은 기존 파일의 데이터를 그대로 유지합니다.
  - 자체 검증: 앱(quant_engine.js)과 같은 방식으로 원주가를 역산해 Yahoo 종가와 비교합니다.
"""
import datetime
import json
import math
import os
import sys
import time

import yfinance as yf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "offline_market_db.js")
START = "1985-01-01"

# 앱의 TICKER_UNIVERSE 심볼 + 백필 기초자산 + 환율
SYMBOLS = [
    "SPY", "QQQ", "SPMO", "VOO", "VTI", "QQQM", "TLT", "GLD", "IWM", "SMH", "XLK", "XLE", "SCHD", "JEPI", "ARKK",
    "QLD", "TQQQ", "SSO", "UPRO", "SOXL", "GGLL", "SQQQ", "TMF",
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "BRK-B", "LLY", "TSM", "AVGO",
    "KRW=X", "^GSPC", "^NDX", "^IXIC", "^SOX", "^TYX", "^KS11",
    "005930.KS", "000660.KS", "005380.KS", "000270.KS", "035420.KS", "035720.KS", "068270.KS", "105560.KS",
    "207940.KS", "373220.KS",
]
NO_DIVIDEND = {"KRW=X", "^GSPC", "^NDX", "^IXIC", "^SOX", "^TYX", "^KS11"}


def sig(v, digits=6):
    """유효숫자 반올림 (소형가 종목 정밀도 유지)"""
    if v == 0 or not math.isfinite(v):
        return 0.0
    return float(f"{v:.{digits}g}")


def load_existing():
    if not os.path.exists(OUT):
        return {"prices": {}, "divs": {}}
    s = open(OUT, encoding="utf-8").read()
    try:
        return json.loads(s[s.index("{"):s.rindex("}") + 1])
    except Exception as e:  # noqa: BLE001
        print(f"[경고] 기존 파일 파싱 실패: {e}")
        return {"prices": {}, "divs": {}}


def reconstruct_error(adj, divs, close):
    """앱과 동일한 역산: raw[i] = adj[i]/f, 배당일 e에서 f *= 1 - D/(adj[e-1]/f + D). 종가 대비 최대 오차 반환"""
    dates = sorted(adj)
    f, worst = 1.0, 0.0
    for i in range(len(dates) - 1, -1, -1):
        d = dates[i]
        raw = adj[d] / f
        c = close.get(d)
        if c and c > 0:
            worst = max(worst, abs(raw / c - 1))
        D = divs.get(d)
        if D and i > 0:
            prev_raw = adj[dates[i - 1]] / f + D
            y = D / prev_raw
            if 0 < y < 0.35:
                f *= 1 - y
    return worst


def fetch(sym):
    h = yf.Ticker(sym).history(start=START, auto_adjust=False, actions=True, repair=False)
    if h is None or h.empty:
        raise RuntimeError("빈 응답")
    today = datetime.date.today().isoformat()
    adj, close, div1, div2 = {}, {}, {}, {}
    for ts, row in h.iterrows():
        d = ts.strftime("%Y-%m-%d")
        if d >= today:  # 장중 미확정 봉 제외
            continue
        a, c = row.get("Adj Close"), row.get("Close")
        if a is not None and math.isfinite(a) and a > 0:
            adj[d] = sig(float(a))
        if c is not None and math.isfinite(c) and c > 0:
            close[d] = float(c)
        dv = float(row.get("Dividends", 0) or 0)
        cg = float(row.get("Capital Gains", 0) or 0) if "Capital Gains" in h.columns else 0.0
        if dv > 0:
            div1[d] = sig(dv)
        if dv + cg > 0:
            div2[d] = sig(dv + cg)
    if len(adj) < 20:
        raise RuntimeError(f"데이터 부족 ({len(adj)}행)")
    if sym in NO_DIVIDEND:
        return adj, {}, 0.0
    # 배당만 / 배당+자본이득 중 역산 오차가 작은 쪽 선택
    e1 = reconstruct_error(adj, div1, close)
    e2 = reconstruct_error(adj, div2, close) if div2 != div1 else e1
    return (adj, div2, e2) if e2 < e1 else (adj, div1, e1)


def main():
    old = load_existing()
    prices, divs, report = {}, {}, []
    for sym in SYMBOLS:
        prev_p = old.get("prices", {}).get(sym, {})
        prev_d = old.get("divs", {}).get(sym, {})
        try:
            p, d, err = None, None, None
            for attempt in range(3):
                try:
                    p, d, err = fetch(sym)
                    break
                except Exception:  # noqa: BLE001
                    if attempt == 2:
                        raise
                    time.sleep(3 * (attempt + 1))
            if prev_p and len(p) < 0.9 * len(prev_p):
                raise RuntimeError(f"행 수 급감 {len(prev_p)}→{len(p)}")
            if prev_p and max(p) < max(prev_p):
                raise RuntimeError(f"마지막 날짜 후퇴 {max(prev_p)}→{max(p)}")
            if err is not None and err > 0.03:
                raise RuntimeError(f"원주가 역산 검증 실패 (최대 오차 {err:.1%})")
            prices[sym], divs[sym] = p, d
            report.append(f"OK   {sym:10s} {min(p)} ~ {max(p)}  {len(p):5d}행  배당 {len(d):3d}건  역산오차 {err:.3%}")
        except Exception as e:  # noqa: BLE001
            prices[sym], divs[sym] = prev_p, prev_d
            report.append(f"KEEP {sym:10s} 기존 데이터 유지 ({e})")
    # 목록에서 빠진 기존 심볼도 보존
    for sym, v in old.get("prices", {}).items():
        if sym not in prices:
            prices[sym], divs[sym] = v, old.get("divs", {}).get(sym, {})

    last = max(prices.get("SPY") or {"": ""})
    meta = {"priceType": "adjclose", "source": "Yahoo Finance (yfinance) Adj Close + Dividends",
            "built": datetime.date.today().isoformat(), "lastDate": last}
    # 종목당 한 줄 → git 변경분(diff) 최소화
    lines = ["const EMBEDDED_OFFLINE_MARKET_DB = {", f'"meta": {json.dumps(meta, ensure_ascii=False)},', '"prices": {']
    keys = list(prices)
    for i, k in enumerate(keys):
        body = json.dumps(dict(sorted(prices[k].items())), separators=(",", ":"))
        lines.append(f"{json.dumps(k)}: {body}{',' if i < len(keys) - 1 else ''}")
    lines.append("},")
    lines.append('"divs": {')
    for i, k in enumerate(keys):
        body = json.dumps(dict(sorted((divs.get(k) or {}).items())), separators=(",", ":"))
        lines.append(f"{json.dumps(k)}: {body}{',' if i < len(keys) - 1 else ''}")
    lines.append("}};")
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    # 결과 파일이 올바른 JSON 인지 재검증 후 교체
    s = open(tmp, encoding="utf-8").read()
    json.loads(s[s.index("{"):s.rindex("}") + 1])
    os.replace(tmp, OUT)
    print("\n".join(report))
    kept = sum(1 for r in report if r.startswith("KEEP"))
    print(f"\n완료: {OUT}  (기준일 {last}, 갱신 {len(report) - kept} / 유지 {kept})")
    if kept == len(report):
        sys.exit("모든 종목 수신 실패 — 파일 내용은 기존과 동일합니다.")


if __name__ == "__main__":
    main()

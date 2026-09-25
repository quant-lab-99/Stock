/* ============================================================================
 * quant_engine.js — ETF 적립식 백테스트 엔진 v16.0
 *  - 데이터 수집/정규화(원주가 + 배당 분리), 백필 합성, 포트폴리오 시뮬레이터,
 *    성과/위험 분석, Fama-French 회귀, 몬테카를로, 퀀트 점수, AI 최적화기
 *  - 의존: quant_factor_db.js (QUANT_FACTOR_DB), offline_market_db.js (EMBEDDED_OFFLINE_MARKET_DB)
 * ========================================================================== */
'use strict';

const GLOBAL_QUANT_CONFIG = Object.freeze({
  TAX_RATE: 0.22,                 // 해외주식 양도소득세 (지방세 포함)
  TAX_ALLOWANCE_KRW: 2500000,     // 연 기본공제
  US_DIV_WITHHOLDING: 0.15,       // 미국 배당 원천징수
  KR_DIV_TAX: 0.154,              // 국내 배당소득세
  KR_STOCK_SELL_TAX: 0.0020,      // 코스피 매도 거래세(농특세 포함, 2026년 기준) — 세율 변경 시 조정
  EPS: 1e-9,
  TRADING_DAYS: 252,
  MC_ITERATIONS: 10000,
  AVAIL_TOLERANCE_DAYS: 10,       // 시작일 대비 데이터 시작 허용 오차(일)
  CORS_WORKER_PROXY: 'https://my-yahoo-proxy.rlfhdzk.workers.dev/?url='
});

/* ----------------------------------------------------------------------------
 * 공용 유틸
 * -------------------------------------------------------------------------- */
class QuantUtils {
  static isDomestic(ticker) {
    if (!ticker) return false;
    if (ticker.endsWith('.KS') || ticker.endsWith('.KQ') || ticker === 'KOSPI' || ticker === '^KS11') return true;
    const cfg = TICKER_UNIVERSE[ticker];
    return cfg ? cfg.currency === 'KRW' : false;
  }

  static isKrStock(ticker) {
    const cfg = TICKER_UNIVERSE[ticker];
    return !!cfg && cfg.currency === 'KRW' && cfg.category === 'kr_top' && ticker !== 'KOSPI';
  }

  static formatKRW(val) {
    if (val === null || val === undefined || isNaN(val)) return '0원';
    const absVal = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    if (absVal >= 1e8) {
      const uk = Math.floor(absVal / 1e8);
      const man = Math.round((absVal % 1e8) / 1e4);
      if (man === 0) return `${sign}${uk.toLocaleString()}억 원`;
      if (man === 10000) return `${sign}${(uk + 1).toLocaleString()}억 원`;
      return `${sign}${uk.toLocaleString()}억 ${man.toLocaleString()}만 원`;
    } else if (absVal >= 1e4) {
      return `${sign}${Math.round(absVal / 1e4).toLocaleString()}만 원`;
    }
    return `${sign}${Math.round(absVal).toLocaleString()}원`;
  }

  static parseDateUTC(dateStr) {
    const p = dateStr.split('-');
    return Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2] || '1', 10));
  }

  static daysBetween(a, b) {
    return (QuantUtils.parseDateUTC(b) - QuantUtils.parseDateUTC(a)) / 86400000;
  }

  static escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  static async fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000 } = options;
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(resource, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timerId);
    }
  }

  /** FNV-1a 32bit 해시 (시드 생성용) */
  static hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** 시드 고정 난수 생성기 (재현 가능한 몬테카를로/부트스트랩) */
  static mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** CSV 셀: 따옴표 이스케이프 + 수식 주입(=,+,-,@) 방지 */
  static csvCell(v) {
    let s = (v === null || v === undefined) ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /** arr[i] >= x 인 첫 인덱스 */
  static lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (arr[m] < x) lo = m + 1; else hi = m;
    }
    return lo;
  }

  /** arr[i] <= x 인 마지막 인덱스 (-1: 없음) */
  static lastIndexLE(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (arr[m] <= x) lo = m + 1; else hi = m;
    }
    return lo - 1;
  }

  static yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  static monthOf(dateStr) { return parseInt(dateStr.substring(5, 7), 10); }
}

/* ----------------------------------------------------------------------------
 * 자산 유니버스
 *  proxyType: direct | index_tracking | leveraged | bond_duration | factor | index_direct
 *  inceptDate: 실제 데이터 시작(월), backfillMinDate: 합성 포함 최초 선택 가능 월
 * -------------------------------------------------------------------------- */
const TICKER_UNIVERSE = {
  // ① 대표 지수 & 배당/섹터 ETF (USD)
  'SPY':   { name: 'SPDR S&P 500 ETF Trust', category: 'index_etf', currency: 'USD', base: '^GSPC', leverage: 1, fee: 0.000945, inceptDate: '1993-02', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'index_tracking' },
  'QQQ':   { name: 'Invesco QQQ Trust (나스닥 100)', category: 'index_etf', currency: 'USD', base: '^NDX', altBase: '^IXIC', leverage: 1, fee: 0.0020, inceptDate: '1999-04', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'index_tracking' },
  'VOO':   { name: 'Vanguard S&P 500 ETF (초저보수)', category: 'index_etf', currency: 'USD', base: 'SPY', leverage: 1, fee: 0.0003, inceptDate: '2010-10', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'index_tracking' },
  'VTI':   { name: 'Vanguard Total Stock Market (미국 전체)', category: 'index_etf', currency: 'USD', base: 'SPY', leverage: 1, fee: 0.0003, inceptDate: '2001-06', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'index_tracking' },
  'QQQM':  { name: 'Invesco NASDAQ 100 ETF (초저보수)', category: 'index_etf', currency: 'USD', base: 'QQQ', leverage: 1, fee: 0.0015, inceptDate: '2020-11', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'index_tracking' },
  'IWM':   { name: 'iShares Russell 2000 ETF (중소형주)', category: 'index_etf', currency: 'USD', base: null, leverage: 1, fee: 0.0019, inceptDate: '2000-06', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'factor', factorModel: 'SMALL_CAP' },
  'SCHD':  { name: 'Schwab US Dividend Equity (미국 배당성장)', category: 'index_etf', currency: 'USD', base: null, leverage: 1, fee: 0.0006, inceptDate: '2011-11', allowBackfill: false, backfillMinDate: '2011-11', proxyType: 'direct' },
  'SPMO':  { name: 'Invesco S&P 500 Momentum ETF (모멘텀 팩터)', category: 'index_etf', currency: 'USD', base: null, leverage: 1, fee: 0.0013, inceptDate: '2015-11', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'factor', factorModel: 'LARGE_MOMENTUM' },
  'JEPI':  { name: 'JPMorgan Equity Premium Income (월배당 커버드콜)', category: 'index_etf', currency: 'USD', base: null, leverage: 1, fee: 0.0035, inceptDate: '2020-06', allowBackfill: false, backfillMinDate: '2020-06', proxyType: 'direct' },
  'SMH':   { name: 'VanEck Semiconductor ETF (반도체)', category: 'index_etf', currency: 'USD', base: '^SOX', leverage: 1, fee: 0.0035, inceptDate: '2000-07', allowBackfill: true, backfillMinDate: '1994-06', proxyType: 'index_tracking' },
  'XLK':   { name: 'Technology Select Sector SPDR (기술주)', category: 'index_etf', currency: 'USD', base: null, leverage: 1, fee: 0.0008, inceptDate: '1999-01', allowBackfill: false, backfillMinDate: '1999-01', proxyType: 'direct' },
  'XLE':   { name: 'Energy Select Sector SPDR (에너지)', category: 'index_etf', currency: 'USD', base: null, leverage: 1, fee: 0.0008, inceptDate: '1999-01', allowBackfill: false, backfillMinDate: '1999-01', proxyType: 'direct' },
  'ARKK':  { name: 'ARK Innovation ETF (파괴적 혁신)', category: 'index_etf', currency: 'USD', base: null, leverage: 1, fee: 0.0075, inceptDate: '2014-11', allowBackfill: false, backfillMinDate: '2014-11', proxyType: 'direct' },

  // ② 레버리지 & 인버스 ETF (기초자산 총수익 × 배율 − 조달비용 − 보수)
  'QLD':   { name: 'ProShares Ultra QQQ (나스닥 2배)', category: 'leveraged_etf', currency: 'USD', base: 'QQQ', leverage: 2, fee: 0.0095, inceptDate: '2006-07', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'leveraged', swapSpread: 0.0045, trackingError: 0.0020 },
  'TQQQ':  { name: 'ProShares UltraPro QQQ (나스닥 3배)', category: 'leveraged_etf', currency: 'USD', base: 'QQQ', leverage: 3, fee: 0.0084, inceptDate: '2010-03', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'leveraged', swapSpread: 0.0055, trackingError: 0.0035 },
  'SSO':   { name: 'ProShares Ultra S&P 500 (S&P 2배)', category: 'leveraged_etf', currency: 'USD', base: 'SPY', leverage: 2, fee: 0.0089, inceptDate: '2006-07', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'leveraged', swapSpread: 0.0040, trackingError: 0.0018 },
  'UPRO':  { name: 'ProShares UltraPro S&P 500 (S&P 3배)', category: 'leveraged_etf', currency: 'USD', base: 'SPY', leverage: 3, fee: 0.0091, inceptDate: '2009-07', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'leveraged', swapSpread: 0.0050, trackingError: 0.0030 },
  'SOXL':  { name: 'Direxion Semiconductor Bull 3X (반도체 3배)', category: 'leveraged_etf', currency: 'USD', base: 'SMH', leverage: 3, fee: 0.0075, inceptDate: '2010-04', allowBackfill: true, backfillMinDate: '1994-06', proxyType: 'leveraged', swapSpread: 0.0065, trackingError: 0.0045 },
  'GGLL':  { name: 'GraniteShares 2x Long GOOGL (구글 2배)', category: 'leveraged_etf', currency: 'USD', base: 'GOOGL', leverage: 2, fee: 0.0099, inceptDate: '2022-10', allowBackfill: true, backfillMinDate: '2004-09', proxyType: 'leveraged', swapSpread: 0.0060, trackingError: 0.0040 },
  'SQQQ':  { name: 'ProShares UltraPro Short QQQ (나스닥 -3배)', category: 'leveraged_etf', currency: 'USD', base: 'QQQ', leverage: -3, fee: 0.0095, inceptDate: '2010-03', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'leveraged', swapSpread: 0.0070, trackingError: 0.0050 },
  'TMF':   { name: 'Direxion 20+ Year Treasury Bull 3X (미국채 3배)', category: 'leveraged_etf', currency: 'USD', base: 'TLT', leverage: 3, fee: 0.0091, inceptDate: '2009-05', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'leveraged', swapSpread: 0.0045, trackingError: 0.0025 },

  // ③ 안전자산 & 채권/원자재
  'TLT':   { name: 'iShares 20+ Year Treasury (미국 장기채)', category: 'bond_commodity', currency: 'USD', base: '^TYX', leverage: 1, fee: 0.0015, inceptDate: '2002-08', allowBackfill: true, backfillMinDate: '1985-01', proxyType: 'bond_duration' },
  'GLD':   { name: 'SPDR Gold Shares (금 현물)', category: 'bond_commodity', currency: 'USD', base: null, leverage: 1, fee: 0.0040, inceptDate: '2004-12', allowBackfill: false, backfillMinDate: '2004-12', proxyType: 'direct' },

  // ④ 미국 메가캡 (개별 주식: 상장일 이전 백필 금지)
  'AAPL':  { name: '애플 (Apple)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '1985-01', allowBackfill: false, backfillMinDate: '1985-01', proxyType: 'direct' },
  'MSFT':  { name: '마이크로소프트 (Microsoft)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '1986-04', allowBackfill: false, backfillMinDate: '1986-04', proxyType: 'direct' },
  'NVDA':  { name: '엔비디아 (NVIDIA)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '1999-02', allowBackfill: false, backfillMinDate: '1999-02', proxyType: 'direct' },
  'GOOGL': { name: '구글 (Alphabet A)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '2004-09', allowBackfill: false, backfillMinDate: '2004-09', proxyType: 'direct' },
  'AMZN':  { name: '아마존 (Amazon)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '1997-06', allowBackfill: false, backfillMinDate: '1997-06', proxyType: 'direct' },
  'META':  { name: '메타 (Meta Platforms)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '2012-06', allowBackfill: false, backfillMinDate: '2012-06', proxyType: 'direct' },
  'TSLA':  { name: '테슬라 (Tesla)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '2010-07', allowBackfill: false, backfillMinDate: '2010-07', proxyType: 'direct' },
  'BRK-B': { name: '버크셔해서웨이 (Berkshire B)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '1996-06', allowBackfill: false, backfillMinDate: '1996-06', proxyType: 'direct' },
  'LLY':   { name: '일라이릴리 (Eli Lilly)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '1985-01', allowBackfill: false, backfillMinDate: '1985-01', proxyType: 'direct' },
  'TSM':   { name: 'TSMC (대만반도체 ADR)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '1997-11', allowBackfill: false, backfillMinDate: '1997-11', proxyType: 'direct' },
  'AVGO':  { name: '브로드컴 (Broadcom)', category: 'us_top', currency: 'USD', base: null, leverage: 1, fee: 0, inceptDate: '2009-09', allowBackfill: false, backfillMinDate: '2009-09', proxyType: 'direct' },

  // ⑤ 한국 KOSPI & 대표주 (KRW)
  'KOSPI':            { name: '코스피 지수 (인덱스펀드 근사: 추정 배당 포함)', symbol: '^KS11', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0.0005, inceptDate: '1997-01', allowBackfill: false, backfillMinDate: '1997-01', proxyType: 'index_direct' },
  '삼성전자':          { name: '삼성전자 (005930)', symbol: '005930.KS', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0, inceptDate: '2000-01', allowBackfill: false, backfillMinDate: '2000-01', proxyType: 'direct' },
  'SK하이닉스':        { name: 'SK하이닉스 (000660)', symbol: '000660.KS', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0, inceptDate: '2003-01', allowBackfill: false, backfillMinDate: '2003-01', proxyType: 'direct' },
  'LG에너지솔루션':    { name: 'LG에너지솔루션 (373220)', symbol: '373220.KS', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0, inceptDate: '2022-02', allowBackfill: false, backfillMinDate: '2022-02', proxyType: 'direct' },
  '삼성바이오로직스':  { name: '삼성바이오로직스 (207940)', symbol: '207940.KS', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0, inceptDate: '2016-12', allowBackfill: false, backfillMinDate: '2016-12', proxyType: 'direct' },
  '현대차':            { name: '현대차 (005380)', symbol: '005380.KS', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0, inceptDate: '2000-01', allowBackfill: false, backfillMinDate: '2000-01', proxyType: 'direct' },
  '기아':              { name: '기아 (000270)', symbol: '000270.KS', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0, inceptDate: '2000-01', allowBackfill: false, backfillMinDate: '2000-01', proxyType: 'direct' },
  '셀트리온':          { name: '셀트리온 (068270)', symbol: '068270.KS', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0, inceptDate: '2005-08', allowBackfill: false, backfillMinDate: '2005-08', proxyType: 'direct' },
  'KB금융':            { name: 'KB금융 (105560)', symbol: '105560.KS', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0, inceptDate: '2008-10', allowBackfill: false, backfillMinDate: '2008-10', proxyType: 'direct' },
  'NAVER':             { name: 'NAVER (035420)', symbol: '035420.KS', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0, inceptDate: '2002-11', allowBackfill: false, backfillMinDate: '2002-11', proxyType: 'direct' },
  '카카오':            { name: '카카오 (035720)', symbol: '035720.KS', category: 'kr_top', currency: 'KRW', base: null, leverage: 1, fee: 0, inceptDate: '2014-10', allowBackfill: false, backfillMinDate: '2014-10', proxyType: 'direct' }
};

/** 가격지수(배당 미포함)의 추정 배당수익률 — 분기말 합성 분배금으로 총수익 보정 (근사치) */
const SP500_DIV_YIELD_BY_YEAR = {
  1985: 0.040, 1986: 0.035, 1987: 0.032, 1988: 0.036, 1989: 0.033, 1990: 0.036, 1991: 0.032, 1992: 0.029,
  1993: 0.028, 1994: 0.028, 1995: 0.025, 1996: 0.021, 1997: 0.017, 1998: 0.014, 1999: 0.012, 2000: 0.012,
  2001: 0.013, 2002: 0.017, 2003: 0.017, 2004: 0.016, 2005: 0.018, 2006: 0.018, 2007: 0.018, 2008: 0.028,
  2009: 0.022, 2010: 0.019, 2011: 0.020, 2012: 0.021, 2013: 0.020, 2014: 0.019, 2015: 0.021, 2016: 0.021,
  2017: 0.019, 2018: 0.020, 2019: 0.019, 2020: 0.017, 2021: 0.013, 2022: 0.016, 2023: 0.015, 2024: 0.013,
  2025: 0.012, 2026: 0.012
};
const INDEX_DIVIDEND_YIELD = {
  '^GSPC': (y) => SP500_DIV_YIELD_BY_YEAR[y] ?? 0.018,
  '^NDX':  () => 0.008,
  '^IXIC': () => 0.009,
  '^RUT':  () => 0.014,
  '^SOX':  () => 0.012,
  '^KS11': () => 0.017
};

/** 2003-12 이전 USD/KRW 월평균 근사치 (한국은행 공표치 기반 근사, ±3% 오차 가능) — 선형 보간 */
const FX_PRE2004_ANCHORS = [
  ['1985-01-15', 830], ['1985-06-15', 880], ['1985-12-15', 890], ['1986-06-15', 885], ['1986-12-15', 862],
  ['1987-06-15', 805], ['1987-12-15', 795], ['1988-06-15', 730], ['1988-12-15', 685], ['1989-06-15', 668],
  ['1989-12-15', 679], ['1990-06-15', 715], ['1990-12-15', 716], ['1991-06-15', 726], ['1991-12-15', 760],
  ['1992-06-15', 786], ['1992-12-15', 788], ['1993-06-15', 806], ['1993-12-15', 809], ['1994-06-15', 806],
  ['1994-12-15', 789], ['1995-06-15', 759], ['1995-12-15', 773], ['1996-06-15', 805], ['1996-12-15', 839],
  ['1997-01-15', 850], ['1997-02-15', 866], ['1997-03-15', 880], ['1997-04-15', 894], ['1997-05-15', 892],
  ['1997-06-15', 889], ['1997-07-15', 891], ['1997-08-15', 895], ['1997-09-15', 909], ['1997-10-15', 922],
  ['1997-11-15', 1025], ['1997-12-15', 1484], ['1998-01-15', 1706], ['1998-02-15', 1623], ['1998-03-15', 1506],
  ['1998-04-15', 1392], ['1998-05-15', 1394], ['1998-06-15', 1397], ['1998-07-15', 1301], ['1998-08-15', 1302],
  ['1998-09-15', 1374], ['1998-10-15', 1328], ['1998-11-15', 1255], ['1998-12-15', 1206], ['1999-01-15', 1175],
  ['1999-03-15', 1227], ['1999-06-15', 1161], ['1999-09-15', 1198], ['1999-12-15', 1139], ['2000-03-15', 1117],
  ['2000-06-15', 1118], ['2000-09-15', 1115], ['2000-10-15', 1139], ['2000-11-15', 1175], ['2000-12-15', 1265],
  ['2001-03-15', 1304], ['2001-04-15', 1320], ['2001-06-15', 1297], ['2001-09-15', 1296], ['2001-12-15', 1291],
  ['2002-03-15', 1322], ['2002-06-15', 1250], ['2002-09-15', 1215], ['2002-12-15', 1203], ['2003-03-15', 1253],
  ['2003-06-15', 1195], ['2003-09-15', 1170], ['2003-11-28', 1195]
];

/** Fama-French 무위험금리 미보유 구간용 연도별 3개월 T-Bill 근사(%) */
const FALLBACK_TBILL_PCT = {
  1985: 7.5, 1986: 6.0, 1987: 5.8, 1988: 6.7, 1989: 8.1, 1990: 7.5, 1991: 5.4, 1992: 3.4, 1993: 3.0, 1994: 4.3,
  1995: 5.5, 1996: 5.0, 1997: 5.1, 1998: 4.8, 1999: 4.7, 2000: 5.8, 2001: 3.4, 2002: 1.6, 2003: 1.0, 2004: 1.4,
  2005: 3.2, 2006: 4.7, 2007: 4.4, 2008: 1.4, 2009: 0.15, 2010: 0.14, 2011: 0.05, 2012: 0.09, 2013: 0.06, 2014: 0.03,
  2015: 0.05, 2016: 0.32, 2017: 0.93, 2018: 1.94, 2019: 2.06, 2020: 0.37, 2021: 0.05, 2022: 2.02, 2023: 5.07, 2024: 4.97,
  2025: 4.2, 2026: 3.9
};

/** 팩터 모사(factor-mimicking) 백필 모델 */
const FACTOR_MODELS = {
  LARGE_MOMENTUM: {
    label: 'Fama-French 대형 모멘텀 포트폴리오(BIG HiPRIOR) + 시장(MKT-RF) 회귀',
    names: ['BIG_HiPRIOR−RF', 'MKT−RF'],
    x: [(r) => (r.bigHi === null || r.rf === null) ? NaN : r.bigHi - r.rf, (r) => r.mktRf === null ? NaN : r.mktRf],
    defaults: [0.675, 0.226]
  },
  SMALL_CAP: {
    label: 'Fama-French 소형주 포트폴리오(SMALL 3분위 평균) + 시장(MKT-RF) 회귀',
    names: ['SMALL−RF', 'MKT−RF'],
    x: [(r) => (r.smallAvg === null || r.rf === null) ? NaN : r.smallAvg - r.rf, (r) => r.mktRf === null ? NaN : r.mktRf],
    defaults: [0.815, 0.198]
  }
};

/* ----------------------------------------------------------------------------
 * Fama-French 데이터 (quant_factor_db.js)
 * -------------------------------------------------------------------------- */
class FactorData {
  static _idx = null;
  static _rfFilled = null;

  static available() {
    return typeof QUANT_FACTOR_DB !== 'undefined' && Array.isArray(QUANT_FACTOR_DB.dates) && QUANT_FACTOR_DB.dates.length > 0;
  }

  static _init() {
    if (this._idx) return;
    this._idx = new Map();
    if (!this.available()) return;
    const D = QUANT_FACTOR_DB;
    D.dates.forEach((d, i) => this._idx.set(d, i));
    const rf = new Float64Array(D.dates.length);
    let last = NaN;
    for (let i = 0; i < rf.length; i++) {
      if (D.rf[i] !== null && D.rf[i] !== undefined) last = D.rf[i];
      rf[i] = last;
    }
    const firstValid = rf.findIndex(v => !isNaN(v));
    for (let i = 0; i < firstValid; i++) rf[i] = rf[firstValid];
    this._rfFilled = rf;
  }

  static meta() { return this.available() ? QUANT_FACTOR_DB.meta : null; }

  static row(dateStr) {
    this._init();
    const i = this._idx.get(dateStr);
    if (i === undefined) return null;
    const D = QUANT_FACTOR_DB;
    const s = [D.smallLo[i], D.smallMid[i], D.smallHi[i]];
    return {
      mktRf: D.mktrf[i], smb: D.smb[i], hml: D.hml[i], rmw: D.rmw[i], cma: D.cma[i], rf: D.rf[i], mom: D.mom[i],
      bigHi: D.bigHi[i],
      smallAvg: s.some(v => v === null || v === undefined) ? null : (s[0] + s[1] + s[2]) / 3
    };
  }

  static rfDaily(dateStr) {
    this._init();
    if (!this._rfFilled) return null;
    const k = QuantUtils.lastIndexLE(QUANT_FACTOR_DB.dates, dateStr);
    if (k < 0) return null;
    return this._rfFilled[k];
  }
}

class HistoricalInterestRates {
  /** 일간 무위험수익률 (Fama-French RF = 1개월 T-Bill, 미보유 시 연도별 근사) */
  static rfDaily(dateStr) {
    const v = FactorData.rfDaily(dateStr);
    if (v !== null && !isNaN(v)) return v;
    const year = parseInt(dateStr.substring(0, 4), 10);
    const pct = FALLBACK_TBILL_PCT[year] ?? (year < 1985 ? 7.5 : 3.9);
    return pct / 100 / GLOBAL_QUANT_CONFIG.TRADING_DAYS;
  }
}

class FxHistory {
  static pre2004(dateStr) {
    const A = FX_PRE2004_ANCHORS;
    if (dateStr <= A[0][0]) return A[0][1];
    const t = QuantUtils.parseDateUTC(dateStr);
    for (let k = 1; k < A.length; k++) {
      if (dateStr <= A[k][0]) {
        const t0 = QuantUtils.parseDateUTC(A[k - 1][0]);
        const t1 = QuantUtils.parseDateUTC(A[k][0]);
        const w = (t - t0) / (t1 - t0);
        return A[k - 1][1] + (A[k][1] - A[k - 1][1]) * w;
      }
    }
    return A[A.length - 1][1];
  }
}

/* ----------------------------------------------------------------------------
 * 캐시 (IndexedDB, 24h TTL)
 * -------------------------------------------------------------------------- */
class QuantDataCache {
  static dbName = 'QuantBacktestCacheDB_v16';
  static storeName = 'timeSeriesStore';
  static TTL_MS = 24 * 60 * 60 * 1000;
  static dbPromise = null;

  static async openDB() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => { this.dbPromise = null; reject(e.target.error); };
    });
    return this.dbPromise;
  }

  static async get(key) {
    try {
      const db = await this.openDB();
      return await new Promise((resolve) => {
        const req = db.transaction(this.storeName, 'readonly').objectStore(this.storeName).get(key);
        req.onsuccess = () => {
          const res = req.result;
          resolve(res && res.timestamp && (Date.now() - res.timestamp < this.TTL_MS) ? res : null);
        };
        req.onerror = () => resolve(null);
      });
    } catch { return null; }
  }

  static async set(key, value) {
    try {
      const db = await this.openDB();
      value.timestamp = Date.now();
      db.transaction(this.storeName, 'readwrite').objectStore(this.storeName).put(value, key);
    } catch (e) { console.warn('[Cache] write error:', e); }
  }
}

/* ----------------------------------------------------------------------------
 * 가격 정규화: 모든 소스를 "원주가(분할만 반영) + 배당(주당 현금)" 형태로 통일
 * -------------------------------------------------------------------------- */
class PriceSeriesNormalizer {
  static sortedEntries(map) {
    return Array.from(map.entries())
      .filter(([d, p]) => typeof d === 'string' && typeof p === 'number' && isFinite(p) && p > 0)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /** 고립된 스파이크(단일 이상치) 제거 */
  static sanitize(entries) {
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const p = entries[i][1];
      if (i > 0 && i < entries.length - 1) {
        const prev = entries[i - 1][1], next = entries[i + 1][1];
        const jump = p / prev, back = next / prev;
        if ((jump > 4 || jump < 0.25) && back > 0.8 && back < 1.25) continue;
      }
      out.push(entries[i]);
    }
    return out;
  }

  /** 배당일을 가장 가까운 이후 거래일 인덱스로 정렬 */
  static alignDivs(dates, divMap) {
    const out = new Map();
    if (!divMap) return out;
    for (const [d, a] of divMap.entries()) {
      if (!(typeof a === 'number' && a > 0)) continue;
      const k = QuantUtils.lowerBound(dates, d);
      if (k <= 0 || k >= dates.length) continue;
      if (QuantUtils.daysBetween(d, dates[k]) > 10) continue;
      out.set(k, (out.get(k) || 0) + a);
    }
    return out;
  }

  /**
   * 배당 반영 수정주가(adjclose) → 원주가 역산.
   * Yahoo/CRSP 방식 누적계수 f: adj = raw × f, 배당일 e에서 raw[e-1] = adj[e-1]/f + D
   */
  static fromAdjusted(adjMap, divMap) {
    const e = this.sanitize(this.sortedEntries(adjMap));
    const dates = e.map(x => x[0]);
    const divAt = this.alignDivs(dates, divMap);
    const raw = new Array(e.length);
    const cleanDivs = new Map();
    let f = 1.0;
    for (let i = e.length - 1; i >= 0; i--) {
      raw[i] = e[i][1] / f;
      const D = divAt.get(i);
      if (D && i > 0) {
        const prevRaw = e[i - 1][1] / f + D;
        const y = D / prevRaw;
        if (y > 0 && y < 0.35) {
          f *= (1 - y);
          cleanDivs.set(dates[i], D);
        }
      }
    }
    return { priceMap: new Map(dates.map((d, i) => [d, raw[i]])), divMap: cleanDivs };
  }

  /** 이미 원주가인 시계열: 이상치/비현실적 배당 제거 */
  static fromRaw(rawMap, divMap) {
    const e = this.sanitize(this.sortedEntries(rawMap));
    const dates = e.map(x => x[0]);
    const divAt = this.alignDivs(dates, divMap);
    const cleanDivs = new Map();
    for (const [k, D] of divAt.entries()) {
      const y = D / e[k - 1][1];
      if (y > 0 && y < 0.35) cleanDivs.set(dates[k], D);
    }
    return { priceMap: new Map(e), divMap: cleanDivs };
  }

  static filterYears(res, startYear, endYear) {
    const inRange = (d) => {
      const y = parseInt(d.substring(0, 4), 10);
      return y >= startYear && y <= endYear;
    };
    return {
      priceMap: new Map(Array.from(res.priceMap.entries()).filter(([d]) => inRange(d))),
      divMap: new Map(Array.from(res.divMap.entries()).filter(([d]) => inRange(d))),
      source: res.source,
      divsMissing: !!res.divsMissing
    };
  }
}

/* ----------------------------------------------------------------------------
 * 시세 수집 (오프라인 DB → 로컬 API → Polygon/Finnhub → Yahoo 프록시)
 * -------------------------------------------------------------------------- */
class MarketDataFetcher {
  static _offline = new Map();
  static _polyTimes = [];
  static POLYGON_INDEX = { '^GSPC': 'I:SPX', '^NDX': 'I:NDX', '^IXIC': 'I:COMP', '^RUT': 'I:RUT', '^SOX': 'I:SOX' };

  static resolveSymbol(ticker) {
    if (!ticker) return ticker;
    if (ticker === 'KOSPI') return '^KS11';
    return TICKER_UNIVERSE[ticker]?.symbol || ticker;
  }

  static _offlineDB() {
    return (typeof EMBEDDED_OFFLINE_MARKET_DB !== 'undefined' && EMBEDDED_OFFLINE_MARKET_DB && EMBEDDED_OFFLINE_MARKET_DB.prices)
      ? EMBEDDED_OFFLINE_MARKET_DB : null;
  }

  /** 오프라인 DB 전체 시계열(원주가 역산 완료) — 메모리 캐시 */
  static getOfflineFull(ticker) {
    const sym = this.resolveSymbol(ticker);
    if (this._offline.has(sym)) return this._offline.get(sym);
    const DB = this._offlineDB();
    if (!DB) return null;
    const p = DB.prices[sym] || DB.prices[ticker];
    if (!p || Object.keys(p).length === 0) { this._offline.set(sym, null); return null; }
    const d = (DB.divs && (DB.divs[sym] || DB.divs[ticker])) || {};
    const priceType = DB.meta?.priceType || 'adjclose';
    const pm = new Map(Object.entries(p));
    const dm = new Map(Object.entries(d));
    const res = (sym === 'KRW=X' || sym.startsWith('^') || priceType === 'raw')
      ? PriceSeriesNormalizer.fromRaw(pm, dm)
      : PriceSeriesNormalizer.fromAdjusted(pm, dm);
    res.source = 'offline';
    this._offline.set(sym, res);
    return res;
  }

  static async fetchChartData(ticker, startYear, endYear, { offlineOnly = false } = {}) {
    const off = this.getOfflineFull(ticker);
    if (off) {
      const f = PriceSeriesNormalizer.filterYears(off, startYear, endYear);
      if (f.priceMap.size > 0) return f;
    }
    if (offlineOnly) return null;

    const cacheKey = `${ticker}_${startYear}_${endYear}_v16`;
    const cached = await QuantDataCache.get(cacheKey);
    if (cached) {
      return {
        priceMap: new Map(cached.priceMapEntries), divMap: new Map(cached.divMapEntries),
        source: cached.source, divsMissing: !!cached.divsMissing
      };
    }

    let res = null;
    if (typeof location !== 'undefined' && location.protocol.startsWith('http')) {
      res = await this.fetchLocalApi(ticker, startYear, endYear);
    }
    const provider = document.getElementById('apiProvider')?.value || 'yahoo_fallback';
    const polygonKey = document.getElementById('polygonApiKey')?.value?.trim();
    const finnhubKey = document.getElementById('finnhubApiKey')?.value?.trim();
    if (!res && provider === 'polygon' && polygonKey) res = await this.fetchPolygonData(ticker, startYear, endYear, polygonKey);
    if (!res && provider === 'finnhub' && finnhubKey) res = await this.fetchFinnhubData(ticker, startYear, endYear, finnhubKey);
    if (!res) res = await YahooFinanceFetcher.fetchChartData(ticker, startYear, endYear);

    if (res && res.priceMap.size > 0) {
      await QuantDataCache.set(cacheKey, {
        priceMapEntries: Array.from(res.priceMap.entries()),
        divMapEntries: Array.from(res.divMap.entries()),
        source: res.source, divsMissing: !!res.divsMissing
      });
      return res;
    }
    return null;
  }

  static async fetchLocalApi(ticker, startYear, endYear) {
    try {
      const sym = this.resolveSymbol(ticker);
      const url = `/api/chart?ticker=${encodeURIComponent(sym)}&startYear=${startYear}&endYear=${endYear}`;
      const r = await QuantUtils.fetchWithTimeout(url, { timeout: 3000 });
      if (!r.ok) return null;
      const data = await r.json();
      if (data.status !== 'ok' || !data.priceMap || Object.keys(data.priceMap).length === 0) return null;
      const pm = new Map(Object.entries(data.priceMap));
      const dm = new Map(Object.entries(data.divMap || {}));
      const res = data.priceType === 'raw' ? PriceSeriesNormalizer.fromRaw(pm, dm) : PriceSeriesNormalizer.fromAdjusted(pm, dm);
      res.source = 'local_api';
      return res;
    } catch { return null; }
  }

  static _polygonAllowed() {
    const now = Date.now();
    this._polyTimes = this._polyTimes.filter(t => now - t < 60000);
    if (this._polyTimes.length >= 5) return false; // 무료 요금제: 분당 5회
    this._polyTimes.push(now);
    return true;
  }

  static async fetchPolygonData(ticker, startYear, endYear, apiKey) {
    const raw = this.resolveSymbol(ticker);
    if (raw.endsWith('.KS') || raw === '^KS11' || raw === '^TYX') return null;
    const isFx = raw === 'KRW=X';
    const isIndex = raw.startsWith('^');
    const sym = isFx ? 'C:USDKRW' : (isIndex ? this.POLYGON_INDEX[raw] : raw);
    if (!sym) return null;
    try {
      if (!this._polygonAllowed()) return null;
      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${startYear}-01-01/${endYear}-12-31?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(apiKey)}`;
      const r = await QuantUtils.fetchWithTimeout(url, { timeout: 10000 });
      if (!r.ok) return null;
      const json = await r.json();
      if (!json.results || json.results.length === 0) return null;
      const pm = new Map();
      json.results.forEach(it => { if (it.c > 0) pm.set(new Date(it.t).toISOString().split('T')[0], it.c); });
      // adjusted=true 는 분할만 반영 → 배당은 별도 수신
      const dm = new Map();
      let divsMissing = false;
      if (!isFx && !isIndex) {
        if (this._polygonAllowed()) {
          try {
            const du = `https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(sym)}&limit=1000&order=asc&apiKey=${encodeURIComponent(apiKey)}`;
            const dr = await QuantUtils.fetchWithTimeout(du, { timeout: 10000 });
            if (dr.ok) {
              const dj = await dr.json();
              (dj.results || []).forEach(x => { if (x.ex_dividend_date && x.cash_amount > 0) dm.set(x.ex_dividend_date, (dm.get(x.ex_dividend_date) || 0) + x.cash_amount); });
            } else divsMissing = true;
          } catch { divsMissing = true; }
        } else divsMissing = true;
      }
      const res = PriceSeriesNormalizer.fromRaw(pm, dm);
      res.source = 'polygon';
      res.divsMissing = divsMissing;
      return res;
    } catch (e) {
      console.warn(`[Polygon] ${ticker} 실패 → 다음 소스로 전환`, e);
      return null;
    }
  }

  static async fetchFinnhubData(ticker, startYear, endYear, apiKey) {
    const sym = this.resolveSymbol(ticker);
    if (sym.startsWith('^') || sym.endsWith('.KS') || sym === 'KRW=X') return null;
    try {
      const from = Math.floor(Date.UTC(startYear, 0, 1) / 1000);
      const to = Math.floor(Date.UTC(endYear, 11, 31, 23, 59) / 1000);
      const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`;
      const r = await QuantUtils.fetchWithTimeout(url, { timeout: 10000 });
      if (!r.ok) return null;
      const json = await r.json();
      if (json.s !== 'ok' || !json.c) return null;
      const pm = new Map();
      json.t.forEach((ts, i) => { if (json.c[i] > 0) pm.set(new Date(ts * 1000).toISOString().split('T')[0], json.c[i]); });
      const dm = new Map();
      let divsMissing = false;
      try {
        const du = `https://finnhub.io/api/v1/stock/dividend?symbol=${encodeURIComponent(sym)}&from=${startYear}-01-01&to=${endYear}-12-31&token=${encodeURIComponent(apiKey)}`;
        const dr = await QuantUtils.fetchWithTimeout(du, { timeout: 8000 });
        if (dr.ok) {
          const dj = await dr.json();
          if (Array.isArray(dj)) dj.forEach(x => { if (x.date && x.amount > 0) dm.set(x.date, (dm.get(x.date) || 0) + x.amount); });
          else divsMissing = true;
        } else divsMissing = true;
      } catch { divsMissing = true; }
      const res = PriceSeriesNormalizer.fromRaw(pm, dm);
      res.source = 'finnhub';
      res.divsMissing = divsMissing;
      return res;
    } catch (e) {
      console.warn(`[Finnhub] ${ticker} 실패 → 다음 소스로 전환`, e);
      return null;
    }
  }
}

class YahooFinanceFetcher {
  static _parse(json) {
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('empty');
    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
    const pm = new Map(), am = new Map(), dm = new Map();
    ts.forEach((t, i) => {
      const d = new Date(t * 1000).toISOString().split('T')[0];
      if (closes[i] > 0) pm.set(d, closes[i]);
      if (adj[i] > 0) am.set(d, adj[i]);
    });
    Object.values(result.events?.dividends || {}).forEach(div => {
      if (div.amount > 0 && div.date) {
        const d = new Date(div.date * 1000).toISOString().split('T')[0];
        dm.set(d, (dm.get(d) || 0) + div.amount);
      }
    });
    // close = 분할만 반영된 원주가. close 가 없으면 adjclose 로부터 역산
    let res;
    if (pm.size > 10) res = PriceSeriesNormalizer.fromRaw(pm, dm);
    else if (am.size > 10) res = PriceSeriesNormalizer.fromAdjusted(am, dm);
    else throw new Error('insufficient');
    if (res.priceMap.size < 10) throw new Error('insufficient');
    res.source = 'yahoo';
    return res;
  }

  static async fetchChartData(ticker, startYear, endYear) {
    const sym = MarketDataFetcher.resolveSymbol(ticker);
    const p1 = Math.floor(Date.UTC(startYear, 0, 1) / 1000);
    const p2 = Math.floor(Date.UTC(endYear, 11, 31, 23, 59) / 1000);
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit`;
    const urls = [
      `${GLOBAL_QUANT_CONFIG.CORS_WORKER_PROXY}${encodeURIComponent(yahooUrl)}`,
      `https://corsproxy.io/?${encodeURIComponent(yahooUrl)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(yahooUrl)}`,
      yahooUrl
    ];
    const attempt = async (u) => {
      const r = await QuantUtils.fetchWithTimeout(u, { timeout: 7000 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return this._parse(await r.json());
    };
    try {
      if (typeof Promise.any === 'function') return await Promise.any(urls.map(attempt));
      for (const u of urls) { try { return await attempt(u); } catch { /* next */ } }
    } catch { /* all failed */ }
    console.warn(`[Yahoo] ${ticker}: 모든 프록시 수신 실패`);
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * 데이터 파이프라인 / 달력
 * -------------------------------------------------------------------------- */
class DataPipeline {
  static expandRequired(keys) {
    const set = new Set();
    const add = (k) => {
      if (!k || set.has(k)) return;
      set.add(k);
      const c = TICKER_UNIVERSE[k];
      if (c) { if (c.base) add(c.base); if (c.altBase) add(c.altBase); }
    };
    keys.forEach(add);
    return Array.from(set);
  }

  static async load(keys, startYear, endYear, { offlineOnly = false, onProgress = null } = {}) {
    const all = this.expandRequired(keys);
    const raw = {};
    const failed = [];
    let done = 0;
    const queue = all.slice();
    const worker = async () => {
      while (queue.length) {
        const k = queue.shift();
        try {
          const r = await MarketDataFetcher.fetchChartData(k, startYear, endYear, { offlineOnly });
          if (r && r.priceMap.size > 0) raw[k] = r; else failed.push(k);
        } catch { failed.push(k); }
        done++;
        if (onProgress) onProgress(done / (all.length + 1));
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, all.length || 1) }, worker));
    const fx = await MarketDataFetcher.fetchChartData('KRW=X', startYear, endYear, { offlineOnly });
    if (onProgress) onProgress(1);
    return { raw, fx, failed, keys: all };
  }
}

class CalendarBuilder {
  /** 전략 자산 중 미국 자산이 있으면 미국 거래일, 전부 국내면 한국 거래일 달력 */
  static build(raw, strategyAssets, startBound) {
    const useUS = strategyAssets.length === 0 || strategyAssets.some(a => !QuantUtils.isDomestic(a));
    const set = new Set();
    for (const [k, ds] of Object.entries(raw)) {
      if (QuantUtils.isDomestic(k) === useUS) continue;
      ds.priceMap.forEach((v, d) => { if (d >= startBound) set.add(d); });
    }
    if (set.size === 0) {
      for (const ds of Object.values(raw)) ds.priceMap.forEach((v, d) => { if (d >= startBound) set.add(d); });
    }
    return { dates: Array.from(set).sort(), calendar: useUS ? 'US' : 'KR' };
  }
}

/* ----------------------------------------------------------------------------
 * 수치 해석 (OLS / HAC)
 * -------------------------------------------------------------------------- */
class QROLSMatrixSolver {
  static solve(X, Y) {
    const m = X.length;
    if (m === 0) return null;
    const n = X[0].length;
    const R = X.map(row => Array.from(row));
    const b = Array.from(Y);
    for (let k = 0; k < n; k++) {
      let norm = 0;
      for (let i = k; i < m; i++) norm += R[i][k] * R[i][k];
      norm = Math.sqrt(norm);
      if (norm === 0) continue;
      const alpha = R[k][k] >= 0 ? -norm : norm;
      const u1 = R[k][k] - alpha;
      const v = new Float64Array(m - k);
      v[0] = 1;
      let vv = 1;
      for (let i = k + 1; i < m; i++) { v[i - k] = R[i][k] / u1; vv += v[i - k] * v[i - k]; }
      const tau = 2 / Math.max(1e-12, vv);
      for (let j = k; j < n; j++) {
        let dot = 0;
        for (let i = k; i < m; i++) dot += v[i - k] * R[i][j];
        for (let i = k; i < m; i++) R[i][j] -= tau * v[i - k] * dot;
      }
      let dotB = 0;
      for (let i = k; i < m; i++) dotB += v[i - k] * b[i];
      for (let i = k; i < m; i++) b[i] -= tau * v[i - k] * dotB;
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let sum = b[i];
      for (let j = i + 1; j < n; j++) sum -= R[i][j] * x[j];
      const d = R[i][i] + (R[i][i] >= 0 ? 1e-10 : -1e-10);
      x[i] = sum / d;
    }
    return x;
  }
}

class MatrixMath {
  static multiply(A, B) {
    const m = A.length, n = A[0].length, p = B[0].length;
    const C = Array.from({ length: m }, () => new Float64Array(p));
    for (let i = 0; i < m; i++) for (let k = 0; k < n; k++) {
      const a = A[i][k];
      if (a !== 0) for (let j = 0; j < p; j++) C[i][j] += a * B[k][j];
    }
    return C;
  }

  static invertSymmetric(A) {
    const n = A.length;
    const L = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < j; k++) s += L[i][k] * L[j][k];
      if (i === j) {
        const v = A[i][i] - s;
        if (v <= 1e-18) return null;
        L[i][j] = Math.sqrt(v);
      } else L[i][j] = (A[i][j] - s) / L[j][j];
    }
    const invL = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      invL[i][i] = 1 / L[i][i];
      for (let j = i + 1; j < n; j++) {
        let s = 0;
        for (let k = i; k < j; k++) s -= L[j][k] * invL[k][i];
        invL[j][i] = s / L[j][j];
      }
    }
    const inv = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
      let s = 0;
      for (let k = j; k < n; k++) s += invL[k][i] * invL[k][j];
      inv[i][j] = s; inv[j][i] = s;
    }
    return inv;
  }
}

class NeweyWestHACEngine {
  static compute(X, e) {
    const T = X.length, K = X[0].length;
    if (T <= K) return null;
    const L = Math.max(1, Math.floor(4 * Math.pow(T / 100, 2 / 9)));
    const XtX = Array.from({ length: K }, () => new Float64Array(K));
    for (let t = 0; t < T; t++) for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) XtX[i][j] += X[t][i] * X[t][j];
    const inv = MatrixMath.invertSymmetric(XtX);
    if (!inv) return null;
    const S = Array.from({ length: K }, () => new Float64Array(K));
    for (let t = 0; t < T; t++) for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) S[i][j] += (e[t] * X[t][i]) * (e[t] * X[t][j]);
    for (let l = 1; l <= L; l++) {
      const w = 1 - l / (L + 1);
      for (let t = l; t < T; t++) for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
        const g = (e[t] * X[t][i]) * (e[t - l] * X[t - l][j]);
        const g2 = (e[t] * X[t][j]) * (e[t - l] * X[t - l][i]);
        S[i][j] += w * (g + g2);
      }
    }
    const V = MatrixMath.multiply(MatrixMath.multiply(inv, S), inv);
    const se = new Float64Array(K);
    for (let k = 0; k < K; k++) se[k] = Math.sqrt(Math.max(1e-18, V[k][k]));
    return { se, maxLag: L };
  }
}

/* ----------------------------------------------------------------------------
 * 백필 합성 엔진 — 원주가/배당 배열 생성 + 상장 이전 구간 합성
 *  · 실제 데이터가 없으면 절대 합성하지 않음(기록만)
 *  · 기초자산 의존관계 순서(위상 정렬)로 처리
 *  · 기초자산 결측 시 즉시 중단(평평한 가격 채우기 금지)
 * -------------------------------------------------------------------------- */
class MultiFactorSynthesisEngine {
  static process(raw, dates) {
    const N = dates.length;
    const prices = {}, divs = {}, firstReal = {}, synthInfo = {}, firstValid = {};
    const months = dates.map(d => QuantUtils.monthOf(d));
    const isMonthEnd = (i) => (i === N - 1) ? parseInt(dates[i].substring(8, 10), 10) >= 25 : months[i + 1] !== months[i];
    const isQuarterEnd = (i) => (months[i] % 3 === 0) && isMonthEnd(i);
    const rfArr = new Float64Array(N);
    for (let i = 0; i < N; i++) rfArr[i] = HistoricalInterestRates.rfDaily(dates[i]);

    // 1) 원시 배열 구성 (전일값 이월, 데이터 시작 전 0)
    for (const [key, ds] of Object.entries(raw)) {
      const P = new Float64Array(N), D = new Float64Array(N);
      const entries = Array.from(ds.priceMap.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      let j = 0, last = 0, fr = -1;
      for (let i = 0; i < N; i++) {
        while (j < entries.length && entries[j][0] <= dates[i]) { last = entries[j][1]; j++; }
        P[i] = last;
        if (fr < 0 && last > 0) fr = i;
      }
      for (const [d, a] of ds.divMap.entries()) {
        const k = QuantUtils.lowerBound(dates, d);
        if (k > 0 && k < N && QuantUtils.daysBetween(d, dates[k]) <= 10 && P[k - 1] > 0) D[k] += a;
      }
      prices[key] = P; divs[key] = D; firstReal[key] = fr;
    }

    // 2) 가격지수에 추정 분배금(분기말) 부여 → 총수익 기준 기초자산
    for (const key of Object.keys(prices)) {
      const yf = INDEX_DIVIDEND_YIELD[MarketDataFetcher.resolveSymbol(key)];
      if (!yf) continue;
      const P = prices[key], D = divs[key];
      for (let i = 1; i < N; i++) {
        if (P[i - 1] > 0 && isQuarterEnd(i)) D[i] += P[i - 1] * yf(parseInt(dates[i].substring(0, 4), 10)) / 4;
      }
    }

    // 3) 위상 정렬 순서로 백필
    const done = new Set();
    const visit = (k) => {
      if (done.has(k)) return;
      done.add(k);
      const c = TICKER_UNIVERSE[k];
      if (c?.base && prices[c.base]) visit(c.base);
      if (c?.altBase && prices[c.altBase]) visit(c.altBase);
      this._synthesize(k, { prices, divs, firstReal, synthInfo, dates, N, rfArr, isMonthEnd, isQuarterEnd });
    };
    Object.keys(prices).forEach(visit);

    for (const k of Object.keys(prices)) {
      const P = prices[k];
      let fv = -1;
      for (let i = 0; i < N; i++) if (P[i] > 0) { fv = i; break; }
      firstValid[k] = fv;
    }
    return { prices, divs, firstReal, firstValid, synthInfo };
  }

  static _baseStep(ctx, bk, i) {
    const P = ctx.prices[bk], D = ctx.divs[bk];
    if (!P || !(P[i] > 0 && P[i + 1] > 0)) return null;
    return { tr: (P[i + 1] + D[i + 1]) / P[i] - 1, q: D[i + 1] / P[i] };
  }

  /** 뒤로 한 걸음씩: (P[i+1] + D[i+1]) / P[i] = 1 + r, 합성 분배금 D[i+1] = q × P[i] */
  static _backfill(P, D, real, minIdx, stepFn) {
    let i;
    for (i = real - 1; i >= minIdx; i--) {
      const st = stepFn(i);
      if (!st || !isFinite(st.r)) break;
      const boundary = (i + 1 === real);
      const denom = 1 + st.r - (boundary ? 0 : st.q);
      if (!(denom > 1e-6)) break;
      P[i] = (P[i + 1] + (boundary ? D[i + 1] : 0)) / denom;
      if (!boundary) D[i + 1] = st.q > 0 ? st.q * P[i] : 0;
    }
    return i + 1; // 합성 시작 인덱스
  }

  static _synthesize(k, ctx) {
    const cfg = TICKER_UNIVERSE[k];
    if (!cfg) return;
    const { prices, divs, firstReal, synthInfo, dates, N, rfArr } = ctx;
    const P = prices[k], D = divs[k];

    if (cfg.proxyType === 'index_direct') {
      // 인덱스펀드 근사: 보수를 가격·분배금에 동일 비율로 누적 차감
      let f = 1;
      const dailyFee = cfg.fee / GLOBAL_QUANT_CONFIG.TRADING_DAYS;
      for (let i = 0; i < N; i++) { P[i] *= f; D[i] *= f; f *= (1 - dailyFee); }
      return;
    }
    if (!cfg.allowBackfill) return;
    const real = firstReal[k];
    if (real <= 0) return; // 데이터 없음(-1) 또는 합성 불필요(0)
    const minIdx = QuantUtils.lowerBound(dates, (cfg.backfillMinDate || '1985-01') + '-01');
    if (minIdx >= real) return;
    const TD = GLOBAL_QUANT_CONFIG.TRADING_DAYS;
    let from = real, info = null;

    if (cfg.proxyType === 'index_tracking') {
      const usedBases = new Set();
      from = this._backfill(P, D, real, minIdx, (i) => {
        let bk = cfg.base, b = this._baseStep(ctx, cfg.base, i);
        if (!b && cfg.altBase) { bk = cfg.altBase; b = this._baseStep(ctx, cfg.altBase, i); }
        if (!b) return null;
        usedBases.add(bk);
        const feeDiff = (cfg.fee - (TICKER_UNIVERSE[bk]?.fee || 0)) / TD;
        return { r: b.tr - feeDiff, q: b.q };
      });
      info = { method: 'index_tracking', label: `기초지수 총수익 추종 (${Array.from(usedBases).join(', ') || cfg.base}) − 보수 차이` };
    } else if (cfg.proxyType === 'leveraged') {
      const lev = cfg.leverage;
      const baseFee = TICKER_UNIVERSE[cfg.base]?.fee || 0;
      from = this._backfill(P, D, real, minIdx, (i) => {
        const b = this._baseStep(ctx, cfg.base, i);
        if (!b) return null;
        const rfD = rfArr[i + 1];
        const fin = lev > 0
          ? (lev - 1) * (rfD + cfg.swapSpread / TD)
          : -((Math.abs(lev) + 1) * rfD - Math.abs(lev) * 0.015 / TD);
        const netExp = (cfg.fee - lev * baseFee + cfg.trackingError) / TD;
        return { r: Math.max(-0.999, lev * b.tr - fin - netExp), q: 0 };
      });
      info = { method: 'leveraged', label: `${cfg.base} 일간 총수익 × ${lev}배 − 조달비용(T-Bill+스프레드) − 보수` };
    } else if (cfg.proxyType === 'bond_duration') {
      const Y = prices[cfg.base];
      if (!Y) return;
      const C = 330;
      // 실제 TLT 구간으로 듀레이션 보정
      let sxx = 0, sxy = 0, n = 0, sse = 0, sst = 0, sy = 0;
      const obs = [];
      for (let i = real; i < N - 1; i++) {
        if (!(P[i] > 0 && P[i + 1] > 0 && Y[i] > 0 && Y[i + 1] > 0)) continue;
        const dy = (Y[i + 1] - Y[i]) / 100;
        const tr = (P[i + 1] + D[i + 1]) / P[i] - 1;
        const yv = tr - Y[i] / 100 / TD + cfg.fee / TD - 0.5 * C * dy * dy;
        obs.push([-dy, yv]);
        sxx += dy * dy; sxy += -dy * yv; n++; sy += yv;
      }
      let dur = 15.8;
      if (n >= 250 && sxx > 0) dur = Math.min(25, Math.max(8, sxy / sxx));
      const my = n ? sy / n : 0;
      obs.forEach(([x, y]) => { sse += (y - dur * x) ** 2; sst += (y - my) ** 2; });
      from = this._backfill(P, D, real, minIdx, (i) => {
        if (!(Y[i] > 0 && Y[i + 1] > 0)) return null;
        const dy = (Y[i + 1] - Y[i]) / 100;
        const y = Y[i] / 100;
        return { r: -dur * dy + 0.5 * C * dy * dy + y / TD - cfg.fee / TD, q: ctx.isMonthEnd(i + 1) ? y / 12 : 0 };
      });
      info = { method: 'bond_duration', label: `30년물 금리(^TYX) 듀레이션 모델 (D=${dur.toFixed(1)}, 볼록성 ${C}, 이표 월분배)`, duration: dur, r2: sst > 0 ? 1 - sse / sst : 0, n };
    } else if (cfg.proxyType === 'factor') {
      if (!FactorData.available()) return;
      const model = FACTOR_MODELS[cfg.factorModel];
      if (!model) return;
      // 실제 구간 회귀 보정
      const X = [], Yv = [];
      for (let i = real; i < N - 1; i++) {
        if (!(P[i] > 0 && P[i + 1] > 0)) continue;
        const row = FactorData.row(dates[i + 1]);
        if (!row || row.rf === null) continue;
        const xs = model.x.map(f => f(row));
        if (xs.some(v => !isFinite(v))) continue;
        X.push([1, ...xs]);
        Yv.push((P[i + 1] + D[i + 1]) / P[i] - 1 - row.rf);
      }
      let betas = model.defaults.slice(), r2 = null, alphaAnn = null, residuals = null;
      const n = X.length;
      if (n >= 250) {
        const beta = QROLSMatrixSolver.solve(X, Yv);
        if (beta && Array.from(beta).every(isFinite)) {
          betas = Array.from(beta).slice(1);
          alphaAnn = beta[0] * TD;
          residuals = new Float64Array(n);
          let my = 0; Yv.forEach(v => { my += v; }); my /= n;
          let sse = 0, sst = 0;
          for (let t = 0; t < n; t++) {
            let fit = beta[0];
            for (let j = 1; j < X[t].length; j++) fit += beta[j] * X[t][j];
            residuals[t] = Yv[t] - fit;
            sse += residuals[t] ** 2; sst += (Yv[t] - my) ** 2;
          }
          r2 = sst > 0 ? 1 - sse / sst : 0;
        }
      }
      // 실현 분배수익률 → 분기 합성 분배금
      let ySum = 0;
      for (let i = real + 1; i < N; i++) if (D[i] > 0 && P[i - 1] > 0) ySum += D[i] / P[i - 1];
      const yrs = Math.max(0.5, QuantUtils.daysBetween(dates[real], dates[N - 1]) / 365.25);
      const yieldAnn = Math.min(0.08, ySum / yrs);
      // 잔차 블록 부트스트랩(시드 고정) — 합성 구간의 변동성 과소추정 방지, 알파는 제외(보수적)
      const rng = QuantUtils.mulberry32(QuantUtils.hashString('factor-residual:' + k));
      const BLOCK = 10;
      let bPos = 0, bLeft = 0;
      const drawResidual = () => {
        if (!residuals || residuals.length === 0) return 0;
        if (bLeft <= 0) { bPos = Math.floor(rng() * residuals.length); bLeft = BLOCK; }
        const v = residuals[bPos % residuals.length];
        bPos++; bLeft--;
        return v;
      };
      from = this._backfill(P, D, real, minIdx, (i) => {
        const row = FactorData.row(dates[i + 1]);
        if (!row || row.rf === null) return null;
        const xs = model.x.map(f => f(row));
        if (xs.some(v => !isFinite(v))) return null;
        let r = row.rf - cfg.fee / TD + drawResidual();
        for (let j = 0; j < xs.length; j++) r += betas[j] * xs[j];
        return { r, q: ctx.isQuarterEnd(i + 1) ? yieldAnn / 4 : 0 };
      });
      info = {
        method: 'factor', label: model.label, factorNames: model.names, betas, r2, alphaAnnExcluded: alphaAnn,
        n, calibrated: n >= 250 && r2 !== null, yieldAnn, residualBootstrap: !!residuals
      };
    }
    if (info && from < real) {
      info.fromIdx = from; info.realIdx = real;
      info.from = dates[from]; info.to = dates[real];
      synthInfo[k] = info;
    }
  }
}

class DataAvailability {
  /** 시작 인덱스 s 시점에 데이터가 없는 자산 목록 */
  static check(keys, processed, dates, s) {
    const out = [];
    keys.forEach(k => {
      const fv = processed.firstValid[k];
      if (fv === undefined || fv < 0) { out.push({ ticker: k, reason: '시세 데이터를 불러오지 못했습니다' }); return; }
      if (fv > s && QuantUtils.daysBetween(dates[s], dates[fv]) > GLOBAL_QUANT_CONFIG.AVAIL_TOLERANCE_DAYS) {
        out.push({ ticker: k, reason: `데이터(합성 포함)가 ${dates[fv]}부터 존재`, firstDate: dates[fv] });
      }
    });
    return out;
  }
}

/* ----------------------------------------------------------------------------
 * FIFO 세무 로트 (한국 해외주식 양도세: 선입선출, 원화 환산 손익)
 * -------------------------------------------------------------------------- */
class FIFOTaxLotManager {
  constructor() { this.lots = []; this.head = 0; }

  buy(shares, costPerShareKrw) {
    if (shares > 0 && isFinite(costPerShareKrw)) this.lots.push({ shares, cost: costPerShareKrw });
  }

  /** FIFO 매도 → 실현손익(원) */
  sell(shares, proceedsPerShareKrw) {
    let rem = shares, realized = 0;
    while (rem > 1e-12 && this.head < this.lots.length) {
      const lot = this.lots[this.head];
      const q = Math.min(lot.shares, rem);
      realized += q * (proceedsPerShareKrw - lot.cost);
      lot.shares -= q; rem -= q;
      if (lot.shares <= 1e-12) this.head++;
    }
    if (this.head > 256 && this.head > this.lots.length / 2) { this.lots = this.lots.slice(this.head); this.head = 0; }
    return realized;
  }

  /** 목표 실현이익에 도달하기 위한 FIFO 매도 수량 계획 */
  planHarvest(targetGain, proceedsPerShareKrw) {
    let cum = 0, sh = 0;
    for (let k = this.head; k < this.lots.length; k++) {
      const lot = this.lots[k];
      const g = proceedsPerShareKrw - lot.cost;
      const lotGain = lot.shares * g;
      if (g > 0 && cum + lotGain > targetGain) { sh += (targetGain - cum) / g; cum = targetGain; break; }
      cum += lotGain; sh += lot.shares;
      if (cum >= targetGain) break;
    }
    return { shares: sh, gain: cum };
  }

  unrealized(proceedsPerShareKrw) {
    let u = 0;
    for (let k = this.head; k < this.lots.length; k++) u += this.lots[k].shares * (proceedsPerShareKrw - this.lots[k].cost);
    return u;
  }
}

/* ----------------------------------------------------------------------------
 * XIRR (Newton + 이분법)
 * -------------------------------------------------------------------------- */
class XIRRSolver {
  static compute(flows, flowDates, finalVal, finalDate) {
    const cf = [], dd = [];
    flows.forEach((v, i) => { if (v > 0) { cf.push(v); dd.push(flowDates[i]); } });
    if (cf.length === 0 || !(finalVal > GLOBAL_QUANT_CONFIG.EPS)) return cf.length ? -100 : 0;
    const t0 = QuantUtils.parseDateUTC(dd[0]);
    const tk = dd.map(d => (QuantUtils.parseDateUTC(d) - t0) / 86400000 / 365);
    const T = (QuantUtils.parseDateUTC(finalDate) - t0) / 86400000 / 365;
    if (T <= 0) return 0;
    const f = (r) => {
      if (r <= -0.999) return 1e12;
      let v = -finalVal / Math.pow(1 + r, T);
      for (let k = 0; k < cf.length; k++) v += cf[k] / Math.pow(1 + r, tk[k]);
      return isNaN(v) ? 1e12 : v;
    };
    const df = (r) => {
      let v = T * finalVal / Math.pow(1 + r, T + 1);
      for (let k = 0; k < cf.length; k++) v -= tk[k] * cf[k] / Math.pow(1 + r, tk[k] + 1);
      return v;
    };
    let r = 0.1;
    for (let it = 0; it < 50; it++) {
      const y = f(r), dy = df(r);
      if (!isFinite(dy) || Math.abs(dy) < 1e-12) break;
      const nx = r - y / dy;
      if (Math.abs(nx - r) < 1e-8) return nx * 100;
      r = nx < -0.95 ? -0.5 : Math.min(nx, 20);
    }
    let lo = -0.99, hi = 3, flo = f(lo), fhi = f(hi), ex = 0;
    while (flo * fhi > 0 && ex < 12) { hi *= 2; fhi = f(hi); ex++; }
    if (flo * fhi > 0) return 0;
    for (let it = 0; it < 200; it++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (Math.abs(fm) < 1e-6 || hi - lo < 1e-9) return mid * 100;
      if (flo * fm < 0) { hi = mid; } else { lo = mid; flo = fm; }
    }
    return ((lo + hi) / 2) * 100;
  }
}

/* ----------------------------------------------------------------------------
 * 포트폴리오 시뮬레이터 — 개별 자산(100%)과 믹스를 동일 엔진으로 처리
 *  · 원주가 + 배당 재투자(원천징수 차감), 통화별 현금(KRW/USD)
 *  · 환전은 필요한 순금액만(스프레드), 매매수수료, 국내주식 거래세
 *  · 해외자산 양도세: FIFO 로트, 연말 절세(250만 공제 한도 내 실현 후 재매수), 초과분 22% 과세
 *  · TWR은 거래비용/세금까지 반영(외부 입금만 제외)
 * -------------------------------------------------------------------------- */
class PortfolioSimulator {
  static shouldRebalance(freq, dateStr) {
    const m = QuantUtils.monthOf(dateStr);
    switch (freq) {
      case 'monthly': return true;
      case 'quarterly': return m === 1 || m === 4 || m === 7 || m === 10;
      case 'semiannual': return m === 1 || m === 7;
      case 'yearly': return m === 1;
      default: return false;
    }
  }

  static monthlyDeposit(ic, monthCounter, drawdown) {
    if (ic.mode === 'lumpSum') return monthCounter === 1 ? ic.lumpSumKrw : 0;
    if (ic.mode === 'dynamicDCA') {
      if (drawdown <= -ic.smartDrop2) return ic.monthlyKrw * ic.smartMult2;
      if (drawdown <= -ic.smartDrop1) return ic.monthlyKrw * ic.smartMult1;
      return ic.monthlyKrw;
    }
    return ic.monthlyKrw;
  }

  static run(spec, ctx, config, s = ctx.s, e = ctx.e) {
    const C = GLOBAL_QUANT_CONFIG;
    const keys = Object.keys(spec.allocations).filter(k => spec.allocations[k] > 0 && ctx.prices[k]);
    const n = keys.length;
    let wSum = 0;
    keys.forEach(k => { wSum += spec.allocations[k]; });
    const W = keys.map(k => spec.allocations[k] / wSum);
    const P = keys.map(k => ctx.prices[k]);
    const Dv = keys.map(k => ctx.divs[k]);
    const isUS = keys.map(k => !QuantUtils.isDomestic(k));
    const isKrSt = keys.map(k => QuantUtils.isKrStock(k));
    const divTax = keys.map(k => config.taxEnabled ? (QuantUtils.isDomestic(k) ? C.KR_DIV_TAX : C.US_DIV_WITHHOLDING) : 0);
    const fee = config.brokerFee, spread = config.fxSpread;
    const shares = new Float64Array(n);
    const lots = keys.map(() => new FIFOTaxLotManager());
    const len = e - s + 1;
    const values = new Float64Array(len), invested = new Float64Array(len), twr = new Float64Array(len);
    const flows = [], flowDates = [];
    let cashKRW = 0, cashUSD = 0, investedKrw = 0, postPrev = 0, peakTwr = 1, monthCounter = 0;
    let yearRealized = 0, taxesPaid = 0, feesPaid = 0, divNetKrw = 0, divTaxKrw = 0;
    let fxi = 1;

    const fxA = (a) => (isUS[a] ? fxi : 1);
    const valueNow = (i) => {
      let v = cashKRW + cashUSD * fxi;
      for (let a = 0; a < n; a++) if (shares[a] > 0) v += shares[a] * P[a][i] * fxA(a);
      return v;
    };

    // KRW↔USD 순환전 후 목표 매수 체결
    const executeBuys = (i, needN) => {
      let costUSD = 0, costKRW = 0;
      for (let a = 0; a < n; a++) if (needN[a] > 0) { if (isUS[a]) costUSD += needN[a] * (1 + fee); else costKRW += needN[a] * (1 + fee); }
      if (costUSD > cashUSD + 1e-9) {
        const availKRW = Math.max(0, cashKRW - costKRW);
        const conv = Math.min(costUSD - cashUSD, availKRW / (fxi * (1 + spread)));
        if (conv > 0) { cashKRW -= conv * fxi * (1 + spread); cashUSD += conv; feesPaid += conv * fxi * spread; }
      } else if (costKRW > cashKRW + 1e-9) {
        const availUSD = Math.max(0, cashUSD - costUSD);
        const convKrw = Math.min(costKRW - cashKRW, availUSD * fxi * (1 - spread));
        if (convKrw > 0) { cashUSD -= convKrw / (fxi * (1 - spread)); cashKRW += convKrw; feesPaid += convKrw / (1 - spread) * spread; }
      }
      const sU = costUSD > 0 ? Math.min(1, cashUSD / costUSD) : 0;
      const sK = costKRW > 0 ? Math.min(1, cashKRW / costKRW) : 0;
      for (let a = 0; a < n; a++) {
        if (!(needN[a] > 0)) continue;
        const p = P[a][i];
        const amt = needN[a] * (isUS[a] ? sU : sK);
        if (!(amt > 0) || !(p > 0)) continue;
        const sh = amt / p;
        shares[a] += sh;
        lots[a].buy(sh, p * (1 + fee) * fxA(a));
        feesPaid += amt * fee * fxA(a);
        if (isUS[a]) cashUSD -= amt * (1 + fee); else cashKRW -= amt * (1 + fee);
      }
      if (cashUSD < 0 && cashUSD > -1e-6) cashUSD = 0;
      if (cashKRW < 0 && cashKRW > -1e-3) cashKRW = 0;
    };

    const sellShares = (a, i, sh) => {
      const p = P[a][i];
      const gross = sh * p;
      const proceeds = gross * (1 - fee) - (isKrSt[a] ? gross * C.KR_STOCK_SELL_TAX : 0);
      feesPaid += (gross - proceeds) * fxA(a);
      shares[a] -= sh;
      if (shares[a] < 1e-12) shares[a] = 0;
      const realized = lots[a].sell(sh, (proceeds / sh) * fxA(a));
      if (isUS[a]) { cashUSD += proceeds; return realized; }
      cashKRW += proceeds;
      return 0; // 국내주식 소액주주 양도세 비과세
    };

    const trade = (i, mode) => {
      const act = [];
      let wAct = 0;
      for (let a = 0; a < n; a++) if (P[a][i] > 0) { act.push(a); wAct += W[a]; }
      if (act.length === 0 || wAct <= 0) return;
      const total = valueNow(i);
      const cashTotal = cashKRW + cashUSD * fxi;
      const needN = new Float64Array(n);
      if (mode === 'rebalance') {
        for (const a of act) {
          const tgtN = total * (W[a] / wAct) / fxA(a);
          const curN = shares[a] * P[a][i];
          const diff = tgtN - curN;
          if (diff < -total * 0.0005 / fxA(a)) yearRealized += sellShares(a, i, -diff / P[a][i]);
          else if (diff > 0) needN[a] = diff;
        }
      } else {
        for (const a of act) needN[a] = cashTotal * (W[a] / wAct) / fxA(a) / (1 + fee);
      }
      executeBuys(i, needN);
    };

    const yearEndTax = (i) => {
      let carry = 0;
      // 1) 절세 매도-재매수 (공제 한도 내 이익 실현, 미국자산은 달러로 재매수 → 환전 없음)
      for (let a = 0; a < n; a++) {
        if (!isUS[a] || shares[a] <= 0) continue;
        const remaining = C.TAX_ALLOWANCE_KRW - yearRealized;
        if (remaining <= 1000) break;
        const p = P[a][i];
        if (!(p > 0)) continue;
        const proceedsPerShareKrw = p * (1 - fee) * fxi;
        const plan = lots[a].planHarvest(remaining, proceedsPerShareKrw);
        const sh = Math.min(plan.shares, shares[a]);
        if (!(sh > 0) || plan.gain <= 0) continue;
        const cost = 2 * fee * sh * p * fxi;
        if (plan.gain * C.TAX_RATE <= cost) continue;
        yearRealized += lots[a].sell(sh, proceedsPerShareKrw);
        const proceedsUSD = sh * p * (1 - fee);
        const newSh = proceedsUSD / (p * (1 + fee));
        shares[a] += newSh - sh;
        lots[a].buy(newSh, p * (1 + fee) * fxi);
        feesPaid += (sh * p * fee + newSh * p * fee) * fxi;
      }
      // 2) 공제 초과분 과세 (현금 → 부족 시 비례 매도; 매도 손익은 다음 해로 이월)
      if (yearRealized > C.TAX_ALLOWANCE_KRW) {
        let tax = (yearRealized - C.TAX_ALLOWANCE_KRW) * C.TAX_RATE;
        taxesPaid += tax;
        const fromKrw = Math.min(cashKRW, tax);
        cashKRW -= fromKrw; tax -= fromKrw;
        if (tax > 0 && cashUSD > 0) {
          const usd = Math.min(cashUSD, tax / (fxi * (1 - spread)));
          cashUSD -= usd; tax -= usd * fxi * (1 - spread); feesPaid += usd * fxi * spread;
        }
        if (tax > 1e-6) {
          let invVal = 0;
          for (let a = 0; a < n; a++) invVal += shares[a] * P[a][i] * fxA(a);
          if (invVal > 0) {
            const frac = Math.min(1, tax * 1.01 / invVal);
            for (let a = 0; a < n; a++) {
              if (shares[a] <= 0) continue;
              carry += sellShares(a, i, shares[a] * frac);
            }
            const fromK = Math.min(cashKRW, tax); cashKRW -= fromK; tax -= fromK;
            if (tax > 0 && cashUSD > 0) {
              const usd = Math.min(cashUSD, tax / (fxi * (1 - spread)));
              cashUSD -= usd; feesPaid += usd * fxi * spread;
            }
          }
        }
      }
      yearRealized = carry;
    };

    for (let i = s; i <= e; i++) {
      const t = i - s;
      fxi = ctx.fx[i];
      // 1) 배당: 원천징수 후 동일 통화로 재투자
      for (let a = 0; a < n; a++) {
        const D = Dv[a][i];
        const p = P[a][i];
        if (D > 0 && shares[a] > 0 && p > 0) {
          const gross = shares[a] * D;
          const tax = gross * divTax[a];
          const net = gross - tax;
          divTaxKrw += tax * fxA(a);
          divNetKrw += net * fxA(a);
          const sh = net / (p * (1 + fee));
          shares[a] += sh;
          lots[a].buy(sh, p * (1 + fee) * fxA(a));
          feesPaid += sh * p * fee * fxA(a);
        }
      }
      // 2) 입금 전 평가 → TWR
      const pre = valueNow(i);
      twr[t] = t === 0 ? 1 : (postPrev > 0 ? twr[t - 1] * (pre / postPrev) : twr[t - 1]);
      // 3) 월 첫 거래일: 입금 + 매수/리밸런싱
      let dep = 0;
      if (t === 0 || ctx.isNewMonth[i]) {
        monthCounter++;
        const dd = peakTwr > 0 ? twr[t] / peakTwr - 1 : 0;
        dep = this.monthlyDeposit(config.investConfig, monthCounter, dd);
        investedKrw += dep;
        flows.push(dep); flowDates.push(ctx.dates[i]);
        cashKRW += dep;
        const reb = monthCounter === 1 || this.shouldRebalance(spec.rebalanceFreq, ctx.dates[i]);
        if (reb) trade(i, 'rebalance');
        else if (cashKRW + cashUSD * fxi > 1) trade(i, 'invest');
      }
      // 4) 연말 세무 처리
      if (config.taxEnabled && ctx.isYearEnd[i] && i < e) yearEndTax(i);
      // 5) 사후 평가 (거래비용·세금은 TWR 손실로 반영)
      const post = valueNow(i);
      values[t] = post;
      invested[t] = investedKrw;
      const basis = pre + dep;
      if (basis > 0) twr[t] *= post / basis;
      if (twr[t] > peakTwr) peakTwr = twr[t];
      postPrev = post;
    }

    // 최종 청산(세후 모드): 매도수수료·거래세·환전스프레드·양도세 반영
    const grossFinal = values[len - 1];
    let finalVal = grossFinal, liquidationTax = 0, liquidationCost = 0;
    if (config.taxEnabled) {
      fxi = ctx.fx[e];
      let proceedsKrw = 0, gain = yearRealized;
      for (let a = 0; a < n; a++) {
        if (shares[a] <= 0) continue;
        const notional = shares[a] * P[a][e];
        const net = notional * (1 - fee) - (isKrSt[a] ? notional * C.KR_STOCK_SELL_TAX : 0);
        if (isUS[a]) {
          gain += lots[a].unrealized((net / shares[a]) * fxi);
          proceedsKrw += net * fxi * (1 - spread);
        } else proceedsKrw += net;
      }
      proceedsKrw += cashKRW + cashUSD * fxi * (1 - spread);
      liquidationTax = Math.max(0, gain - C.TAX_ALLOWANCE_KRW) * C.TAX_RATE;
      liquidationCost = Math.max(0, grossFinal - proceedsKrw);
      finalVal = proceedsKrw - liquidationTax;
    }

    return {
      values, invested, twr, flows, flowDates, investedKrw, grossFinal, finalVal,
      taxesPaid: taxesPaid + liquidationTax, feesPaid: feesPaid + liquidationCost, divNetKrw, divTaxKrw, keys, weights: W
    };
  }
}

/* ----------------------------------------------------------------------------
 * 성과/위험 지표
 * -------------------------------------------------------------------------- */
class InstitutionalAnalyticsEngine {
  static analyze(port, bench, rf, ppy) {
    const len = Math.min(port.length, bench.length);
    const empty = { sharpe: 0, sortino: 0, treynor: 0, omega: 0, trackingError: 0, informationRatio: 0, cvar95: 0, beta: 1, volAnn: 0 };
    if (len < 5) return empty;
    let meanP = 0, meanM = 0;
    for (let i = 0; i < len; i++) { meanP += port[i] - rf[i]; meanM += bench[i] - rf[i]; }
    meanP /= len; meanM /= len;
    let cov = 0, varM = 0, varP = 0, down = 0, pos = 0, neg = 0, meanA = 0;
    for (let i = 0; i < len; i++) {
      const ep = port[i] - rf[i], em = bench[i] - rf[i];
      cov += (ep - meanP) * (em - meanM);
      varM += (em - meanM) ** 2;
      varP += (ep - meanP) ** 2;
      if (ep < 0) down += ep * ep;
      if (port[i] > 0) pos += port[i]; else neg += -port[i];
      meanA += port[i] - bench[i];
    }
    meanA /= len;
    let varA = 0;
    for (let i = 0; i < len; i++) varA += (port[i] - bench[i] - meanA) ** 2;
    const beta = varM > 0 ? cov / varM : 1;
    const vol = Math.sqrt(varP / len * ppy);
    const dvol = Math.sqrt(down / len * ppy);
    const te = Math.sqrt(varA / len * ppy) * 100;
    const sorted = Array.from(port.subarray ? port.subarray(0, len) : port.slice(0, len)).sort((a, b) => a - b);
    const cut = Math.max(1, Math.floor(len * 0.05));
    let cv = 0;
    for (let k = 0; k < cut; k++) cv += sorted[k];
    return {
      sharpe: vol > 0 ? meanP * ppy / vol : 0,
      sortino: dvol > 0 ? meanP * ppy / dvol : 0,
      treynor: Math.abs(beta) > 1e-6 ? meanP * ppy * 100 / beta : 0,
      omega: neg > 0 ? pos / neg : 0,
      trackingError: te,
      informationRatio: te > 0 ? (meanP - meanM) * ppy * 100 / te : 0,
      cvar95: -(cv / cut) * 100,
      beta, volAnn: vol * 100
    };
  }

  static ulcerAndPain(twr, cagrPct, rfAnnPct) {
    const N = twr.length;
    if (!N) return { ulcerIndex: 0, painRatio: 0 };
    let peak = 0, sq = 0, sum = 0;
    for (let i = 0; i < N; i++) {
      if (twr[i] > peak) peak = twr[i];
      const dd = peak > 0 ? (peak - twr[i]) / peak * 100 : 0;
      sq += dd * dd; sum += dd;
    }
    const pain = sum / N;
    return { ulcerIndex: Math.sqrt(sq / N), painRatio: pain > 0 ? (cagrPct - rfAnnPct) / pain : 0 };
  }

  static rollingSharpe(rets, rf, dates, ppy) {
    const w = Math.round(3 * ppy);
    const N = rets.length;
    if (N < w) return [];
    const out = [];
    for (let i = w; i <= N; i += 21) {
      let m = 0;
      for (let k = i - w; k < i; k++) m += rets[k] - rf[k];
      m /= w;
      let v = 0;
      for (let k = i - w; k < i; k++) v += (rets[k] - rf[k] - m) ** 2;
      const vol = Math.sqrt(v / w * ppy);
      out.push({ date: dates[i], sharpe: vol > 1e-9 ? m * ppy / vol : 0 });
    }
    return out;
  }
}

/* ----------------------------------------------------------------------------
 * Fama-French 5 + 모멘텀 회귀 (달러 기준 수익률, Newey-West HAC)
 * -------------------------------------------------------------------------- */
class FamaFrenchEngine {
  static solve(usdRets, retDates, proxy) {
    const N = usdRets.length;
    const X = [], Y = [];
    let names, modelLabel, modelType;
    if (FactorData.available()) {
      for (let i = 0; i < N; i++) {
        const r = FactorData.row(retDates[i]);
        if (!r) continue;
        const v = [r.mktRf, r.smb, r.hml, r.rmw, r.cma, r.mom, r.rf];
        if (v.some(x => x === null || x === undefined)) continue;
        X.push([1, r.mktRf, r.smb, r.hml, r.rmw, r.cma, r.mom]);
        Y.push(usdRets[i] - r.rf);
      }
      names = ['Alpha', 'MKT-RF', 'SMB', 'HML', 'RMW', 'CMA', 'MOM'];
      modelLabel = 'Fama-French 5팩터 + 모멘텀 (Kenneth R. French 공식 일간)';
      modelType = 'FF5_MOM';
    }
    if (X.length < 60 && proxy) {
      X.length = 0; Y.length = 0;
      for (let i = 0; i < N; i++) {
        const rf = HistoricalInterestRates.rfDaily(retDates[i]);
        const m = proxy.SPY?.[i], s = proxy.IWM?.[i], h = proxy.SCHD?.[i];
        if (![m, s, h].every(v => v !== undefined && isFinite(v))) continue;
        X.push([1, m - rf, s - m, h - m]);
        Y.push(usdRets[i] - rf);
      }
      names = ['Alpha', 'MKT-RF', 'SMB', 'HML'];
      modelLabel = 'ETF 대리 3팩터 (SPY·IWM·SCHD) — 공식 팩터 미보유 구간';
      modelType = 'PROXY';
    }
    if (X.length < 30) return this.empty('관측치 부족');
    return this.ols(X, Y, names, modelLabel, modelType);
  }

  static ols(X, Y, names, modelLabel, modelType) {
    const N = X.length, K = X[0].length;
    const beta = QROLSMatrixSolver.solve(X, Y);
    if (!beta) return this.empty('회귀 실패');
    const e = new Float64Array(N);
    let my = 0; Y.forEach(v => { my += v; }); my /= N;
    let sst = 0, sse = 0;
    for (let i = 0; i < N; i++) {
      let yp = 0;
      for (let j = 0; j < K; j++) yp += beta[j] * X[i][j];
      e[i] = Y[i] - yp;
      sst += (Y[i] - my) ** 2; sse += e[i] ** 2;
    }
    const hac = NeweyWestHACEngine.compute(X, e);
    const TD = GLOBAL_QUANT_CONFIG.TRADING_DAYS;
    const details = {};
    for (let j = 0; j < K; j++) {
      const coeff = j === 0 ? beta[0] * TD * 100 : beta[j];
      const se = hac ? (j === 0 ? hac.se[0] * TD * 100 : hac.se[j]) : NaN;
      const t = se > 0 ? coeff / se : 0;
      const at = Math.abs(t);
      details[names[j]] = { beta: coeff, se, tStat: t, stars: at >= 2.58 ? '***' : at >= 1.96 ? '**' : at >= 1.645 ? '*' : '' };
    }
    const g = (nm) => details[nm]?.beta ?? 0;
    return {
      modelType, modelLabel, nObs: N,
      alpha: g('Alpha'), bMkt: g('MKT-RF'), bSmb: g('SMB'), bHml: g('HML'), bRmw: g('RMW'), bCma: g('CMA'), bMom: g('MOM'),
      rSquared: sst > 0 ? Math.max(0, 1 - sse / sst) : 0,
      factorDetails: details
    };
  }

  static empty(reason) {
    return { modelType: 'NONE', modelLabel: `분석 불가 (${reason})`, nObs: 0, alpha: 0, bMkt: 1, bSmb: 0, bHml: 0, bRmw: 0, bCma: 0, bMom: 0, rSquared: 0, factorDetails: {} };
  }
}

/* ----------------------------------------------------------------------------
 * 몬테카를로 — 월간 수익률 순환 블록 부트스트랩, 시드 고정(재현 가능)
 * -------------------------------------------------------------------------- */
class MonteCarloEngine {
  static run(monthlyR, monthlyDep, seed, iterations = GLOBAL_QUANT_CONFIG.MC_ITERATIONS) {
    const M = monthlyR.length;
    if (M < 2) return { p5: 0, p50: 0, p95: 0 };
    const L = M >= 24 ? 6 : (M >= 6 ? 3 : 1);
    const rng = QuantUtils.mulberry32(seed);
    const vals = new Float64Array(iterations);
    for (let it = 0; it < iterations; it++) {
      let v = 0, m = 0;
      while (m < M) {
        const start = Math.floor(rng() * M);
        for (let b = 0; b < L && m < M; b++, m++) v = (v + monthlyDep[m]) * (1 + monthlyR[(start + b) % M]);
      }
      vals[it] = v;
    }
    vals.sort();
    return { p5: vals[Math.floor(iterations * 0.05)], p50: vals[Math.floor(iterations * 0.5)], p95: vals[Math.floor(iterations * 0.95)] };
  }
}

/* ----------------------------------------------------------------------------
 * 5축 퀀트 점수 (수익성 · 하방효율 · 고통방어 · 꼬리위험 · 경로안정성)
 * -------------------------------------------------------------------------- */
class QuantScoreEngine {
  static WEIGHTS = { w1: 0.25, w2: 0.25, w3: 0.20, w4: 0.15, w5: 0.15 };

  static calculatePeriodMonths(startMonth, endMonth) {
    const [sY, sM] = startMonth.split('-').map(Number);
    const [eY, eM] = endMonth.split('-').map(Number);
    return (eY - sY) * 12 + (eM - sM) + 1;
  }

  static painFactor(ulcer, mdd) {
    const zU = (ulcer - 3.0) / 2.5, zM = (mdd - 20.0) / 12.0;
    const c = 0.70710678;
    const pc1 = c * zU + c * zM, pc2 = c * zU - c * zM; // 45° 회전 (고통 크기 / 지속-깊이 차이)
    return Math.min(1, Math.max(0, Math.exp(-0.35 * Math.max(0, pc1) - 0.25 * Math.max(0, pc2))));
  }

  /** 총점 + 축별 기여도 (기여도 합 = 총점) */
  static calculate(res, periodMonths, rfAnnPct) {
    const num = (v, d = 0) => (v === undefined || v === null || isNaN(v) ? d : v);
    const xirr = num(res.annualizedXIRR), sortino = Math.max(0, num(res.sortino)), omega = Math.max(0, num(res.omega));
    const pain = Math.max(0, num(res.painRatio)), ulcer = Math.max(0, num(res.ulcerIndex)), cvar = Math.max(0, num(res.cvar95));
    const mdd = Math.max(0, Math.abs(num(res.twrMdd))), ir = num(res.informationRatio), alpha = num(res.ff?.alpha);
    const te = Math.max(0.01, num(res.trackingError, 15));
    const W = this.WEIGHTS;

    const excess = xirr - rfAnnPct;
    const slope = -0.085 * (15 / Math.max(5, te * 1.1));
    const a1r = Math.max(0, Math.min(25, 25 * (2 / (1 + Math.exp(slope * excess)) - 1)));
    const a1 = Math.min(25, a1r + 5 / (1 + Math.exp(-0.4 * alpha)));
    const a2 = 25 * (0.5 * (1 - Math.exp(-0.65 * sortino)) + 0.3 * (1 - Math.exp(-0.8 * Math.max(0, omega - 1))) + 0.2 * (1 - Math.exp(-0.5 * pain)));
    const a3 = 20 * this.painFactor(ulcer, mdd);
    const a4 = 15 * (0.7 * Math.exp(-cvar / 4.5) + 0.3 / (1 + Math.exp(-0.75 * ir)));
    const mc = res.monteCarlo;
    const mcOn = !!(mc && mc.p50 > 0);
    const a5 = mcOn ? 15 * Math.min(1, Math.max(0, (mc.p5 / mc.p50) / 0.55)) : 0;

    const axes = [
      { key: 'return', label: '① 수익성 & 알파', raw: a1, max: 25, weight: W.w1, on: true },
      { key: 'efficiency', label: '② 하방 효율 (소티노·오메가·페인)', raw: a2, max: 25, weight: W.w2, on: true },
      { key: 'pain', label: '③ 고통 방어 (Ulcer·MDD)', raw: a3, max: 20, weight: W.w3, on: true },
      { key: 'tail', label: '④ 꼬리 위험 (CVaR·정보비율)', raw: a4, max: 15, weight: W.w4, on: true },
      { key: 'path', label: '⑤ 경로 안정성 (몬테카를로 P5/P50)', raw: a5, max: 15, weight: W.w5, on: mcOn }
    ];
    const totalW = axes.filter(a => a.on).reduce((s, a) => s + a.weight, 0);
    const fSample = 1 - Math.exp(-Math.max(1, periodMonths) / 22);
    let total = 0;
    axes.forEach(a => {
      a.ratio = a.max > 0 ? a.raw / a.max : 0;
      a.contribution = a.on ? (a.ratio * a.weight / totalW) * 100 * fSample : 0;
      total += a.contribution;
    });
    return { total: Math.round(Math.max(0, Math.min(100, total)) * 10) / 10, axes, fSample };
  }
}

/* ----------------------------------------------------------------------------
 * 백테스트 실행기: 컨텍스트 구성 → 전략 시뮬레이션 → 지표/회귀/MC/점수
 * -------------------------------------------------------------------------- */
class BacktestRunner {
  static buildContext(dates, processed, fxData, s, e) {
    const N = dates.length;
    const fx = new Float64Array(N);
    const fxEntries = fxData ? Array.from(fxData.priceMap.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)) : [];
    const firstFxDate = fxEntries.length ? fxEntries[0][0] : null;
    let j = 0, last = 0;
    for (let i = 0; i < N; i++) {
      while (j < fxEntries.length && fxEntries[j][0] <= dates[i]) { last = fxEntries[j][1]; j++; }
      fx[i] = last > 0 ? last : FxHistory.pre2004(dates[i] < '2004-01-01' ? dates[i] : '2003-11-28');
    }
    const rf = new Float64Array(N);
    for (let i = 0; i < N; i++) rf[i] = HistoricalInterestRates.rfDaily(dates[i]);
    const isNewMonth = new Uint8Array(N), isYearEnd = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      isNewMonth[i] = (i === 0 || dates[i].substring(0, 7) !== dates[i - 1].substring(0, 7)) ? 1 : 0;
      isYearEnd[i] = (i === N - 1 || dates[i].substring(0, 4) !== dates[i + 1].substring(0, 4)) ? 1 : 0;
    }
    const years = Math.max(1 / 12, QuantUtils.daysBetween(dates[s], dates[e]) / 365.25);
    const ppy = Math.max(200, Math.min(300, (e - s) / years));
    const fxApprox = !firstFxDate || dates[s] < firstFxDate;
    const fxMissing = !fxData || fxEntries.length === 0;
    return { dates, prices: processed.prices, divs: processed.divs, synthInfo: processed.synthInfo, fx, rf, isNewMonth, isYearEnd, s, e, ppy, fxApprox, fxMissing, firstFxDate };
  }

  /** 자산의 달러 기준 총수익 일간수익률 (i → i+1) */
  static usdTR(ctx, key, s, e) {
    const P = ctx.prices[key], D = ctx.divs[key];
    if (!P) return null;
    const out = new Float64Array(e - s);
    for (let i = s; i < e; i++) out[i - s] = (P[i] > 0 && P[i + 1] > 0) ? (P[i + 1] + D[i + 1]) / P[i] - 1 : NaN;
    return out;
  }

  static benchmarkKRW(ctx, s, e) {
    const r = this.usdTR(ctx, 'SPY', s, e);
    if (!r) return new Float64Array(e - s);
    for (let i = s; i < e; i++) {
      const v = r[i - s];
      r[i - s] = isFinite(v) ? (1 + v) * ctx.fx[i + 1] / ctx.fx[i] - 1 : 0;
    }
    return r;
  }

  static analyzeSim(spec, sim, ctx, s, e, periodMonths, extra = {}) {
    const len = e - s + 1;
    const twr = sim.twr;
    const rets = new Float64Array(len - 1);
    const usd = new Float64Array(len - 1);
    for (let t = 1; t < len; t++) {
      const r = twr[t - 1] > 0 ? twr[t] / twr[t - 1] - 1 : 0;
      rets[t - 1] = r;
      usd[t - 1] = (1 + r) * ctx.fx[s + t - 1] / ctx.fx[s + t] - 1;
    }
    const rfSlice = ctx.rf.subarray(s + 1, e + 1);
    const retDates = ctx.dates.slice(s + 1, e + 1);
    const bench = extra.bench || this.benchmarkKRW(ctx, s, e);
    const ppy = extra.ppy || ctx.ppy;
    let rfMean = 0;
    for (let i = 0; i < rfSlice.length; i++) rfMean += rfSlice[i];
    const rfAnnPct = rfSlice.length ? rfMean / rfSlice.length * GLOBAL_QUANT_CONFIG.TRADING_DAYS * 100 : 3;

    const years = Math.max(1 / 365, QuantUtils.daysBetween(ctx.dates[s], ctx.dates[e]) / 365.25);
    const twrCagr = (Math.pow(Math.max(1e-9, twr[len - 1]), 1 / years) - 1) * 100;
    let peak = 0, mdd = 0;
    for (let t = 0; t < len; t++) {
      if (twr[t] > peak) peak = twr[t];
      const dd = peak > 0 ? (twr[t] - peak) / peak : 0;
      if (dd < mdd) mdd = dd;
    }
    const an = InstitutionalAnalyticsEngine.analyze(rets, bench, rfSlice, ppy);
    const up = InstitutionalAnalyticsEngine.ulcerAndPain(twr, twrCagr, rfAnnPct);
    const xirr = XIRRSolver.compute(sim.flows, sim.flowDates, sim.finalVal, ctx.dates[e]);
    const ff = extra.skipFF ? FamaFrenchEngine.empty('생략') : FamaFrenchEngine.solve(usd, retDates, extra.proxyUsd);

    // 월간 TWR 수익률 + 월 입금 (몬테카를로 입력)
    const monthlyR = [], monthlyDep = [];
    let prevEnd = 1, depIdx = 0;
    for (let t = 0; t < len; t++) {
      const i = s + t;
      const isLast = (t === len - 1) || ctx.dates[i].substring(0, 7) !== ctx.dates[i + 1].substring(0, 7);
      if (t === 0 || ctx.isNewMonth[i]) { monthlyDep.push(sim.flows[depIdx] || 0); depIdx++; }
      if (isLast) { monthlyR.push(twr[t] / prevEnd - 1); prevEnd = twr[t]; }
    }
    const seed = QuantUtils.hashString(`${spec.key}|${ctx.dates[s]}|${ctx.dates[e]}|${JSON.stringify(spec.allocations)}|${spec.rebalanceFreq}`);
    const monteCarlo = MonteCarloEngine.run(monthlyR, monthlyDep, seed, extra.mcIterations || GLOBAL_QUANT_CONFIG.MC_ITERATIONS);

    const res = {
      ticker: spec.key, name: spec.name, isMix: !!spec.isMix, allocations: spec.allocations, rebalanceFreq: spec.rebalanceFreq,
      investedKrw: sim.investedKrw, finalVal: sim.finalVal, grossFinal: sim.grossFinal,
      cumulativeReturn: sim.investedKrw > 0 ? (sim.finalVal - sim.investedKrw) / sim.investedKrw * 100 : 0,
      annualizedXIRR: xirr, twrCagr, twrMdd: mdd * 100,
      sharpe: an.sharpe, sortino: an.sortino, treynor: an.treynor, omega: an.omega,
      trackingError: an.trackingError, informationRatio: an.informationRatio, cvar95: an.cvar95, volAnn: an.volAnn,
      ulcerIndex: up.ulcerIndex, painRatio: up.painRatio, ff,
      rollingSharpe: extra.skipRolling ? [] : InstitutionalAnalyticsEngine.rollingSharpe(rets, rfSlice, retDates, ppy),
      portfolioValues: sim.values, investedSeries: sim.invested, twrSeries: twr,
      monteCarlo, taxesPaid: sim.taxesPaid, feesPaid: sim.feesPaid, divNetKrw: sim.divNetKrw, divTaxKrw: sim.divTaxKrw,
      rfAnnPct
    };
    const sc = QuantScoreEngine.calculate(res, periodMonths, rfAnnPct);
    res.score = sc.total;
    res.scoreBreakdown = sc;
    return res;
  }

  static async runAll(specs, ctx, config, periodMonths, onProgress) {
    const s = ctx.s, e = ctx.e;
    const bench = this.benchmarkKRW(ctx, s, e);
    let proxyUsd = null;
    if (!FactorData.available()) {
      proxyUsd = {};
      ['SPY', 'IWM', 'SCHD'].forEach(k => { const r = this.usdTR(ctx, k, s, e); if (r) proxyUsd[k] = r; });
    }
    const results = {};
    for (let k = 0; k < specs.length; k++) {
      await QuantUtils.yieldToEventLoop();
      const spec = specs[k];
      const sim = PortfolioSimulator.run(spec, ctx, config, s, e);
      results[spec.key] = this.analyzeSim(spec, sim, ctx, s, e, periodMonths, { bench, proxyUsd });
      if (onProgress) onProgress((k + 1) / specs.length);
    }
    return results;
  }
}

/* ----------------------------------------------------------------------------
 * AI 최적화기
 *  1단계: 워커에서 고속 스크리닝(리밸런싱 주기·적립 방식 동일 반영)
 *  2단계: 상위 후보를 실제 엔진으로 재채점(세금·수수료·환율·MC 포함)
 *  3단계: 학습(70%) / 검증(30%) 분리 — 표본 외 성과 제시
 * -------------------------------------------------------------------------- */
function __fastSim(rets, idx, w, N, monthFlag, rebalFlag, isDCA, ppy, rfMean, buf) {
  const k = idx.length;
  const h = buf;
  for (let a = 0; a < k; a++) h[a] = 0;
  let twr = 1, peak = 1, maxDD = 0, sumEx = 0, sumSq = 0, sumDown = 0, sumDDsq = 0, invested = 0, post = 0;
  for (let t = 0; t <= N; t++) {
    let pre = 0;
    for (let a = 0; a < k; a++) pre += h[a];
    if (t > 0) {
      const r = post > 0 ? pre / post - 1 : 0;
      twr *= 1 + r;
      const ex = r - rfMean;
      sumEx += ex; sumSq += ex * ex;
      if (ex < 0) sumDown += ex * ex;
      if (twr > peak) peak = twr;
      const dd = twr / peak - 1;
      if (dd < maxDD) maxDD = dd;
      sumDDsq += dd * dd * 1e4;
    }
    if (monthFlag[t]) {
      const dep = isDCA ? 1 : (t === 0 ? 1 : 0);
      invested += dep;
      const total = pre + dep;
      if (t === 0 || rebalFlag[t]) { for (let a = 0; a < k; a++) h[a] = total * w[a]; }
      else if (dep > 0) { for (let a = 0; a < k; a++) h[a] += dep * w[a]; }
    }
    post = 0;
    for (let a = 0; a < k; a++) post += h[a];
    if (t < N) for (let a = 0; a < k; a++) h[a] *= 1 + rets[idx[a]][t];
  }
  const n = Math.max(1, N);
  const mean = sumEx / n;
  const vr = Math.max(1e-18, sumSq / n - mean * mean);
  const years = Math.max(0.05, N / ppy);
  return {
    cagr: (Math.pow(Math.max(1e-9, twr), 1 / years) - 1) * 100,
    mdd: -maxDD * 100,
    sharpe: mean / Math.sqrt(vr) * Math.sqrt(ppy),
    sortino: sumDown > 0 ? mean / Math.sqrt(sumDown / n) * Math.sqrt(ppy) : 0,
    ulcer: Math.sqrt(sumDDsq / n),
    multiple: invested > 0 ? post / invested : 0
  };
}

function __optScreen(P) {
  const { keys, rets, N, monthFlag, rebalFlag, isDCA, ppy, rfMean, anchors } = P;
  const K = keys.length;
  const buf = new Float64Array(8);
  const TOP = 10;
  const lists = { ret: [], mdd: [], sharpe: [], sortino: [] };
  const seen = new Set();
  let evaluated = 0;
  const sortRet = (m) => (isDCA ? m.multiple : m.cagr);
  const push = (arr, item, better) => {
    let pos = arr.length;
    while (pos > 0 && better(item, arr[pos - 1])) pos--;
    if (pos < TOP) { arr.splice(pos, 0, item); if (arr.length > TOP) arr.pop(); }
  };
  const evalAlloc = (idx, wPct) => {
    const pairs = idx.map((a, j) => [a, wPct[j]]).filter(p => p[1] > 0).sort((x, y) => x[0] - y[0]);
    const key = pairs.map(p => p[0] + ':' + p[1]).join('|');
    if (seen.has(key)) return null;
    seen.add(key);
    const ii = pairs.map(p => p[0]);
    const ww = pairs.map(p => p[1] / 100);
    const m = __fastSim(rets, ii, ww, N, monthFlag, rebalFlag, isDCA, ppy, rfMean, buf);
    evaluated++;
    const item = { alloc: pairs, m };
    push(lists.ret, item, (a, b) => sortRet(a.m) > sortRet(b.m));
    push(lists.mdd, item, (a, b) => a.m.mdd < b.m.mdd || (a.m.mdd === b.m.mdd && a.m.sharpe > b.m.sharpe));
    push(lists.sharpe, item, (a, b) => a.m.sharpe > b.m.sharpe);
    push(lists.sortino, item, (a, b) => a.m.sortino > b.m.sortino);
    return m;
  };
  const single = [];
  for (let a = 0; a < K; a++) single.push({ a, m: evalAlloc([a], [100]) || __fastSim(rets, [a], [1], N, monthFlag, rebalFlag, isDCA, ppy, rfMean, buf) });
  const topBy = (fn, n) => single.slice().sort((x, y) => fn(y.m) - fn(x.m)).slice(0, n).map(x => x.a);
  const pairs = (pool, step) => {
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++)
      for (let w = step; w <= 100 - step; w += step) evalAlloc([pool[i], pool[j]], [w, 100 - w]);
  };
  const triples = (pool, step) => {
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let k = j + 1; k < pool.length; k++)
      for (let w1 = step; w1 <= 100 - 2 * step; w1 += step) for (let w2 = step; w2 <= 100 - w1 - step; w2 += step)
        evalAlloc([pool[i], pool[j], pool[k]], [w1, w2, 100 - w1 - w2]);
  };
  const byRet = topBy(sortRet, 10);
  const byMdd = topBy(m => -m.mdd, 10);
  (anchors || []).forEach(a => { if (!byMdd.includes(a)) byMdd.push(a); });
  const bySharpe = topBy(m => m.sharpe, 10);
  pairs(byRet, 5); triples(byRet.slice(0, 6), 10);
  pairs(byMdd, 5); triples(byMdd.slice(0, 6), 10);
  pairs(bySharpe, 5); triples(bySharpe.slice(0, 6), 10);
  const balanced = Array.from(new Set([...bySharpe.slice(0, 8), ...byRet.slice(0, 6), ...byMdd.slice(0, 6)]));
  pairs(balanced, 10); triples(balanced.slice(0, 12), 15);
  return { lists, evaluated };
}

class PortfolioOptimizerEngine {
  static async screen(payload) {
    const run = () => __optScreen(payload);
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') { await QuantUtils.yieldToEventLoop(); return run(); }
    let url = null, worker = null;
    try {
      const src = `${__fastSim.toString()}\n${__optScreen.toString()}\nself.onmessage=(e)=>{try{self.postMessage({ok:true,res:__optScreen(e.data)});}catch(err){self.postMessage({ok:false,err:String(err)});}};`;
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url);
      return await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('worker timeout')), 180000);
        worker.onmessage = (ev) => { clearTimeout(to); ev.data.ok ? resolve(ev.data.res) : reject(new Error(ev.data.err)); };
        worker.onerror = (err) => { clearTimeout(to); reject(err); };
        worker.postMessage(payload);
      });
    } catch (err) {
      console.warn('[Optimizer] 워커 실행 실패 → 메인 스레드로 대체', err);
      await QuantUtils.yieldToEventLoop();
      return run();
    } finally {
      if (worker) worker.terminate();
      if (url) URL.revokeObjectURL(url);
    }
  }

  static universeKeys(type, selected) {
    const all = Object.keys(TICKER_UNIVERSE).filter(t => t !== 'KOSPI');
    if (type === 'etf_only') return all.filter(t => ['index_etf', 'leveraged_etf', 'bond_commodity'].includes(TICKER_UNIVERSE[t].category));
    if (type === 'stocks_only') return all.filter(t => ['us_top', 'kr_top'].includes(TICKER_UNIVERSE[t].category));
    if (type === 'selected') return (selected && selected.length) ? selected.slice() : all;
    return all;
  }

  static async optimize(p) {
    const { startMonth, endMonth, universeType, selectedTickers, rebalanceFreq, excludeSynthetic, config, onProgress } = p;
    const report = (v, msg) => { if (onProgress) onProgress(v, msg); };
    const keys0 = this.universeKeys(universeType, selectedTickers);
    const startYear = parseInt(startMonth.substring(0, 4), 10);
    const curYear = new Date().getFullYear();
    report(0.05, '시세 로딩');
    const loaded = await DataPipeline.load(keys0.concat(['SPY']), startYear, curYear, { offlineOnly: universeType !== 'selected' });
    const { dates } = CalendarBuilder.build(loaded.raw, keys0.filter(k => loaded.raw[k]), `${startMonth}-01`);
    if (dates.length < 60) return { error: '해당 기간의 거래일 데이터가 부족합니다.' };
    const processed = MultiFactorSynthesisEngine.process(loaded.raw, dates);
    const s = 0;
    const e = QuantUtils.lastIndexLE(dates, `${endMonth}-31`);
    if (e - s < 60) return { error: '선택 기간이 너무 짧습니다 (최소 약 3개월).' };
    const ctx = BacktestRunner.buildContext(dates, processed, loaded.fx, s, e);
    const periodMonths = QuantScoreEngine.calculatePeriodMonths(startMonth, endMonth);

    const synthOverlap = (k, a, b) => {
      const si = processed.synthInfo[k];
      if (!si) return 0;
      const lo = Math.max(a, si.fromIdx), hi = Math.min(b, si.realIdx);
      return hi > lo ? (hi - lo) / Math.max(1, b - a) : 0;
    };
    const valid = keys0.filter(k => {
      if (!loaded.raw[k] || DataAvailability.check([k], processed, dates, s).length) return false;
      if (excludeSynthetic && synthOverlap(k, s, e) > 0) return false;
      return true;
    });
    if (valid.length === 0) return { error: '선택 기간 전체에 데이터가 있는 자산이 없습니다.' };

    const years = QuantUtils.daysBetween(dates[s], dates[e]) / 365.25;
    const trainE = years >= 4 ? s + Math.floor((e - s) * 0.7) : e;
    const hasTest = trainE < e;
    const isDCA = config.investConfig.mode !== 'lumpSum';
    const divW = (k) => config.taxEnabled ? (QuantUtils.isDomestic(k) ? GLOBAL_QUANT_CONFIG.KR_DIV_TAX : GLOBAL_QUANT_CONFIG.US_DIV_WITHHOLDING) : 0;
    const krwRets = (k, a, b) => {
      const Pp = processed.prices[k], Dd = processed.divs[k], w = divW(k), dom = QuantUtils.isDomestic(k);
      const out = new Float64Array(b - a);
      for (let i = a; i < b; i++) {
        const tr = Pp[i] > 0 ? (Pp[i + 1] + Dd[i + 1] * (1 - w)) / Pp[i] : 1;
        out[i - a] = tr * (dom ? 1 : ctx.fx[i + 1] / ctx.fx[i]) - 1;
      }
      return out;
    };
    const flags = (a, b) => {
      const mf = new Uint8Array(b - a + 1), rb = new Uint8Array(b - a + 1);
      for (let i = a; i <= b; i++) {
        if (i === a || ctx.isNewMonth[i]) {
          mf[i - a] = 1;
          rb[i - a] = PortfolioSimulator.shouldRebalance(rebalanceFreq, dates[i]) ? 1 : 0;
        }
      }
      return { mf, rb };
    };
    const rfMeanOf = (a, b) => { let m = 0; for (let i = a + 1; i <= b; i++) m += ctx.rf[i]; return m / Math.max(1, b - a); };

    report(0.15, '고속 스크리닝');
    const trFlags = flags(s, trainE);
    const anchors = ['TLT', 'GLD', 'SCHD', 'JEPI'].map(k => valid.indexOf(k)).filter(i => i >= 0);
    const screen = await this.screen({
      keys: valid, rets: valid.map(k => krwRets(k, s, trainE)), N: trainE - s,
      monthFlag: trFlags.mf, rebalFlag: trFlags.rb, isDCA, ppy: ctx.ppy, rfMean: rfMeanOf(s, trainE), anchors
    });

    // 2단계: 실제 엔진 재채점
    const cand = new Map();
    Object.values(screen.lists).forEach(list => list.forEach(it => {
      const alloc = {};
      it.alloc.forEach(([a, w]) => { alloc[valid[a]] = w; });
      cand.set(JSON.stringify(it.alloc), alloc);
    }));
    const bench = BacktestRunner.benchmarkKRW(ctx, s, trainE);
    const trainMonths = Math.max(1, Math.round(QuantUtils.daysBetween(dates[s], dates[trainE]) / 30.44));
    const evaluatedReal = [];
    let c = 0;
    for (const alloc of cand.values()) {
      await QuantUtils.yieldToEventLoop();
      const spec = { key: 'opt:' + JSON.stringify(alloc), name: 'opt', allocations: alloc, rebalanceFreq, isMix: true };
      const sim = PortfolioSimulator.run(spec, ctx, config, s, trainE);
      const res = BacktestRunner.analyzeSim(spec, sim, ctx, s, trainE, trainMonths, { bench, skipRolling: true, mcIterations: 4000 });
      evaluatedReal.push(res);
      c++;
      report(0.3 + 0.6 * c / cand.size, `실제 엔진 재채점 ${c}/${cand.size}`);
    }
    if (evaluatedReal.length === 0) return { error: '후보 조합을 만들지 못했습니다.' };
    const pick = (fn) => evaluatedReal.reduce((best, r) => (best === null || fn(r, best) ? r : best), null);
    const champs = {
      bestScore: pick((a, b) => a.score > b.score),
      maxSharpe: pick((a, b) => a.sharpe > b.sharpe),
      minMDD: pick((a, b) => Math.abs(a.twrMdd) < Math.abs(b.twrMdd)),
      maxReturn: pick((a, b) => a.annualizedXIRR > b.annualizedXIRR)
    };

    // 3단계: 표본 외 검증
    let teFlags = null, teRets = null, teRf = 0;
    if (hasTest) {
      teFlags = flags(trainE, e);
      teRets = valid.map(k => krwRets(k, trainE, e));
      teRf = rfMeanOf(trainE, e);
    }
    const buf = new Float64Array(8);
    const out = {};
    for (const [name, r] of Object.entries(champs)) {
      const idx = Object.keys(r.allocations).map(k => valid.indexOf(k));
      const w = Object.values(r.allocations).map(v => v / 100);
      const test = hasTest ? __fastSim(teRets, idx, w, e - trainE, teFlags.mf, teFlags.rb, isDCA, ctx.ppy, teRf, buf) : null;
      let synthShare = 0;
      Object.entries(r.allocations).forEach(([k, v]) => { synthShare += (v / 100) * synthOverlap(k, s, trainE); });
      out[name] = {
        allocations: r.allocations, score: r.score, xirr: r.annualizedXIRR, cagr: r.twrCagr, mdd: Math.abs(r.twrMdd),
        sharpe: r.sharpe, sortino: r.sortino, test, synthShare
      };
    }
    report(1, '완료');
    return {
      champions: out, totalEvaluated: screen.evaluated, realEvaluated: evaluatedReal.length, validCount: valid.length,
      trainRange: [dates[s], dates[trainE]], testRange: hasTest ? [dates[trainE], dates[e]] : null, isDCA
    };
  }
}

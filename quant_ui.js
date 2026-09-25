/* ============================================================================
 * quant_ui.js — 화면 컨트롤러 v16.0 (quant_engine.js 필요)
 * ========================================================================== */
'use strict';

class ToastNotifier {
  static MAX = 5;
  static show(message, type = 'info', autoClose = true) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    while (container.children.length >= this.MAX) container.firstElementChild.remove();
    const toast = document.createElement('div');
    const cls = type === 'error' ? 'bg-rose-900 border-rose-700 text-rose-100'
      : type === 'warning' ? 'bg-amber-900 border-amber-700 text-amber-100'
      : type === 'success' ? 'bg-emerald-900 border-emerald-700 text-emerald-100'
      : 'bg-slate-900 border-slate-700 text-slate-100';
    toast.className = `toast-animate p-3.5 rounded-lg border shadow-xl text-xs flex items-start justify-between gap-2 pointer-events-auto ${cls}`;
    const span = document.createElement('span');
    span.className = 'leading-relaxed whitespace-pre-line';
    span.textContent = message;
    const btn = document.createElement('button');
    btn.className = 'font-bold opacity-70 hover:opacity-100 px-1 text-sm shrink-0';
    btn.setAttribute('aria-label', '알림 닫기');
    btn.textContent = '×';
    btn.addEventListener('click', () => toast.remove());
    toast.append(span, btn);
    container.appendChild(toast);
    if (autoClose) {
      const ms = type === 'error' ? 12000 : type === 'warning' ? 10000 : type === 'info' ? 8000 : 5000;
      setTimeout(() => toast.remove(), ms);
    }
  }
}

/* 지표 설명 사전: { title, desc(무엇), formula(계산), guide(해석 기준) } */
const METRIC_INFO = {
  ticker: { title: '종목 / 전략', desc: '개별 자산(100% 보유) 또는 커스텀 믹스 전략입니다. 배지로 실제 데이터/합성 포함 여부와 리밸런싱 주기를 표시합니다.' },
  score: { title: '종합점수 (0~100)', desc: '수익성·하방효율·고통방어·꼬리위험·경로안정성 5개 축을 가중 합산한 점수입니다. 짧은 기간은 표본 보정계수로 감점됩니다.', formula: 'Σ(축 원점수/만점 × 가중치) × 100 × 표본보정', guide: '70점↑ 우수 · 50~70 보통 · 50 미만 주의. 🎯 5축 점수 탭에서 축별 기여도를 볼 수 있습니다.' },
  investedKrw: { title: '총 원금', desc: '기간 동안 실제로 입금한 금액의 합계입니다 (적립식은 월 적립금 × 개월 수, 스마트 적립식은 증액분 포함).' },
  finalVal: { title: '최종 평가금', desc: '세후 모드: 종료일에 전량 매도했다고 가정하고 매도수수료·국내 거래세·환전 스프레드·양도세(연 250만 원 공제 후 22%)를 뺀 실수령액입니다. 세전 모드: 종료 시점 평가금입니다.' },
  costs: { title: '세금 + 비용', desc: '배당세(미국 15%/국내 15.4%), 양도세, 매매수수료, 환전 스프레드, 거래세, 최종 청산비용의 누적 합계(원)입니다. 마우스를 올리면 배당세 금액이 보입니다.' },
  xirr: { title: 'XIRR (금액가중 연수익률)', desc: '실제 입금 날짜와 금액, 최종 평가금을 모두 반영한 "내 계좌"의 연복리 수익률입니다. 적립식의 실질 성과를 볼 때 가장 적합합니다.', formula: 'Σ 입금액/(1+r)^t = 최종평가금/(1+r)^T 를 만족하는 r', guide: '같은 기간 SPY의 XIRR과 비교해 보세요.' },
  twrCagr: { title: 'TWR CAGR (시간가중 연성장률)', desc: '입금 시점·금액의 영향을 제거한 전략 자체의 연평균 성장률입니다. 운용 중 수수료·배당세·연말 양도세는 반영하고, 최종 청산세는 제외합니다.', guide: 'XIRR보다 낮다면 하락장에서 많이 산(분할매수 효과) 것이고, 높다면 상승장 고점에서 많이 산 것입니다.' },
  sharpe: { title: '샤프 지수 (Sharpe Ratio)', desc: '감수한 전체 변동성 1단위당 얻은 초과수익입니다. 상승 변동성도 위험으로 계산합니다.', formula: '(연 수익률 − 무위험수익률) ÷ 연 변동성', guide: '1.0↑ 매우 우수 · 0.5~1.0 양호 · 0.5 미만 낮음 · 음수는 무위험자산보다 못함. 주식 지수는 장기적으로 0.4~0.6 수준입니다.' },
  sortino: { title: '소티노 지수 (Sortino Ratio)', desc: '샤프 지수와 비슷하지만 하락(손실) 변동성만 위험으로 봅니다. 급등이 잦은 자산이 샤프에서 억울하게 감점되는 문제를 보완합니다.', formula: '(연 수익률 − 무위험수익률) ÷ 연 하방편차', guide: '1.5↑ 우수 · 1.0 전후 양호 · 0.5 미만 낮음. 일반적으로 샤프의 1.3~1.5배 정도로 나옵니다.' },
  treynor: { title: '트레이너 지수 (Treynor Ratio)', desc: '시장위험(베타) 1단위당 얻은 연 초과수익(%p)입니다. 기준 시장은 원화로 환산한 S&P 500(SPY)입니다.', formula: '(연 수익률 − 무위험수익률) ÷ 베타(SPY 대비)', guide: '같은 기간 SPY의 트레이너 값보다 높으면 시장위험 대비 효율이 좋습니다. 베타가 0에 가깝거나 음수(채권·인버스)면 값이 과장·반전되므로 해석하지 마세요.' },
  omega: { title: '오메가 비율 (Omega Ratio)', desc: '0%를 기준으로 상승한 날의 이익 합계를 하락한 날의 손실 합계로 나눈 값입니다. 분포의 비대칭(꼬리)까지 모두 반영합니다.', formula: 'Σ(일간 이익) ÷ Σ(일간 손실)', guide: '1보다 크면 이익이 손실보다 큽니다. 일간 기준이라 1.05~1.15 범위가 흔하며, 1.10↑이면 우수합니다.' },
  painRatio: { title: '페인 비율 (Pain Ratio)', desc: '투자 기간 내내 겪은 평균 낙폭(Pain Index) 대비 초과수익입니다. 깊이뿐 아니라 "물려 있던 기간"의 고통을 반영합니다.', formula: '(TWR CAGR − 무위험수익률) ÷ 평균 낙폭(%)', guide: '1.0↑ 양호 · 2.0↑ 우수 · 0.5 미만이면 고통에 비해 보상이 작습니다.' },
  trackingError: { title: '추종오차 (Tracking Error)', desc: '원화 환산 S&P 500(SPY)과의 일간 수익률 차이가 얼마나 들쭉날쭉한지를 연 표준편차로 나타낸 값입니다.', formula: '연 표준편차(전략 수익률 − SPY 수익률)', guide: '0~3% 지수와 거의 동일 · 5~10% 적극적 · 15%↑ 지수와 전혀 다른 움직임(레버리지·개별주·채권 등).' },
  informationRatio: { title: '정보비율 (Information Ratio)', desc: 'SPY 대비 초과수익을 추종오차로 나눈 값으로, "시장과 다르게 움직여서 얻은 보상이 꾸준한가"를 봅니다.', formula: '(전략 연수익 − SPY 연수익) ÷ 추종오차', guide: '0.5↑ 우수 · 0~0.5 보통 · 음수면 SPY보다 못한 성과입니다.' },
  ulcerIndex: { title: 'Ulcer 지수 (마음 고통 지수)', desc: '고점 대비 낙폭을 제곱해 평균낸 뒤 제곱근을 취한 값입니다. 깊고 오래 지속된 하락일수록 크게 반영합니다.', formula: '√(평균(낙폭%²))', guide: '5 이하 낮음 · 5~10 보통 · 10~20 높음 · 20↑ 매우 고통스러운 경로(레버리지·개별주).' },
  cvar95: { title: 'CVaR 95% (조건부 최대손실)', desc: '가장 나빴던 하위 5% 거래일들의 평균 일간 손실률입니다. 폭락장에서 하루에 평균 얼마나 잃는지를 보여줍니다.', formula: '하위 5% 일간 수익률의 평균 (부호 반전)', guide: '작을수록 좋습니다. S&P 500은 대략 2.5~3.5%, 3배 레버리지는 7~10% 수준입니다.' },
  twrMdd: { title: 'MDD (최대 낙폭)', desc: '기간 중 고점에서 저점까지 가장 크게 하락한 비율입니다. 입금 효과를 제거한 시간가중(TWR) 기준이라 적립식에서도 전략 자체의 하락폭을 보여줍니다.', formula: '최소(TWR ÷ 직전 최고 TWR − 1)', guide: '-20% 이내 방어적 · -30~-50% 주식형 일반 · -50% 초과는 회복에 오랜 시간이 필요합니다(-50%는 +100%가 되어야 원금).' },
  ffAlpha: { title: '알파 (연환산)', desc: '시장·규모·가치·수익성·투자·모멘텀 6개 팩터로 설명되지 않는 연 초과수익입니다. 달러 기준 수익률로 회귀해 환율 효과를 제외했습니다.', guide: '별표(*~***)가 붙어야 통계적으로 의미가 있습니다. t값 절대값 2 이상이면 우연일 가능성이 낮습니다.' },
  ffMkt: { title: 'MKT 베타 (시장)', desc: '미국 전체 주식시장 초과수익에 대한 민감도입니다.', guide: '1.0 시장과 동일 · 1 초과 시장보다 크게 움직임(레버리지 3배 ≈ 3) · 0 근처 시장과 무관(채권·금) · 음수 반대(인버스).' },
  ffSmb: { title: 'SMB (규모 팩터)', desc: 'Small Minus Big — 소형주가 대형주보다 오를 때 이익을 보는 정도입니다.', guide: '+ 소형주 성향(IWM 등) · − 대형주 성향(나스닥 100·메가캡).' },
  ffHml: { title: 'HML (가치 팩터)', desc: 'High Minus Low — 저평가(가치)주가 성장주보다 오를 때 이익을 보는 정도입니다.', guide: '+ 가치주 성향(배당·금융·에너지) · − 성장주 성향(기술주).' },
  ffRmw: { title: 'RMW (수익성 팩터)', desc: 'Robust Minus Weak — 수익성이 높은 기업이 낮은 기업보다 오를 때 이익을 보는 정도입니다.', guide: '+ 우량·고수익성 기업 성향 · − 적자·저수익 기업 성향.' },
  ffCma: { title: 'CMA (투자 팩터)', desc: 'Conservative Minus Aggressive — 설비투자를 보수적으로 하는 기업이 공격적으로 확장하는 기업보다 오를 때 이익을 보는 정도입니다.', guide: '+ 보수적 기업 성향(필수소비재·유틸리티) · − 공격적 확장 기업 성향(고성장 기술주).' },
  ffMom: { title: 'MOM (모멘텀 팩터)', desc: '최근 12개월(직전 1개월 제외) 많이 오른 주식이 계속 오를 때 이익을 보는 정도입니다 (Carhart 모멘텀).', guide: '+ 추세 추종(SPMO ≈ 0.3) · 0 중립 · − 역추세(낙폭과대주) 성향.' },
  ffR2: { title: 'R² (결정계수)', desc: '6개 팩터가 해당 자산의 일간 수익률 변동을 설명하는 비율입니다.', guide: '0.9↑ 팩터로 거의 설명됨(지수 ETF) · 0.5~0.9 보통 · 0.5 미만이면 개별 요인이 커서 알파·베타 해석을 신중히 하세요.' },
  ffModel: { title: '회귀 모델', desc: 'FF5_MOM: Kenneth R. French 공식 일간 팩터(5팩터 + 모멘텀)로 회귀. PROXY: 팩터 파일이 없을 때 SPY·IWM·SCHD로 만든 대리 3팩터. n은 회귀에 쓰인 거래일 수입니다.', guide: '표준오차는 자기상관·이분산을 보정한 Newey-West 방식입니다.' }
};

/* 지표 설명 말풍선 */
class InfoPopover {
  static el = null;
  static anchor = null;

  static init() {
    // 캡처 단계에서 가로채 정렬 클릭(th onclick)과 겹치지 않게 함
    document.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-info]');
      if (btn) {
        ev.preventDefault();
        ev.stopPropagation();
        if (this.anchor === btn) this.hide(); else this.show(btn);
        return;
      }
      if (this.el && !this.el.contains(ev.target)) this.hide();
    }, true);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') this.hide(); });
    window.addEventListener('resize', () => this.reposition());
    document.addEventListener('scroll', () => this.reposition(), true);
  }

  /** 스크롤/리사이즈 시 버튼을 따라 이동, 버튼이 화면 밖이면 닫기 */
  static reposition() {
    if (!this.el || !this.anchor) return;
    if (!document.body.contains(this.anchor)) { this.hide(); return; }
    const r = this.anchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { this.hide(); return; }
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
    let top = r.bottom + 8;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 8);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  static show(btn) {
    const info = METRIC_INFO[btn.dataset.info];
    if (!info) return;
    this.hide();
    const esc = QuantUtils.escapeHTML;
    const el = document.createElement('div');
    el.id = 'infoPopover';
    el.setAttribute('role', 'tooltip');
    el.className = 'bg-slate-900 border border-emerald-600/60 rounded-xl shadow-2xl p-3 text-[11px] text-slate-300 leading-relaxed space-y-1.5 whitespace-normal';
    el.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <span class="font-bold text-emerald-400 text-xs">${esc(info.title)}</span>
        <button class="text-slate-500 hover:text-slate-200 text-sm leading-none" aria-label="설명 닫기" data-close>×</button>
      </div>
      <p>${esc(info.desc)}</p>
      ${info.formula ? `<p class="font-num text-[10px] bg-slate-950 border border-slate-800 rounded px-2 py-1 text-cyan-300">${esc(info.formula)}</p>` : ''}
      ${info.guide ? `<p class="text-amber-200/90"><span class="font-bold text-amber-400">해석 기준</span> · ${esc(info.guide)}</p>` : ''}`;
    el.querySelector('[data-close]').addEventListener('click', (e) => { e.stopPropagation(); this.hide(); });
    document.body.appendChild(el);
    this.el = el;
    this.anchor = btn;
    this.reposition();
  }

  static hide() {
    if (this.el) this.el.remove();
    this.el = null;
    this.anchor = null;
  }
}

/* 커스텀 믹스 저장소: 모든 변경은 mutate() 를 통해 → 저장 + 렌더 */
class MixStore {
  static KEY = 'quant_custom_mixes_v16';
  static LEGACY_KEYS = ['quant_custom_mixes_v15_0'];
  static FREQS = ['none', 'monthly', 'quarterly', 'semiannual', 'yearly'];
  static FREQ_LABEL = { none: '리밸런싱 안 함', monthly: '매월', quarterly: '분기 (1·4·7·10월)', semiannual: '반기 (1·7월)', yearly: '매년 (1월)' };
  static MAX = 10;
  static list = [];

  static newId() { return 'mix_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  static sanitize(m, usedIds = new Set()) {
    if (!m || typeof m !== 'object') return null;
    const alloc = {};
    if (m.allocations && typeof m.allocations === 'object') {
      for (const [t, w] of Object.entries(m.allocations)) {
        if (!Object.prototype.hasOwnProperty.call(TICKER_UNIVERSE, t)) continue;
        const v = Number(w);
        if (isFinite(v) && v >= 0 && v <= 100) alloc[t] = Math.round(v * 10) / 10;
      }
    }
    let id = (typeof m.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(m.id)) ? m.id : this.newId();
    if (usedIds.has(id)) id = this.newId();
    usedIds.add(id);
    return {
      id,
      name: String(m.name ?? '이름 없는 전략').slice(0, 60) || '이름 없는 전략',
      enabled: m.enabled !== false,
      rebalanceFreq: this.FREQS.includes(m.rebalanceFreq) ? m.rebalanceFreq : 'yearly',
      allocations: alloc
    };
  }

  static load() {
    let raw = null;
    try {
      raw = localStorage.getItem(this.KEY);
      if (!raw) for (const k of this.LEGACY_KEYS) { raw = localStorage.getItem(k); if (raw) break; }
    } catch { raw = null; }
    let arr = [];
    try { arr = raw ? JSON.parse(raw) : []; } catch { arr = []; }
    const used = new Set();
    this.list = (Array.isArray(arr) ? arr : []).map(m => this.sanitize(m, used)).filter(Boolean).slice(0, this.MAX);
    if (this.list.length === 0) {
      this.list = [this.sanitize({ name: '👑 골든 듀오 (SPMO 70 + QQQM 30)', allocations: { SPMO: 70, QQQM: 30 }, rebalanceFreq: 'yearly' })];
    }
    this.save();
  }

  static save() {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.list)); } catch (e) { console.warn('[MixStore] 저장 실패', e); }
  }

  static find(id) { return this.list.find(m => m.id === id) || null; }

  static mutate(fn, { rerender = true } = {}) {
    fn(this.list);
    this.save();
    if (rerender) UIController.renderCustomMixes();
  }
}

class UIController {
  static selectedTickers = ['SPMO', 'QQQM', 'SPY', 'VOO'];
  static chartInstance = null;
  static activeTab = 'portfolio';
  static currentResults = null;
  static currentDates = [];
  static selectedMcTicker = null;
  static sortField = 'score';
  static sortOrder = 'desc';
  static isRunning = false;
  static runToken = 0;
  static autoRunTimer = null;

  /* ------------------------------------------------------------ 초기화 */
  static init() {
    this.setupDateLimits();
    InfoPopover.init();
    MixStore.load();
    this.bindMixEvents();
    this.bindModalEvents();
    this.renderCustomMixes();
    this.onInvestModeChange();
    this.updateActiveChips();
    this.updateFactorBadge();
    this.runBacktest();
  }

  static getCurrentYearMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  static setupDateLimits() {
    const ym = this.getCurrentYearMonth();
    const s = document.getElementById('startMonth'), e = document.getElementById('endMonth');
    if (s) s.max = ym;
    if (e) { e.max = ym; if (!e.value || e.value > ym) e.value = ym; }
  }

  static updateFactorBadge() {
    const badge = document.getElementById('ffDataModeBadge');
    if (!badge) return;
    const meta = FactorData.meta();
    if (meta) {
      badge.textContent = `✅ Kenneth R. French 공식 일간 팩터 (FF5 ~${meta.ffLast}, MOM ~${meta.momLast})`;
      badge.className = 'text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-800 px-2 py-0.5 rounded font-semibold whitespace-nowrap';
    } else {
      badge.textContent = '⚠️ quant_factor_db.js 미로드 — ETF 대리 팩터 모델 사용';
      badge.className = 'text-[10px] bg-amber-950 text-amber-300 border border-amber-800 px-2 py-0.5 rounded font-semibold whitespace-nowrap';
    }
  }

  /* ------------------------------------------------------------ 입력 */
  static toggleBeginnerGuide() {
    const g = document.getElementById('beginnerGuideContent');
    const icon = document.getElementById('guideToggleIcon');
    if (!g) return;
    g.classList.toggle('hidden');
    if (icon) icon.textContent = g.classList.contains('hidden') ? '▼ 열기' : '▲ 접기';
  }

  static onInvestModeChange() {
    const mode = document.getElementById('investMode')?.value || 'dca';
    document.getElementById('panelDCA')?.classList.toggle('hidden', mode !== 'dca');
    document.getElementById('panelLumpSum')?.classList.toggle('hidden', mode !== 'lumpSum');
    document.getElementById('panelDynamicDCA')?.classList.toggle('hidden', mode !== 'dynamicDCA');
  }

  static showMetricInfo(title, desc) {
    ToastNotifier.show(`💡 [${title}]\n${desc}`, 'info');
  }

  static readNumber(id, { min = 0, max = Infinity, fallback = 0, label = '' } = {}) {
    const el = document.getElementById(id);
    const v = Number(el?.value);
    if (!isFinite(v) || v < min || v > max) {
      throw new Error(`${label || id} 값이 올바르지 않습니다 (허용 범위: ${min.toLocaleString()} ~ ${max === Infinity ? '∞' : max.toLocaleString()})`);
    }
    return v ?? fallback;
  }

  static readConfig() {
    const mode = document.getElementById('investMode').value;
    const ic = { mode };
    if (mode === 'dca') ic.monthlyKrw = this.readNumber('monthlyKrw', { min: 10000, max: 1e10, label: '월 적립금' });
    if (mode === 'lumpSum') { ic.lumpSumKrw = this.readNumber('lumpSumKrw', { min: 10000, max: 1e13, label: '초기 거치 원금' }); ic.monthlyKrw = 0; }
    if (mode === 'dynamicDCA') {
      ic.monthlyKrw = this.readNumber('smartMonthlyKrw', { min: 10000, max: 1e10, label: '기본 월 적립금' });
      ic.smartDrop1 = this.readNumber('smartDrop1', { min: 1, max: 90, label: '1차 하락 기준' }) / 100;
      ic.smartMult1 = this.readNumber('smartMult1', { min: 1, max: 10, label: '1차 매수 배율' });
      ic.smartDrop2 = this.readNumber('smartDrop2', { min: 1, max: 95, label: '2차 하락 기준' }) / 100;
      ic.smartMult2 = this.readNumber('smartMult2', { min: 1, max: 20, label: '2차 매수 배율' });
      if (ic.smartDrop2 <= ic.smartDrop1) throw new Error('2차 하락 기준은 1차 하락 기준보다 커야 합니다.');
    }
    return {
      investConfig: ic,
      fxSpread: parseFloat(document.getElementById('fxSpread').value),
      brokerFee: parseFloat(document.getElementById('brokerFee').value),
      taxEnabled: document.getElementById('taxMode').value === 'fifo'
    };
  }

  static setPeriodPreset(key) {
    const s = document.getElementById('startMonth'), e = document.getElementById('endMonth');
    if (!s || !e) return;
    const ym = this.getCurrentYearMonth();
    const [y, m] = ym.split('-');
    e.value = ym;
    const map = { '3y': `${+y - 3}-${m}`, '5y': `${+y - 5}-${m}`, '10y': `${+y - 10}-${m}`, '2000': '2000-01', '2008': '2008-01', 'all': '1985-01' };
    s.value = map[key] || s.value;
    this.onDateChange();
    ToastNotifier.show(`⏱️ 기간 프리셋: ${s.value} ~ ${e.value}`, 'success');
    this.runBacktest();
  }

  static isStaticallyUnavailable(ticker, startMonth) {
    const cfg = TICKER_UNIVERSE[ticker];
    if (!cfg) return true;
    const minDate = cfg.allowBackfill ? (cfg.backfillMinDate || '1985-01') : cfg.inceptDate;
    return startMonth < minDate;
  }

  static onDateChange() {
    const s = document.getElementById('startMonth'), e = document.getElementById('endMonth');
    if (!s || !e) return;
    if (s.value > e.value) e.value = s.value;
    const removed = this.selectedTickers.filter(t => this.isStaticallyUnavailable(t, s.value));
    if (removed.length) {
      this.selectedTickers = this.selectedTickers.filter(t => !removed.includes(t));
      ToastNotifier.show(`⚠️ 시작월(${s.value}) 이전 데이터가 없는 종목을 선택 해제했습니다: ${removed.join(', ')}`, 'info');
    }
    this.updateActiveChips();
    this.renderModalCheckboxes();
    this.renderCustomMixes();
  }

  /* ------------------------------------------------------------ 개별 자산 모달 */
  static toggleModal() {
    const modal = document.getElementById('assetModal');
    if (!modal) return;
    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden')) this.renderModalCheckboxes();
  }

  static bindModalEvents() {
    const grid = document.getElementById('modalCheckboxGrid');
    grid?.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t && t.matches('input[type="checkbox"][data-ticker]')) this.toggleTicker(t.dataset.ticker);
    });
    document.getElementById('activeChips')?.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-remove-ticker]');
      if (b) { this.toggleTicker(b.dataset.removeTicker); this.runBacktest(); }
    });
  }

  static renderModalCheckboxes() {
    const grid = document.getElementById('modalCheckboxGrid');
    if (!grid) return;
    const start = document.getElementById('startMonth')?.value || '2000-01';
    const frag = document.createDocumentFragment();
    for (const [ticker, item] of Object.entries(TICKER_UNIVERSE)) {
      const checked = this.selectedTickers.includes(ticker);
      const minDate = item.allowBackfill ? (item.backfillMinDate || '1985-01') : item.inceptDate;
      const unavailable = start < minDate;
      const label = document.createElement('label');
      label.className = `flex items-center gap-2 p-2 rounded border transition ${unavailable
        ? 'bg-slate-950/50 border-rose-950/60 text-slate-600 opacity-60 cursor-not-allowed'
        : checked ? 'bg-emerald-950/60 border-emerald-500/80 text-emerald-300 cursor-pointer'
        : 'bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-700 cursor-pointer'}`;
      let tag;
      if (unavailable) tag = `<span class="text-[9px] bg-rose-950 text-rose-300 border border-rose-800 px-1 rounded font-bold whitespace-nowrap">🚫 ${QuantUtils.escapeHTML(minDate)}~</span>`;
      else if (start < item.inceptDate) tag = `<span class="text-[9px] bg-cyan-950 text-cyan-300 border border-cyan-800 px-1 rounded font-semibold whitespace-nowrap">합성 (실데이터 ${QuantUtils.escapeHTML(item.inceptDate)}~)</span>`;
      else tag = `<span class="text-[9px] bg-emerald-950 text-emerald-300 border border-emerald-800 px-1 rounded font-semibold whitespace-nowrap">실데이터</span>`;
      label.innerHTML = `
        <input type="checkbox" data-ticker="${QuantUtils.escapeHTML(ticker)}" ${checked ? 'checked' : ''} ${unavailable ? 'disabled' : ''} class="accent-emerald-500 disabled:opacity-30">
        <div class="truncate w-full">
          <div class="flex items-center justify-between gap-1">
            <span class="font-bold ${unavailable ? 'text-slate-500 line-through' : 'text-slate-200'} whitespace-nowrap">${QuantUtils.escapeHTML(ticker)}</span>${tag}
          </div>
          <span class="text-[10px] text-slate-500 truncate block">${QuantUtils.escapeHTML(item.name)}</span>
        </div>`;
      frag.appendChild(label);
    }
    grid.innerHTML = '';
    grid.appendChild(frag);
  }

  static toggleTicker(ticker) {
    const start = document.getElementById('startMonth')?.value || '2000-01';
    if (!this.selectedTickers.includes(ticker) && this.isStaticallyUnavailable(ticker, start)) {
      ToastNotifier.show(`🚫 ${ticker}는 현재 시작월(${start})에서 선택할 수 없습니다.`, 'error');
      this.renderModalCheckboxes();
      return;
    }
    const i = this.selectedTickers.indexOf(ticker);
    if (i > -1) this.selectedTickers.splice(i, 1); else this.selectedTickers.push(ticker);
    this.renderModalCheckboxes();
    this.updateActiveChips();
  }

  static selectAll(status) {
    const start = document.getElementById('startMonth')?.value || '2000-01';
    this.selectedTickers = status ? Object.keys(TICKER_UNIVERSE).filter(t => !this.isStaticallyUnavailable(t, start)) : [];
    this.updateActiveChips();
    this.renderModalCheckboxes();
  }

  static resetDefaults() {
    const start = document.getElementById('startMonth')?.value || '2000-01';
    this.selectedTickers = ['SPMO', 'QQQM', 'SPY', 'VOO'].filter(t => !this.isStaticallyUnavailable(t, start));
    this.updateActiveChips();
    this.renderModalCheckboxes();
  }

  static updateActiveChips() {
    const c = document.getElementById('activeChips');
    const cnt = document.getElementById('selectedCount');
    const total = document.getElementById('universeCount');
    if (cnt) cnt.textContent = this.selectedTickers.length;
    if (total) total.textContent = Object.keys(TICKER_UNIVERSE).length;
    if (!c) return;
    if (this.selectedTickers.length === 0) {
      c.innerHTML = '<span class="text-xs text-slate-500">선택된 개별 자산이 없습니다. (믹스 전략만으로 실행할 수 있습니다.)</span>';
      return;
    }
    c.innerHTML = this.selectedTickers.map(t => `
      <div class="inline-flex items-center gap-1 bg-emerald-950/80 border border-emerald-600/50 text-emerald-300 text-xs px-2 py-0.5 rounded whitespace-nowrap">
        <span class="font-bold">${QuantUtils.escapeHTML(t)}</span>
        <button data-remove-ticker="${QuantUtils.escapeHTML(t)}" aria-label="${QuantUtils.escapeHTML(t)} 제거" class="hover:text-rose-400 ml-1">×</button>
      </div>`).join('');
  }

  /* ------------------------------------------------------------ 커스텀 믹스 */
  static scheduleAutoRun() {
    clearTimeout(this.autoRunTimer);
    this.autoRunTimer = setTimeout(() => this.runBacktest(), 600);
  }

  static bindMixEvents() {
    const box = document.getElementById('customMixList');
    if (!box) return;
    box.addEventListener('change', (ev) => {
      const el = ev.target;
      const card = el.closest('[data-mix-id]');
      if (!card) return;
      const id = card.dataset.mixId;
      const act = el.dataset.act;
      if (act === 'name') MixStore.mutate(() => { const m = MixStore.find(id); if (m) m.name = el.value.trim().slice(0, 60) || '이름 없는 전략'; }, { rerender: false });
      else if (act === 'enabled') { MixStore.mutate(() => { const m = MixStore.find(id); if (m) m.enabled = el.checked; }); this.scheduleAutoRun(); }
      else if (act === 'freq') { MixStore.mutate(() => { const m = MixStore.find(id); if (m && MixStore.FREQS.includes(el.value)) m.rebalanceFreq = el.value; }); this.scheduleAutoRun(); }
      else if (act === 'weight') {
        const t = el.dataset.ticker;
        const v = Math.max(0, Math.min(100, Number(el.value) || 0));
        MixStore.mutate(() => { const m = MixStore.find(id); if (m && t in m.allocations) m.allocations[t] = Math.round(v * 10) / 10; }, { rerender: false });
        el.value = MixStore.find(id)?.allocations[t] ?? 0;
        this.updateMixSumLabel(card, MixStore.find(id));
        this.scheduleAutoRun();
      }
    });
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-act]');
      if (!b) return;
      const card = b.closest('[data-mix-id]');
      if (!card) return;
      const id = card.dataset.mixId;
      const act = b.dataset.act;
      if (act === 'delete') { MixStore.mutate(list => { const i = list.findIndex(m => m.id === id); if (i >= 0) list.splice(i, 1); }); this.scheduleAutoRun(); }
      else if (act === 'normalize') this.autoNormalizeMixWeights(id);
      else if (act === 'remove-asset') { const t = b.dataset.ticker; MixStore.mutate(() => { const m = MixStore.find(id); if (m) delete m.allocations[t]; }); this.scheduleAutoRun(); }
      else if (act === 'add-asset') {
        const sel = card.querySelector('select[data-act="add-select"]');
        const t = sel?.value;
        if (!t || !TICKER_UNIVERSE[t]) return;
        MixStore.mutate(() => { const m = MixStore.find(id); if (m && !(t in m.allocations)) m.allocations[t] = 0; });
      }
    });
  }

  static renderCustomMixes() {
    const box = document.getElementById('customMixList');
    if (!box) return;
    const start = document.getElementById('startMonth')?.value || '2000-01';
    const esc = QuantUtils.escapeHTML;
    box.innerHTML = MixStore.list.map(mix => {
      let total = 0;
      Object.values(mix.allocations).forEach(w => { total += Number(w) || 0; });
      const okSum = Math.abs(total - 100) < 0.05;
      const rows = Object.entries(mix.allocations).map(([t, w]) => {
        const bad = this.isStaticallyUnavailable(t, start);
        return `
        <div class="flex items-center gap-2 bg-slate-900 px-2.5 py-1.5 rounded border ${bad ? 'border-rose-800' : 'border-slate-800'} text-xs">
          <span class="font-bold ${bad ? 'text-rose-400' : 'text-slate-200'} w-24 truncate" title="${esc(TICKER_UNIVERSE[t]?.name || t)}">${esc(t)}</span>
          <input type="number" data-act="weight" data-ticker="${esc(t)}" value="${esc(w)}" min="0" max="100" step="5" aria-label="${esc(t)} 비중" class="w-16 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-center text-amber-300 font-bold">
          <span class="text-slate-400">%</span>
          <button data-act="remove-asset" data-ticker="${esc(t)}" class="text-rose-400 hover:text-rose-300 font-bold ml-auto px-1" title="종목 삭제" aria-label="${esc(t)} 삭제">×</button>
        </div>`;
      }).join('');
      const addOpts = Object.keys(TICKER_UNIVERSE).filter(t => !(t in mix.allocations))
        .map(t => `<option value="${esc(t)}">${esc(t)} (${esc(TICKER_UNIVERSE[t].name)})</option>`).join('');
      const freqOpts = MixStore.FREQS.map(f => `<option value="${f}" ${mix.rebalanceFreq === f ? 'selected' : ''}>${esc(MixStore.FREQ_LABEL[f])}</option>`).join('');
      return `
      <div data-mix-id="${esc(mix.id)}" class="bg-slate-950 p-3.5 rounded-lg border border-slate-800 space-y-3">
        <div class="flex items-center justify-between gap-2 flex-wrap pb-1 border-b border-slate-800/60">
          <div class="flex items-center gap-2 flex-wrap">
            <input type="checkbox" data-act="enabled" ${mix.enabled ? 'checked' : ''} aria-label="전략 활성화" class="accent-amber-500 w-4 h-4 cursor-pointer">
            <input type="text" data-act="name" value="${esc(mix.name)}" maxlength="60" aria-label="전략 이름" class="bg-transparent font-bold text-xs text-amber-400 border-b border-dashed border-slate-700 focus:border-amber-400 focus:outline-none px-1 py-0.5 w-48 sm:w-60">
            <label class="text-[11px] text-slate-400 flex items-center gap-1">리밸런싱
              <select data-act="freq" class="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-cyan-300 font-bold">${freqOpts}</select>
            </label>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <span data-role="sum" class="text-xs font-bold ${okSum ? 'text-emerald-400' : 'text-rose-400'}">비중 합: ${Math.round(total * 10) / 10}%${okSum ? '' : ' (실행 시 비율대로 환산)'}</span>
            <button data-act="normalize" class="bg-amber-950/80 hover:bg-amber-900 text-amber-300 border border-amber-700/60 text-[11px] font-bold px-2 py-0.5 rounded transition whitespace-nowrap">⚡ 100% 맞춤</button>
            <button data-act="delete" class="text-slate-500 hover:text-rose-400 text-xs font-bold px-1.5 py-0.5">삭제</button>
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">${rows || '<span class="text-[11px] text-slate-500">종목을 추가하세요.</span>'}</div>
        <div class="flex items-center gap-2 pt-1 flex-wrap">
          <select data-act="add-select" aria-label="추가할 종목" class="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 max-w-full">${addOpts}</select>
          <button data-act="add-asset" class="bg-slate-800 hover:bg-slate-700 text-xs text-amber-300 px-2.5 py-1 rounded border border-slate-700 font-bold">+ 종목 추가</button>
        </div>
      </div>`;
    }).join('');
  }

  static updateMixSumLabel(card, mix) {
    const el = card?.querySelector('[data-role="sum"]');
    if (!el || !mix) return;
    let total = 0;
    Object.values(mix.allocations).forEach(w => { total += Number(w) || 0; });
    const ok = Math.abs(total - 100) < 0.05;
    el.className = `text-xs font-bold ${ok ? 'text-emerald-400' : 'text-rose-400'}`;
    el.textContent = `비중 합: ${Math.round(total * 10) / 10}%${ok ? '' : ' (실행 시 비율대로 환산)'}`;
  }

  static addNewMixStrategy() {
    if (MixStore.list.length >= MixStore.MAX) { ToastNotifier.show(`커스텀 믹스는 최대 ${MixStore.MAX}개까지 추가할 수 있습니다.`, 'warning'); return; }
    MixStore.mutate(list => list.push(MixStore.sanitize({ name: `새 커스텀 전략 ${list.length + 1}`, allocations: { SPY: 50, QQQM: 50 }, rebalanceFreq: 'yearly' }, new Set(list.map(m => m.id)))));
    this.scheduleAutoRun();
  }

  static autoNormalizeMixWeights(id) {
    const mix = MixStore.find(id);
    if (!mix) return;
    const ts = Object.keys(mix.allocations);
    let total = 0;
    ts.forEach(t => { total += Number(mix.allocations[t]) || 0; });
    if (total <= 0) return;
    MixStore.mutate(() => {
      let acc = 0;
      ts.forEach((t, i) => {
        if (i === ts.length - 1) mix.allocations[t] = Math.round((100 - acc) * 10) / 10;
        else { const w = Math.round((mix.allocations[t] / total) * 1000) / 10; mix.allocations[t] = w; acc += w; }
      });
    });
    ToastNotifier.show(`⚡ [${mix.name}] 비중 합계를 100%로 맞췄습니다.`, 'success');
    this.scheduleAutoRun();
  }

  static exportStrategies() {
    const blob = new Blob([JSON.stringify(MixStore.list, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `custom_mix_strategies_${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    ToastNotifier.show('전략 설정 파일을 저장했습니다.', 'success');
  }

  static importStrategies(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 512 * 1024) { ToastNotifier.show('파일이 너무 큽니다 (최대 512KB).', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!Array.isArray(data)) throw new Error('배열 형식이 아님');
        const used = new Set();
        const clean = data.map(m => MixStore.sanitize(m, used)).filter(m => m && Object.keys(m.allocations).length > 0).slice(0, MixStore.MAX);
        if (clean.length === 0) throw new Error('유효한 전략 없음');
        MixStore.mutate(list => { list.splice(0, list.length, ...clean); });
        const dropped = data.length - clean.length;
        ToastNotifier.show(`전략 ${clean.length}개를 불러왔습니다.${dropped > 0 ? `\n(유효하지 않거나 알 수 없는 종목만 있는 ${dropped}개 제외)` : ''}`, 'success');
        this.runBacktest();
      } catch (err) {
        ToastNotifier.show(`전략 파일 형식이 올바르지 않습니다: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------ AI 최적화 */
  static async openAIOptimizerModal() {
    document.getElementById('aiOptimizerModal')?.classList.remove('hidden');
    await this.runAIOptimizer();
  }

  static closeAIOptimizerModal() {
    document.getElementById('aiOptimizerModal')?.classList.add('hidden');
  }

  static async runAIOptimizer() {
    const loading = document.getElementById('aiOptLoading');
    const box = document.getElementById('aiOptResults');
    const sub = document.getElementById('aiOptimizerSubtitle');
    const loadMsg = document.getElementById('aiOptLoadingMsg');
    const startMonth = document.getElementById('startMonth').value;
    const endMonth = document.getElementById('endMonth').value;
    let config;
    try { config = this.readConfig(); } catch (err) { ToastNotifier.show(err.message, 'error'); return; }
    const universeType = document.getElementById('aiOptUniverseSelect')?.value || 'all';
    const rebalanceFreq = document.getElementById('aiOptRebalanceSelect')?.value || 'yearly';
    const excludeSynthetic = !!document.getElementById('aiOptExcludeSynth')?.checked;
    loading?.classList.remove('hidden');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    if (sub) sub.textContent = `검증 구간: ${startMonth} ~ ${endMonth} — 전수 조사 중...`;
    let res;
    try {
      res = await PortfolioOptimizerEngine.optimize({
        startMonth, endMonth, universeType, selectedTickers: this.selectedTickers, rebalanceFreq, excludeSynthetic, config,
        onProgress: (v, msg) => { if (loadMsg) loadMsg.textContent = `${msg} (${Math.round(v * 100)}%)`; }
      });
    } catch (err) {
      console.error(err);
      res = { error: err.message || String(err) };
    }
    loading?.classList.add('hidden');
    if (!box) return;
    box.classList.remove('hidden');
    if (res.error) {
      box.innerHTML = `<div class="p-6 text-center text-slate-400">${QuantUtils.escapeHTML(res.error)}</div>`;
      return;
    }
    const esc = QuantUtils.escapeHTML;
    if (sub) {
      sub.innerHTML = `학습 구간 <span class="text-emerald-400 font-bold">${esc(res.trainRange[0])} ~ ${esc(res.trainRange[1])}</span>`
        + (res.testRange ? ` · 검증(표본 외) <span class="text-cyan-400 font-bold">${esc(res.testRange[0])} ~ ${esc(res.testRange[1])}</span>` : ' · (4년 미만: 검증 구간 없음)')
        + ` · 스크리닝 <span class="text-amber-400 font-bold">${res.totalEvaluated.toLocaleString()}</span>개 → 실제 엔진 재채점 ${res.realEvaluated}개 · 대상 ${res.validCount}종목`;
    }
    const fmtPct = (v, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
    const card = (title, icon, badge, d, best = false) => {
      if (!d) return '';
      const alloc = Object.entries(d.allocations).sort((a, b) => b[1] - a[1]);
      const payload = encodeURIComponent(JSON.stringify({ a: d.allocations, n: title, f: rebalanceFreq }));
      const testHtml = d.test ? `
        <div class="grid grid-cols-3 gap-2 text-[11px] bg-cyan-950/30 border border-cyan-900/60 rounded p-2">
          <div><span class="text-slate-500 block text-[10px]">표본 외 CAGR</span><span class="font-bold font-num ${d.test.cagr >= 0 ? 'text-cyan-300' : 'text-rose-300'}">${fmtPct(d.test.cagr)}</span></div>
          <div><span class="text-slate-500 block text-[10px]">표본 외 MDD</span><span class="font-bold font-num text-rose-300">-${d.test.mdd.toFixed(1)}%</span></div>
          <div><span class="text-slate-500 block text-[10px]">표본 외 샤프</span><span class="font-bold font-num text-amber-300">${d.test.sharpe.toFixed(2)}</span></div>
        </div>` : '';
      return `
      <div class="bg-slate-950/80 border ${best ? 'border-amber-500/80' : 'border-slate-800'} rounded-xl p-3.5 space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-2 flex-wrap">
            <span>${icon}</span>
            <h4 class="font-bold text-xs ${best ? 'text-amber-400' : 'text-slate-200'}">${esc(title)}</h4>
            <span class="text-[10px] ${badge} px-2 py-0.5 rounded font-bold whitespace-nowrap">학습구간 점수 ${d.score}점</span>
            ${d.synthShare > 0.001 ? `<span class="text-[10px] bg-cyan-950 text-cyan-300 border border-cyan-800 px-1.5 py-0.5 rounded">합성데이터 비중 ${(d.synthShare * 100).toFixed(0)}%</span>` : ''}
          </div>
          <button data-apply="${payload}" class="bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-slate-950 font-bold text-xs px-3.5 py-1.5 rounded-lg transition whitespace-nowrap">✨ 새 믹스로 추가</button>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap">${alloc.map(([t, w]) => `<span class="inline-flex items-center gap-1 bg-slate-900 border border-slate-700 px-2 py-0.5 rounded text-xs"><strong class="text-slate-100">${esc(t)}</strong><span class="text-amber-400 font-bold font-num">${w}%</span></span>`).join('')}</div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <div class="bg-slate-900/60 p-2 rounded border border-slate-800/80"><span class="text-slate-500 block text-[10px]">${res.isDCA ? '학습 XIRR (적립식)' : '학습 CAGR'}</span><span class="font-bold text-cyan-400 font-num">${fmtPct(res.isDCA ? d.xirr : d.cagr)}</span></div>
          <div class="bg-slate-900/60 p-2 rounded border border-slate-800/80"><span class="text-slate-500 block text-[10px]">학습 MDD</span><span class="font-bold text-rose-400 font-num">-${d.mdd.toFixed(1)}%</span></div>
          <div class="bg-slate-900/60 p-2 rounded border border-slate-800/80"><span class="text-slate-500 block text-[10px]">샤프</span><span class="font-bold text-amber-300 font-num">${d.sharpe.toFixed(2)}</span></div>
          <div class="bg-slate-900/60 p-2 rounded border border-slate-800/80"><span class="text-slate-500 block text-[10px]">소티노</span><span class="font-bold text-emerald-400 font-num">${d.sortino.toFixed(2)}</span></div>
        </div>
        ${testHtml}
      </div>`;
    };
    const ch = res.champions;
    box.innerHTML = `
      <div class="bg-amber-950/40 border border-amber-800/60 rounded-lg p-2.5 text-[11px] text-amber-200 leading-relaxed">
        ⚠️ 과거 데이터에서 가장 좋았던 조합을 고르는 방식이라 <b>과최적화(데이터 스누핑)</b> 위험이 큽니다. 학습 구간 성과보다 <b>표본 외(검증) 성과</b>를 중시하고, 종목 목록 자체의 생존 편향(현재 살아남은 대형주)도 감안하세요.
      </div>
      ${card('최고 종합점수 전략', '👑', 'bg-amber-950 text-amber-300 border border-amber-700', ch.bestScore, true)}
      ${card('최대 샤프 지수 전략', '📈', 'bg-emerald-950 text-emerald-300 border border-emerald-700', ch.maxSharpe)}
      ${card('최저 낙폭(MDD) 전략', '🛡️', 'bg-purple-950 text-purple-300 border border-purple-700', ch.minMDD)}
      ${card('최고 수익률 전략', '🔥', 'bg-cyan-950 text-cyan-300 border border-cyan-700', ch.maxReturn)}`;
    box.querySelectorAll('button[data-apply]').forEach(b => b.addEventListener('click', () => {
      try {
        const p = JSON.parse(decodeURIComponent(b.dataset.apply));
        this.applyOptimalMix(p.a, `[AI] ${p.n} (${startMonth}~${endMonth})`, p.f);
      } catch { ToastNotifier.show('적용 중 오류가 발생했습니다.', 'error'); }
    }));
  }

  static applyOptimalMix(allocMap, name, freq) {
    if (MixStore.list.length >= MixStore.MAX) { ToastNotifier.show(`믹스가 이미 ${MixStore.MAX}개입니다. 하나를 삭제한 뒤 다시 시도하세요.`, 'warning'); return; }
    const m = MixStore.sanitize({ name, allocations: allocMap, rebalanceFreq: freq }, new Set(MixStore.list.map(x => x.id)));
    MixStore.mutate(list => list.push(m));
    this.closeAIOptimizerModal();
    ToastNotifier.show(`'${m.name}'을(를) 새 믹스로 추가했습니다.`, 'success');
    this.runBacktest();
  }

  /* ------------------------------------------------------------ 진행 상태 */
  static setProgress(pct, label) {
    const c = document.getElementById('progressContainer');
    const bar = document.getElementById('progressBar');
    const pp = document.getElementById('progressPercent');
    const pl = document.getElementById('progressLabel');
    if (!c) return;
    c.classList.remove('hidden');
    bar.style.width = `${Math.min(100, pct)}%`;
    pp.textContent = `${Math.round(Math.min(100, pct))}%`;
    if (label) pl.textContent = label;
    if (pct >= 100) setTimeout(() => c.classList.add('hidden'), 500);
  }

  static setEngineStatus(state, text) {
    const dot = document.getElementById('statusDot');
    document.getElementById('statusText').textContent = text;
    dot.className = state === 'loading' ? 'w-2 h-2 rounded-full bg-amber-400 animate-ping'
      : state === 'success' ? 'w-2 h-2 rounded-full bg-emerald-400' : 'w-2 h-2 rounded-full bg-rose-500';
  }

  /* ------------------------------------------------------------ 백테스트 실행 */
  static async runBacktest() {
    const token = ++this.runToken;
    const btn = document.getElementById('runBtn');
    try {
      const startMonth = document.getElementById('startMonth').value;
      const endMonth = document.getElementById('endMonth').value;
      const currentYM = this.getCurrentYearMonth();
      if (endMonth > currentYM) { document.getElementById('endMonth').value = currentYM; throw new Error(`종료 월은 현재 월(${currentYM})을 넘을 수 없습니다.`); }
      if (!startMonth || !endMonth || startMonth > endMonth) throw new Error('종료 월은 시작 월과 같거나 이후여야 합니다.');
      const config = this.readConfig();
      if (btn) btn.disabled = true;

      const notices = [];
      const selected = this.selectedTickers.slice();
      const invalidSel = selected.filter(t => this.isStaticallyUnavailable(t, startMonth));
      if (invalidSel.length) {
        this.setEngineStatus('error', '실행 중단');
        ToastNotifier.show(`🚫 선택 기간 시작(${startMonth}) 이전 데이터가 없는 종목이 있습니다:\n${invalidSel.map(t => `• ${t} (${TICKER_UNIVERSE[t].allowBackfill ? TICKER_UNIVERSE[t].backfillMinDate : TICKER_UNIVERSE[t].inceptDate}~)`).join('\n')}`, 'error');
        return;
      }
      const enabled = MixStore.list.filter(m => m.enabled && Object.values(m.allocations).some(w => w > 0));
      const mixes = [];
      enabled.forEach(m => {
        const bad = Object.keys(m.allocations).filter(t => m.allocations[t] > 0 && this.isStaticallyUnavailable(t, startMonth));
        if (bad.length) notices.push({ type: 'warning', text: `믹스 [${m.name}] 제외: ${bad.join(', ')} 종목이 ${startMonth} 시점에 데이터가 없습니다.` });
        else mixes.push(m);
      });
      if (selected.length === 0 && mixes.length === 0) {
        document.getElementById('summaryCards').innerHTML = '';
        document.getElementById('summaryTableBody').innerHTML = '<tr><td colspan="17" class="px-4 py-6 text-center text-rose-400">분석할 개별 자산이나 활성화된 믹스 전략을 선택하세요.</td></tr>';
        this.renderNotices(notices);
        return;
      }

      const strategyAssets = Array.from(new Set([...selected, ...mixes.flatMap(m => Object.keys(m.allocations).filter(t => m.allocations[t] > 0))]));
      const required = strategyAssets.concat(['SPY'], FactorData.available() ? [] : ['IWM', 'SCHD']);
      const startYear = parseInt(startMonth.substring(0, 4), 10);
      const curYear = new Date().getFullYear();

      this.setEngineStatus('loading', '시세 수신 중...');
      this.setProgress(5, '시세 수신 중...');
      const loaded = await DataPipeline.load(required, startYear, curYear, { onProgress: v => this.setProgress(5 + v * 40, '시세 수신 중...') });
      if (token !== this.runToken) return;

      const { dates, calendar } = CalendarBuilder.build(loaded.raw, strategyAssets.filter(k => loaded.raw[k]), `${startMonth}-01`);
      const e = QuantUtils.lastIndexLE(dates, `${endMonth}-31`);
      if (dates.length === 0 || e < 20) throw new Error('지정한 기간에 시세 데이터가 부족합니다 (최소 약 1개월 이상).');
      this.setProgress(50, '백필 합성 중...');
      const processed = MultiFactorSynthesisEngine.process(loaded.raw, dates);
      const s = 0;

      // 런타임 가용성 검사 (실제 로딩된 데이터 기준)
      const selMissing = DataAvailability.check(selected, processed, dates, s);
      if (selMissing.length) {
        this.setEngineStatus('error', '실행 중단');
        ToastNotifier.show(`🚫 다음 종목은 ${dates[s]} 시점에 데이터가 없어 실행할 수 없습니다:\n${selMissing.map(m => `• ${m.ticker}: ${m.reason}`).join('\n')}`, 'error');
        return;
      }
      const okMixes = mixes.filter(m => {
        const miss = DataAvailability.check(Object.keys(m.allocations).filter(t => m.allocations[t] > 0), processed, dates, s);
        if (miss.length) notices.push({ type: 'warning', text: `믹스 [${m.name}] 제외: ${miss.map(x => `${x.ticker}(${x.reason})`).join(', ')}` });
        return miss.length === 0;
      });

      const ctx = BacktestRunner.buildContext(dates, processed, loaded.fx, s, e);
      const periodMonths = QuantScoreEngine.calculatePeriodMonths(startMonth, endMonth);
      const specs = selected.map(t => ({ key: t, name: TICKER_UNIVERSE[t]?.name || t, allocations: { [t]: 100 }, rebalanceFreq: 'none', isMix: false }));
      const usedKeys = new Set(specs.map(sp => sp.key));
      okMixes.forEach(m => {
        let key = `[MIX] ${m.name}`, n = 2;
        while (usedKeys.has(key)) key = `[MIX] ${m.name} #${n++}`;
        usedKeys.add(key);
        const alloc = {};
        Object.entries(m.allocations).forEach(([t, w]) => { if (w > 0) alloc[t] = w; });
        specs.push({ key, name: m.name, allocations: alloc, rebalanceFreq: m.rebalanceFreq, isMix: true });
      });

      this.setEngineStatus('loading', '시뮬레이션 중...');
      const results = await BacktestRunner.runAll(specs, ctx, config, periodMonths, v => this.setProgress(55 + v * 45, `시뮬레이션 (${Math.round(v * 100)}%)`));
      if (token !== this.runToken) return;

      this.collectNotices(notices, { loaded, processed, ctx, strategyAssets, calendar, config, s, e });
      this.currentResults = results;
      this.currentDates = dates.slice(s, e + 1);
      this.currentConfig = config;
      this.renderNotices(notices);
      this.renderDashboard(results, config.taxEnabled);
      this.setProgress(100, '완료');
      this.setEngineStatus('success', `완료 · ${this.currentDates[0]} ~ ${this.currentDates[this.currentDates.length - 1]}`);
    } catch (err) {
      console.error('Backtest failed:', err);
      this.setEngineStatus('error', '오류');
      this.setProgress(100, '실패');
      ToastNotifier.show(`⚠️ ${err.message || err}`, 'error');
    } finally {
      if (btn && token === this.runToken) btn.disabled = false;
    }
  }

  static collectNotices(notices, { loaded, processed, ctx, strategyAssets, calendar, config, s, e }) {
    const relevant = new Set(DataPipeline.expandRequired(strategyAssets));
    const failed = loaded.failed.filter(k => relevant.has(k));
    if (failed.length) notices.push({ type: 'error', text: `시세 수신 실패: ${failed.join(', ')} — 해당 자산에 의존하는 합성 구간은 생성되지 않았습니다.` });
    strategyAssets.forEach(k => {
      const si = processed.synthInfo[k];
      if (!si || si.realIdx <= s) return;
      const to = ctx.dates[Math.min(e, si.realIdx)];
      let detail = si.label;
      if (si.method === 'factor') {
        detail += si.calibrated
          ? ` · 회귀 R²=${si.r2.toFixed(2)}, 베타=[${si.betas.map(b => b.toFixed(2)).join(', ')}], 실측 알파 연 ${(si.alphaAnnExcluded * 100).toFixed(1)}%는 제외(보수적), 잔차 부트스트랩(시드 고정)`
          : ' · 겹치는 실제 데이터 부족 → 기본 베타 사용';
      } else if (si.method === 'bond_duration') {
        detail += ` · 보정 R²=${(si.r2 || 0).toFixed(2)}`;
      }
      notices.push({ type: 'info', text: `[합성] ${k}: ${ctx.dates[s]} ~ ${to} 구간은 추정치 — ${detail}` });
    });
    // 시세 기준일 / 최근 구간 보충 결과
    const dbLast = (typeof EMBEDDED_OFFLINE_MARKET_DB !== 'undefined' && EMBEDDED_OFFLINE_MARKET_DB.meta?.lastDate) || null;
    const series = strategyAssets.concat(['SPY']).map(k => loaded.raw[k]).filter(Boolean).concat(loaded.fx ? [loaded.fx] : []);
    const added = strategyAssets.filter(k => loaded.raw[k]?.tailAdded > 0);
    const tailFailed = strategyAssets.filter(k => loaded.raw[k]?.tailFailed);
    if (loaded.fx?.tailFailed) tailFailed.push('USD/KRW 환율');
    const asOfs = series.map(r => r.asOf).filter(Boolean).sort();
    const asOf = asOfs.length ? asOfs[0] : ctx.dates[e];
    if (tailFailed.length) notices.push({ type: 'warning', text: `최근 시세 보충 실패: ${tailFailed.join(', ')} — 오프라인 DB 기준일(${dbLast || asOf})까지만 반영했습니다. 잠시 후 다시 실행하거나 GitHub Actions 주간 갱신을 기다리세요.` });
    else if (added.length) notices.push({ type: 'info', text: `시세 기준일 ${asOf} — 오프라인 DB(${dbLast || '-'}) 이후 최근 거래일을 Yahoo에서 자동 보충했습니다.` });
    else notices.push({ type: 'info', text: `시세 기준일 ${asOf}${dbLast ? ` (오프라인 DB 생성 기준 ${dbLast})` : ''}` });
    const fm = FactorData.meta();
    if (fm && fm.ffLast < ctx.dates[e]) notices.push({ type: 'info', text: `Fama-French 팩터는 원본 공개 주기상 ${fm.ffLast}까지만 있습니다 — 이후 구간은 요인 회귀에서 제외되고, 무위험금리는 마지막 값을 사용합니다.` });
    const fxAssets = strategyAssets.some(k => !QuantUtils.isDomestic(k));
    if (fxAssets && ctx.fxMissing) notices.push({ type: 'error', text: 'USD/KRW 환율 데이터를 불러오지 못해 근사 환율로 계산했습니다. 결과 신뢰도가 낮습니다.' });
    else if (fxAssets && ctx.fxApprox) notices.push({ type: 'info', text: `환율: ${ctx.firstFxDate || '2003-12'} 이전은 한국은행 월평균 기반 근사치(선형보간, ±3%)를 사용합니다.` });
    strategyAssets.forEach(k => { if (loaded.raw[k]?.divsMissing) notices.push({ type: 'warning', text: `${k}: 배당 데이터를 받지 못해 배당 재투자가 누락되었습니다 (API: ${loaded.raw[k].source}).` }); });
    if (!FactorData.available()) notices.push({ type: 'warning', text: 'quant_factor_db.js 가 없어 SPMO/IWM 팩터 백필, 공식 Fama-French 회귀, 실측 무위험금리를 사용할 수 없습니다.' });
    if (calendar === 'KR') notices.push({ type: 'info', text: '모든 자산이 국내 자산이므로 한국 거래일 달력으로 계산했습니다.' });
    if (config.taxEnabled) notices.push({ type: 'info', text: '세후 모드: 배당 원천징수(미국 15% / 국내 15.4%), 해외자산 양도세(FIFO·연 250만 공제·절세 재매수), 최종 청산 시 수수료·거래세·환전비용·양도세를 반영했습니다.' });
  }

  static renderNotices(notices) {
    const box = document.getElementById('dataNotices');
    if (!box) return;
    if (!notices.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    const color = { error: 'text-rose-300', warning: 'text-amber-300', info: 'text-slate-300' };
    const icon = { error: '⛔', warning: '⚠️', info: 'ℹ️' };
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="flex items-center justify-between mb-1.5">
        <span class="font-bold text-slate-200 text-xs">📌 데이터 및 계산 방식 안내 (${notices.length})</span>
        <button id="closeNoticesBtn" class="text-slate-400 hover:text-slate-100 text-sm px-1" aria-label="안내 닫기">×</button>
      </div>
      <ul class="space-y-1">${notices.map(n => `<li class="${color[n.type] || 'text-slate-300'} leading-relaxed">${icon[n.type] || ''} ${QuantUtils.escapeHTML(n.text)}</li>`).join('')}</ul>`;
    document.getElementById('closeNoticesBtn')?.addEventListener('click', () => box.classList.add('hidden'));
  }

  /* ------------------------------------------------------------ 대시보드 */
  static renderDashboard(results, taxEnabled) {
    const esc = QuantUtils.escapeHTML;
    const th = document.getElementById('thFinalValLabel');
    if (th) th.textContent = taxEnabled ? '세후 청산 평가금' : '세전 평가금';
    const list = Object.values(results);
    const cards = document.getElementById('summaryCards');
    const first = list[0];
    const palette = ['#34d399', '#60a5fa', '#f87171', '#c084fc', '#fb923c', '#38bdf8'];
    const top = list.slice().sort((a, b) => b.score - a.score).slice(0, 3);
    cards.innerHTML = `
      <div class="bg-slate-900 p-3.5 sm:p-4 rounded-xl border border-slate-800 flex flex-col justify-between">
        <div><span class="text-xs text-slate-400 font-semibold block">총 투입 원금</span>
        <div class="text-lg sm:text-xl font-bold mt-1 text-slate-100">${QuantUtils.formatKRW(first.investedKrw)}</div></div>
        <div class="text-[11px] text-slate-500 mt-2">검증 기간: ${esc(this.currentDates[0])} ~ ${esc(this.currentDates[this.currentDates.length - 1])}</div>
      </div>` + top.map((r, i) => `
      <div class="bg-slate-900 p-3.5 sm:p-4 rounded-xl border border-slate-800 flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-xs font-bold truncate ${r.isMix ? 'text-amber-400' : 'text-slate-200'}" title="${esc(r.ticker)}">${i === 0 ? '🏆 ' : ''}${esc(r.ticker)}</span>
            <span class="shrink-0 text-[10px] bg-amber-500/20 text-amber-300 font-bold px-1.5 py-0.5 rounded border border-amber-500/30">${r.score}점</span>
          </div>
          <div class="text-base sm:text-lg font-bold mt-1 flex items-baseline gap-1.5 flex-wrap" style="color:${r.isMix ? '#f59e0b' : palette[i % palette.length]}">
            <span>${QuantUtils.formatKRW(r.finalVal)}</span>
            <span class="text-xs font-normal text-slate-300">(${r.cumulativeReturn >= 0 ? '+' : ''}${r.cumulativeReturn.toFixed(1)}%)</span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] mt-3 pt-2.5 border-t border-slate-800">
          <span class="text-cyan-400 font-semibold">XIRR: ${r.annualizedXIRR >= 0 ? '+' : ''}${r.annualizedXIRR.toFixed(1)}%</span>
          <span class="text-amber-400 font-semibold">소티노: ${r.sortino.toFixed(2)}</span>
          <span class="text-rose-400 font-semibold">MDD: ${r.twrMdd.toFixed(1)}%</span>
          <span class="text-rose-300 font-semibold">Ulcer: ${r.ulcerIndex.toFixed(1)}</span>
        </div>
      </div>`).join('');

    this.renderFFTable(results);
    this.renderSummaryTableBody(results);
    const tickers = Object.keys(results);
    ['heatmapTickerSelect', 'scoreTickerSelect'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = tickers.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
      if (tickers.includes(prev)) sel.value = prev;
    });
    if (!this.selectedMcTicker || !tickers.includes(this.selectedMcTicker)) this.selectedMcTicker = tickers[0];
    this.switchChartTab(this.activeTab);
  }

  static fmtFactor(d, isAlpha = false) {
    if (!d) return '<span class="text-slate-600">-</span>';
    const v = isAlpha ? `${d.beta >= 0 ? '+' : ''}${d.beta.toFixed(2)}%` : d.beta.toFixed(2);
    const t = isFinite(d.tStat) ? `<span class="text-[10px] text-slate-500 ml-1">t=${d.tStat.toFixed(1)}</span>` : '';
    return `${v}<span class="text-amber-300">${d.stars}</span>${t}`;
  }

  static renderFFTable(results) {
    const body = document.getElementById('ffTableBody');
    const esc = QuantUtils.escapeHTML;
    body.innerHTML = Object.values(results).map(r => {
      const d = r.ff.factorDetails || {};
      return `
      <tr class="hover:bg-slate-800/40 border-b border-slate-800/60 ${r.isMix ? 'bg-amber-950/20' : ''}">
        <td class="px-2.5 py-2.5 font-bold ${r.isMix ? 'text-amber-400' : 'text-slate-200'} sticky left-0 z-10 bg-slate-950 sticky-col-shadow max-w-[125px] sm:max-w-none truncate" title="${esc(r.ticker)}">${esc(r.ticker)}</td>
        <td class="px-3 py-2.5 text-purple-400 font-bold whitespace-nowrap font-num">${this.fmtFactor(d['Alpha'], true)}</td>
        <td class="px-3 py-2.5 text-slate-300 whitespace-nowrap font-num">${this.fmtFactor(d['MKT-RF'])}</td>
        <td class="px-3 py-2.5 text-emerald-400 whitespace-nowrap font-num">${this.fmtFactor(d['SMB'])}</td>
        <td class="px-3 py-2.5 text-amber-400 whitespace-nowrap font-num">${this.fmtFactor(d['HML'])}</td>
        <td class="px-3 py-2.5 text-sky-300 whitespace-nowrap font-num">${this.fmtFactor(d['RMW'])}</td>
        <td class="px-3 py-2.5 text-lime-300 whitespace-nowrap font-num">${this.fmtFactor(d['CMA'])}</td>
        <td class="px-3 py-2.5 text-cyan-400 whitespace-nowrap font-num">${this.fmtFactor(d['MOM'])}</td>
        <td class="px-3 py-2.5 text-slate-400 whitespace-nowrap font-num">${r.ff.rSquared.toFixed(2)}</td>
        <td class="px-3 py-2.5 text-[10px] text-slate-500 whitespace-nowrap">${esc(r.ff.modelType)} · n=${r.ff.nObs}</td>
      </tr>`;
    }).join('');
  }

  static handleSort(field) {
    if (this.sortField === field) this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
    else { this.sortField = field; this.sortOrder = (field === 'twrMdd' || field === 'ticker') ? 'asc' : 'desc'; }
    if (this.currentResults) this.renderSummaryTableBody(this.currentResults);
  }

  static updateSortIcons() {
    document.querySelectorAll('[data-sort-icon]').forEach(sp => {
      sp.textContent = sp.dataset.sortIcon === this.sortField ? (this.sortOrder === 'asc' ? ' ▲' : ' ▼') : '';
    });
  }

  static renderSummaryTableBody(results) {
    const body = document.getElementById('summaryTableBody');
    const esc = QuantUtils.escapeHTML;
    const f = this.sortField, dir = this.sortOrder === 'asc' ? 1 : -1;
    // MDD 는 음수이므로 절대값 기준 정렬(오름차순 = 낙폭 작은 순)
    const val = (r) => f === 'twrMdd' ? Math.abs(r.twrMdd) : r[f];
    const arr = Object.values(results).sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * ((va ?? 0) - (vb ?? 0));
    });
    this.updateSortIcons();
    const start = this.currentDates[0];
    body.innerHTML = arr.map(r => {
      let badge;
      if (r.isMix) badge = `<span class="text-[9px] bg-amber-950 text-amber-300 px-1 py-0.5 rounded border border-amber-700">믹스 · ${esc(MixStore.FREQ_LABEL[r.rebalanceFreq] || r.rebalanceFreq)}</span>`;
      else {
        const cfg = TICKER_UNIVERSE[r.ticker];
        badge = cfg && start < cfg.inceptDate + '-01'
          ? `<span class="text-[9px] bg-cyan-950/80 text-cyan-300 px-1 py-0.5 rounded border border-cyan-800/50">합성 포함 (실데이터 ${esc(cfg.inceptDate)}~)</span>`
          : '<span class="text-[9px] bg-emerald-950/80 text-emerald-400 px-1 py-0.5 rounded border border-emerald-800/50">실제 데이터</span>';
      }
      const alloc = r.isMix ? Object.entries(r.allocations).map(([t, w]) => `${t} ${w}%`).join(' · ') : r.name;
      return `
      <tr class="hover:bg-slate-800/40 border-b border-slate-800/60 ${r.isMix ? 'bg-amber-950/30' : ''}">
        <td class="px-2.5 py-3 sticky left-0 z-10 bg-slate-950 sticky-col-shadow max-w-[125px] sm:max-w-none">
          <div class="flex flex-col gap-0.5 overflow-hidden">
            <span class="text-xs sm:text-sm font-bold truncate ${r.isMix ? 'text-amber-400' : 'text-slate-100'}" title="${esc(r.ticker)}">${esc(r.ticker)}</span>
            <div class="truncate">${badge}</div>
            <span class="text-[10px] ${r.isMix ? 'text-amber-300/90' : 'text-slate-400'} truncate block" title="${esc(alloc)}">${esc(alloc)}</span>
          </div>
        </td>
        <td class="px-3 py-3 whitespace-nowrap"><span class="bg-amber-950/80 text-amber-300 px-2 py-0.5 rounded-md border border-amber-700/60 font-num font-bold">${r.score}점</span></td>
        <td class="px-3 py-3 whitespace-nowrap font-num text-slate-300">${QuantUtils.formatKRW(r.investedKrw)}</td>
        <td class="px-3 py-3 font-bold text-emerald-400 whitespace-nowrap font-num">${QuantUtils.formatKRW(r.finalVal)}</td>
        <td class="px-3 py-3 whitespace-nowrap font-num text-slate-400" title="배당세 ${QuantUtils.formatKRW(r.divTaxKrw)} 포함">${QuantUtils.formatKRW(r.taxesPaid + r.divTaxKrw + r.feesPaid)}</td>
        <td class="px-3 py-3 ${r.annualizedXIRR >= 0 ? 'text-cyan-400' : 'text-rose-400'} font-bold whitespace-nowrap font-num">${r.annualizedXIRR >= 0 ? '+' : ''}${r.annualizedXIRR.toFixed(2)}%</td>
        <td class="px-3 py-3 text-slate-200 whitespace-nowrap font-num">${r.twrCagr.toFixed(2)}%</td>
        <td class="px-3 py-3 text-amber-400 font-bold whitespace-nowrap font-num">${r.sharpe.toFixed(2)}</td>
        <td class="px-3 py-3 text-amber-300 whitespace-nowrap font-num">${r.sortino.toFixed(2)}</td>
        <td class="px-3 py-3 text-cyan-300 whitespace-nowrap font-num">${r.treynor.toFixed(1)}</td>
        <td class="px-3 py-3 text-emerald-300 whitespace-nowrap font-num">${r.omega.toFixed(2)}</td>
        <td class="px-3 py-3 text-rose-300 whitespace-nowrap font-num">${r.painRatio.toFixed(2)}</td>
        <td class="px-3 py-3 text-slate-400 whitespace-nowrap font-num">${r.trackingError.toFixed(2)}%</td>
        <td class="px-3 py-3 text-emerald-400 whitespace-nowrap font-num">${r.informationRatio.toFixed(2)}</td>
        <td class="px-3 py-3 text-rose-300 whitespace-nowrap font-num">${r.ulcerIndex.toFixed(2)}</td>
        <td class="px-3 py-3 text-rose-400 whitespace-nowrap font-num">-${r.cvar95.toFixed(2)}%</td>
        <td class="px-3 py-3 text-rose-500 font-bold whitespace-nowrap font-num">${r.twrMdd.toFixed(1)}%</td>
      </tr>`;
    }).join('');
  }

  /* ------------------------------------------------------------ 차트/탭 */
  static switchChartTab(tab) {
    this.activeTab = tab;
    const tabs = { portfolio: 'btnTabPortfolio', underwater: 'btnTabUnderwater', heatmap: 'btnTabHeatmap', score_breakdown: 'btnTabScore', rolling: 'btnTabRolling', montecarlo: 'btnTabMonteCarlo' };
    Object.entries(tabs).forEach(([k, id]) => {
      const b = document.getElementById(id);
      if (b) b.className = `px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition ${k === tab ? 'bg-emerald-500 text-slate-950 shadow' : 'bg-slate-800/90 text-slate-400 hover:text-slate-200'}`;
    });
    const canvas = document.getElementById('chartCanvasContainer');
    const heat = document.getElementById('heatmapContainer');
    const score = document.getElementById('scoreBreakdownContainer');
    const desc = document.getElementById('chartTabDescription');
    canvas.classList.toggle('hidden', tab === 'heatmap' || tab === 'score_breakdown');
    heat.classList.toggle('hidden', tab !== 'heatmap');
    score.classList.toggle('hidden', tab !== 'score_breakdown');
    const descs = {
      portfolio: '평가금(로그 스케일) · 입금 포함',
      underwater: '고점 대비 낙폭 — 시간가중수익률(TWR) 기준 (입금 효과 제외)',
      heatmap: '월별 시간가중수익률(TWR) 및 연간 YTD',
      score_breakdown: '5축 퀀트 점수 분해 (축별 기여도 합 = 총점)',
      rolling: '3년 롤링 샤프 비율'
    };
    if (tab === 'montecarlo') this.updateMcDescription();
    else if (desc) desc.textContent = descs[tab] || '';
    if (!this.currentResults) return;
    if (tab === 'heatmap') this.renderHeatmapView();
    else if (tab === 'score_breakdown') this.renderScoreBreakdownView();
    else this.renderChart();
  }

  static updateMcDescription() {
    const desc = document.getElementById('chartTabDescription');
    if (!desc) return;
    if (!this.currentResults) { desc.textContent = '10,000회 시뮬레이션 (P5 / P50 / P95)'; return; }
    const esc = QuantUtils.escapeHTML;
    const tickers = Object.keys(this.currentResults);
    desc.innerHTML = `<span class="mr-1 text-slate-400">대상:</span>
      <select id="mcTickerSelect" aria-label="몬테카를로 대상 선택" class="bg-slate-950 text-emerald-400 font-bold text-xs rounded-lg border border-slate-700 px-2.5 py-1 max-w-full">
        ${tickers.map(t => `<option value="${esc(t)}" ${t === this.selectedMcTicker ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>`;
    document.getElementById('mcTickerSelect').addEventListener('change', (ev) => { this.selectedMcTicker = ev.target.value; this.renderChart(); });
  }

  static renderChart() {
    const results = this.currentResults;
    const dates = this.currentDates;
    if (!results || !dates.length) return;
    const ctx = document.getElementById('quantChart').getContext('2d');
    const palette = ['#34d399', '#60a5fa', '#f87171', '#c084fc', '#fb923c', '#38bdf8', '#a3e635', '#f472b6', '#facc15', '#2dd4bf'];
    const list = Object.values(results);
    const step = Math.max(1, Math.floor(dates.length / 400));
    const idx = [];
    for (let i = 0; i < dates.length; i += step) idx.push(i);
    if (idx[idx.length - 1] !== dates.length - 1) idx.push(dates.length - 1);
    let type = 'line', labels = [], datasets = [], scales = {};
    let plugins = { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } };
    const tickColor = '#64748b', grid = { color: '#1e293b' };

    if (this.activeTab === 'portfolio') {
      labels = idx.map(i => dates[i]);
      datasets.push({ label: '총 투입 원금', data: idx.map(i => list[0].investedSeries[i] || null), borderColor: '#475569', borderDash: [3, 3], pointRadius: 0, borderWidth: 1.5 });
      list.forEach((r, k) => datasets.push({
        label: `${r.ticker} (XIRR ${r.annualizedXIRR.toFixed(1)}%)`, data: idx.map(i => r.portfolioValues[i] > 0 ? r.portfolioValues[i] : null),
        borderColor: palette[k % palette.length], borderWidth: r.isMix ? 2.5 : 1.5, pointRadius: 0
      }));
      scales = { x: { grid, ticks: { color: tickColor, maxTicksLimit: 8 } }, y: { type: 'logarithmic', grid, ticks: { color: tickColor, callback: v => QuantUtils.formatKRW(v) } } };
    } else if (this.activeTab === 'underwater') {
      labels = idx.map(i => dates[i]);
      list.forEach((r, k) => {
        let peak = 0;
        const dd = new Float64Array(r.twrSeries.length);
        for (let i = 0; i < r.twrSeries.length; i++) { if (r.twrSeries[i] > peak) peak = r.twrSeries[i]; dd[i] = peak > 0 ? (r.twrSeries[i] / peak - 1) * 100 : 0; }
        datasets.push({ label: `${r.ticker} (MDD ${r.twrMdd.toFixed(1)}%)`, data: idx.map(i => Math.round(dd[i] * 100) / 100), borderColor: palette[k % palette.length], backgroundColor: 'rgba(244,63,94,0.04)', fill: true, borderWidth: r.isMix ? 2.5 : 1.5, pointRadius: 0 });
      });
      scales = { x: { grid, ticks: { color: tickColor, maxTicksLimit: 8 } }, y: { grid, max: 0, ticks: { color: '#f87171', callback: v => v.toFixed(0) + '%' } } };
    } else if (this.activeTab === 'rolling') {
      const ref = list.find(r => r.rollingSharpe.length) || list[0];
      labels = ref.rollingSharpe.map(x => x.date);
      list.forEach((r, k) => { if (r.rollingSharpe.length) datasets.push({ label: `${r.ticker}`, data: r.rollingSharpe.map(x => x.sharpe), borderColor: palette[k % palette.length], borderWidth: r.isMix ? 2.5 : 1.5, pointRadius: 0 }); });
      if (!datasets.length) plugins.title = { display: true, text: '3년 이상 기간에서 계산됩니다', color: '#94a3b8' };
      scales = { x: { grid, ticks: { color: tickColor, maxTicksLimit: 8 } }, y: { grid, ticks: { color: tickColor } } };
    } else if (this.activeTab === 'montecarlo') {
      type = 'bar';
      const r = results[this.selectedMcTicker] || list[0];
      const mc = r.monteCarlo;
      labels = ['투입 원금', '하위 5%', '중앙값', '상위 5%'];
      datasets = [{ data: [r.investedKrw, mc.p5, mc.p50, mc.p95], backgroundColor: ['#475569', '#f87171', '#34d399', '#60a5fa'] }];
      plugins = {
        legend: { display: false },
        title: { display: true, text: '월간 TWR 블록 부트스트랩(6개월, 시드 고정) · 운용 중 비용·세금 반영, 최종 청산세 제외', color: '#94a3b8', font: { size: 11 } },
        tooltip: { callbacks: { label: (c) => ` ${QuantUtils.formatKRW(c.raw)}` } }
      };
      scales = { x: { grid, ticks: { color: '#94a3b8' } }, y: { grid, ticks: { color: tickColor, callback: v => QuantUtils.formatKRW(v) } } };
    }
    if (this.chartInstance) { this.chartInstance.destroy(); this.chartInstance = null; }
    this.chartInstance = new Chart(ctx, { type, data: { labels, datasets }, options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false }, scales, plugins } });
  }

  /** 월별 TWR 수익률 매트릭스 */
  static monthlyMatrix(res) {
    const twr = res.twrSeries, dates = this.currentDates;
    const years = {};
    let prevEnd = 1;
    for (let i = 0; i < dates.length; i++) {
      const last = i === dates.length - 1 || dates[i].substring(0, 7) !== dates[i + 1].substring(0, 7);
      if (!last) continue;
      const y = parseInt(dates[i].substring(0, 4), 10), m = parseInt(dates[i].substring(5, 7), 10);
      (years[y] = years[y] || {})[m] = twr[i] / prevEnd - 1;
      prevEnd = twr[i];
    }
    return years;
  }

  static renderHeatmapView() {
    const sel = document.getElementById('heatmapTickerSelect');
    const res = this.currentResults?.[sel?.value] || Object.values(this.currentResults || {})[0];
    const body = document.getElementById('heatmapTableBody');
    if (!res || !body) return;
    const M = this.monthlyMatrix(res);
    const years = Object.keys(M).map(Number).sort((a, b) => b - a);
    body.innerHTML = years.map(y => {
      let ytd = 1, any = false, cells = '';
      for (let m = 1; m <= 12; m++) {
        const r = M[y][m];
        if (r === undefined) { cells += '<td class="px-1 py-1.5 text-slate-700">-</td>'; continue; }
        any = true; ytd *= 1 + r;
        const p = r * 100;
        const cls = p >= 5 ? 'bg-emerald-600/80 text-emerald-100 font-bold' : p >= 2 ? 'bg-emerald-700/60 text-emerald-200' : p > 0 ? 'bg-emerald-900/40 text-emerald-300'
          : p <= -5 ? 'bg-rose-600/80 text-rose-100 font-bold' : p <= -2 ? 'bg-rose-800/60 text-rose-200' : p < 0 ? 'bg-rose-950/40 text-rose-300' : 'bg-slate-900 text-slate-400';
        cells += `<td class="px-1 py-1.5"><div class="heatmap-cell rounded-md px-1 py-1 ${cls}" title="${y}년 ${m}월: ${p >= 0 ? '+' : ''}${p.toFixed(2)}%">${p >= 0 ? '+' : ''}${p.toFixed(1)}%</div></td>`;
      }
      const yp = any ? (ytd - 1) * 100 : 0;
      return `<tr class="hover:bg-slate-800/30 border-b border-slate-800/40">
        <td class="px-2.5 py-2 font-bold text-slate-300 text-left sticky left-0 z-10 bg-slate-950 sticky-col-shadow">${y}</td>${cells}
        <td class="px-2 py-1.5"><div class="rounded-md px-1.5 py-1 font-bold border ${yp >= 0 ? 'bg-emerald-950/90 text-emerald-300 border-emerald-800/50' : 'bg-rose-950/90 text-rose-300 border-rose-800/50'}">${yp >= 0 ? '+' : ''}${yp.toFixed(1)}%</div></td></tr>`;
    }).join('') || '<tr><td colspan="14" class="py-6 text-slate-500 text-center">데이터가 없습니다.</td></tr>';
  }

  static renderScoreBreakdownView() {
    const sel = document.getElementById('scoreTickerSelect');
    const res = this.currentResults?.[sel?.value] || Object.values(this.currentResults || {})[0];
    const grid = document.getElementById('scoreCardsGrid');
    const exp = document.getElementById('scoreExplanationBox');
    if (!res || !grid || !exp) return;
    const esc = QuantUtils.escapeHTML;
    const mc = res.monteCarlo || {};
    const metrics = {
      return: [['XIRR', `${res.annualizedXIRR.toFixed(1)}%`], ['FF 알파', `${res.ff.alpha.toFixed(2)}%`], ['TWR CAGR', `${res.twrCagr.toFixed(1)}%`]],
      efficiency: [['소티노', res.sortino.toFixed(2)], ['오메가', res.omega.toFixed(2)], ['페인 Ratio', res.painRatio.toFixed(2)]],
      pain: [['Ulcer', res.ulcerIndex.toFixed(1)], ['MDD', `${res.twrMdd.toFixed(1)}%`], ['연 변동성', `${res.volAnn.toFixed(1)}%`]],
      tail: [['CVaR 95% (일)', `-${res.cvar95.toFixed(2)}%`], ['정보비율', res.informationRatio.toFixed(2)], ['추종오차', `${res.trackingError.toFixed(1)}%`]],
      path: [['P5', QuantUtils.formatKRW(mc.p5)], ['P50', QuantUtils.formatKRW(mc.p50)], ['P5/P50', mc.p50 > 0 ? `${(mc.p5 / mc.p50 * 100).toFixed(1)}%` : '-']]
    };
    const colors = { return: 'purple', efficiency: 'amber', pain: 'rose', tail: 'cyan', path: 'emerald' };
    const bar = { purple: 'bg-purple-500', amber: 'bg-amber-500', rose: 'bg-rose-500', cyan: 'bg-cyan-500', emerald: 'bg-emerald-500' };
    const txt = { purple: 'text-purple-400', amber: 'text-amber-400', rose: 'text-rose-400', cyan: 'text-cyan-400', emerald: 'text-emerald-400' };
    const bd = res.scoreBreakdown;
    grid.innerHTML = bd.axes.map(a => {
      const c = colors[a.key];
      const grade = !a.on ? '-' : a.ratio >= 0.8 ? 'S' : a.ratio >= 0.6 ? 'A' : a.ratio >= 0.4 ? 'B' : 'C';
      return `<div class="bg-slate-950/90 p-4 rounded-xl border border-slate-800/90 flex flex-col justify-between space-y-3">
        <div>
          <div class="flex justify-between items-center mb-2"><span class="font-bold text-xs ${txt[c]}">${esc(a.label)}</span><span class="text-[10px] px-2 py-0.5 rounded-full border border-slate-700 font-bold text-slate-300">${grade}</span></div>
          <div class="space-y-1.5 text-[11px] text-slate-300">${metrics[a.key].map(([k, v]) => `<div class="flex justify-between"><span>${esc(k)}</span><span class="font-bold font-num">${esc(v)}</span></div>`).join('')}</div>
        </div>
        <div>
          <div class="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800"><div class="${bar[c]} h-2 rounded-full" style="width:${(a.ratio * 100).toFixed(0)}%"></div></div>
          <div class="text-[10px] text-slate-400 flex justify-between mt-1 font-num"><span>원점수 ${a.raw.toFixed(1)} / ${a.max}</span><span>기여 ${a.contribution.toFixed(1)}점 (가중 ${Math.round(a.weight * 100)}%)</span></div>
        </div></div>`;
    }).join('');
    const s = res.score;
    exp.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 pb-2 border-b border-slate-800">
        <span class="font-bold text-sm text-slate-100">🏆 <span class="text-amber-400">${esc(res.ticker)}</span> 종합 점수 <span class="text-amber-300 font-num">${s}점</span> / 100</span>
        <span class="text-[11px] text-slate-400">표본 기간 보정계수 ${bd.fSample.toFixed(3)} (짧은 기간 감점)</span>
      </div>
      <p class="text-slate-300 leading-relaxed text-xs">${s >= 85 ? '🌟 <b>최상위 올라운더</b>: 수익력과 하방 방어가 모두 탁월합니다.'
        : s >= 70 ? '✨ <b>우수 성장형</b>: 초과수익과 위험 관리가 견고합니다.'
        : s >= 50 ? '⚖️ <b>중위권 균형형</b>: 낙폭 지속 기간이나 꼬리 위험을 채권·현금 배분으로 보완하는 것을 고려하세요.'
        : '⚠️ <b>고변동성 주의</b>: 하락장 고통 지수가 높아 분할 매수와 리밸런싱이 중요합니다.'}</p>`;
  }

  /* ------------------------------------------------------------ CSV */
  static downloadCSV(rows, filename) {
    const csv = '﻿' + rows.map(r => r.map(QuantUtils.csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  static exportResultsToCSV() {
    if (!this.currentResults) { ToastNotifier.show('내보낼 결과가 없습니다.', 'warning'); return; }
    const head = ['종목/전략', '구분', '구성', '리밸런싱', '종합점수', '투자원금', '최종평가금', '세금+비용(원)', '누적수익률(%)', 'XIRR(%)', 'TWR_CAGR(%)', '샤프', '소티노', '트레이너', '오메가', '페인', '추종오차(%)', '정보비율', 'Ulcer', 'CVaR95(%)', 'MDD(%)', 'FF알파(%)', 'MKT베타', 'MOM베타', 'R2', 'MC_P5', 'MC_P50', 'MC_P95'];
    const rows = [head].concat(Object.values(this.currentResults).map(r => [
      r.ticker, r.isMix ? '믹스' : '개별', Object.entries(r.allocations).map(([t, w]) => `${t}:${w}`).join(' '), r.rebalanceFreq, r.score,
      Math.round(r.investedKrw), Math.round(r.finalVal), Math.round(r.taxesPaid + r.divTaxKrw + r.feesPaid),
      r.cumulativeReturn.toFixed(2), r.annualizedXIRR.toFixed(2), r.twrCagr.toFixed(2), r.sharpe.toFixed(3), r.sortino.toFixed(3),
      r.treynor.toFixed(2), r.omega.toFixed(3), r.painRatio.toFixed(3), r.trackingError.toFixed(2), r.informationRatio.toFixed(3),
      r.ulcerIndex.toFixed(2), r.cvar95.toFixed(3), r.twrMdd.toFixed(2), r.ff.alpha.toFixed(2), r.ff.bMkt.toFixed(3), r.ff.bMom.toFixed(3),
      r.ff.rSquared.toFixed(3), Math.round(r.monteCarlo.p5), Math.round(r.monteCarlo.p50), Math.round(r.monteCarlo.p95)
    ]));
    this.downloadCSV(rows, `etf_backtest_${this.currentDates[0]}_${this.currentDates[this.currentDates.length - 1]}.csv`);
    ToastNotifier.show('📥 성과표 CSV를 저장했습니다.', 'success');
  }

  static exportHeatmapToCSV() {
    const sel = document.getElementById('heatmapTickerSelect');
    const res = this.currentResults?.[sel?.value];
    if (!res) { ToastNotifier.show('내보낼 히트맵 데이터가 없습니다.', 'warning'); return; }
    const M = this.monthlyMatrix(res);
    const rows = [['연도', ...Array.from({ length: 12 }, (_, i) => `${i + 1}월(%)`), 'YTD(%)']];
    Object.keys(M).map(Number).sort((a, b) => b - a).forEach(y => {
      let ytd = 1;
      const cols = [];
      for (let m = 1; m <= 12; m++) { const r = M[y][m]; if (r === undefined) cols.push(''); else { ytd *= 1 + r; cols.push((r * 100).toFixed(2)); } }
      rows.push([y, ...cols, ((ytd - 1) * 100).toFixed(2)]);
    });
    this.downloadCSV(rows, `etf_monthly_twr_${res.ticker.replace(/[^A-Za-z0-9가-힣_-]/g, '_')}.csv`);
    ToastNotifier.show('📥 월별 수익률 CSV를 저장했습니다.', 'success');
  }
}

window.addEventListener('load', () => {
  if (typeof EMBEDDED_OFFLINE_MARKET_DB === 'undefined') {
    ToastNotifier.show('offline_market_db.js 를 찾지 못했습니다. 네트워크 시세로 대체하며 느리거나 실패할 수 있습니다.', 'warning');
  }
  UIController.init();
});

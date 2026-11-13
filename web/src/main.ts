import './styles.css';
import { ALL_STRETCH_3D_LIST, STRETCH_3D_SPECS } from './data/stretches';
import { Stage3D, StageTelemetry } from './engine/Stage3D';
import type { BookIndexData, BookStretchEntry, PnfPhaseId, Stretch3DSpec } from './engine/types';

type SidebarTab = 'stretches' | 'pains';
type MobilePanel = 'directory' | 'steps' | 'view';
type StageState = 'loading' | 'ready' | 'unavailable';

const MOBILE_LAYOUT =
  '(max-width: 900px), (orientation: landscape) and (max-height: 500px) and (min-width: 520px) and (pointer: coarse)';
const PHASES: PnfPhaseId[] = ['setup', 'stretch', 'resist', 'deepen'];
const SHORT_PHASES = ['定姿', '拉伸', '抗阻', '加深'];
const SPEEDS = [1.0, 0.5, 1.5];

class Pure3DCompanionApp {
  private bookIndex?: BookIndexData;
  private stage3D?: Stage3D;
  private stageState: StageState = 'loading';
  private mobileMedia = window.matchMedia(MOBILE_LAYOUT);
  private mobilePanel?: MobilePanel;
  private panelTrigger?: HTMLElement;
  private panelHome?: { content: HTMLElement; anchor: Comment };
  private phase: PnfPhaseId = 'stretch';
  private expandedPhase: PnfPhaseId = 'stretch';
  private playing = true;
  private mistakeMode = false;
  private speedIndex = 0;
  private xray = false;
  private labelPreference?: boolean;
  private selectedCamera?: number;
  private lastTelemetry = -Infinity;
  private telemetry?: StageTelemetry;

  private activeSlug = 'upper-trapezius';
  private active3DSpec: Stretch3DSpec = ALL_STRETCH_3D_LIST[0];
  private sidebarTab: SidebarTab = 'stretches';
  private searchQuery = '';
  private activePainIndex = -1;
  private leftCollapsed = false;
  private rightCollapsed = false;

  // DOM elements
  private shellEl!: HTMLElement;
  private workspaceEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private sheetEl!: HTMLDialogElement;
  private stageStatusEl!: HTMLElement;
  private sidebarListEl!: HTMLElement;
  private tabStretchesBtn!: HTMLButtonElement;
  private tabPainsBtn!: HTMLButtonElement;
  private searchInputEl!: HTMLInputElement;
  private coachEyebrowEl!: HTMLElement;
  private coachTitleEl!: HTMLElement;
  private painHudEl!: HTMLElement;
  private camPresetsEl!: HTMLElement;
  private strainFillEl!: HTMLElement;
  private strainTextEl!: HTMLElement;
  private hudPlayBtnEl!: HTMLButtonElement;
  private speedBtnEl!: HTMLButtonElement;
  private hudStepPills: HTMLButtonElement[] = [];
  private hudStepMobileLabels: HTMLElement[] = [];
  private hudStepBars: HTMLElement[] = [];
  private vStepCards: HTMLDivElement[] = [];
  private vStepHeaders: HTMLButtonElement[] = [];
  private vStepTitles: HTMLElement[] = [];
  private vStepTimers: HTMLElement[] = [];
  private vStepCues: HTMLElement[] = [];
  private vStepTips: HTMLElement[] = [];
  private vStepBars: HTMLElement[] = [];
  private mistakeAlertEl!: HTMLElement;
  private mistakeTitleEl!: HTMLElement;
  private mistakeDescEl!: HTMLElement;
  private btnCorrectEl!: HTMLButtonElement;
  private btnMistakeEl!: HTMLButtonElement;
  private anatomyCardEl!: HTMLElement;
  private safetyCardEl!: HTMLElement;

  public init(): void {
    this.buildShell();
    this.applyLayout();
    this.mobileMedia.addEventListener('change', () => this.applyLayout());
    window.visualViewport?.addEventListener('resize', this.updateSheetViewport);
    window.visualViewport?.addEventListener('scroll', this.updateSheetViewport);
    window.addEventListener('resize', this.updateSheetViewport);
    window.addEventListener('hashchange', () => this.handleHashChange());
    void this.loadBookIndex();
  }

  private async loadBookIndex(): Promise<void> {
    this.setStageState('loading', '正在加载动作目录…');
    try {
      const resp = await fetch('./data/book_index.json');
      if (!resp.ok) throw new Error(`目录请求失败：${resp.status}`);
      this.bookIndex = (await resp.json()) as BookIndexData;
    } catch (error) {
      console.error(error);
      this.setStageState('unavailable', '暂时无法加载动作目录。');
      return;
    }
    if (!this.handleHashChange()) this.selectStretch(this.activeSlug);
    this.setStageState('loading');
    requestAnimationFrame(() => this.prepareStage());
  }

  private prepareStage(): void {
    this.stage3D?.dispose();
    this.stage3D = undefined;
    this.setStageState('loading');
    try {
      const stage = new Stage3D(
        document.getElementById('stage3d-canvas')!,
        document.getElementById('stage3d-overlays')!,
        {
          mobile: this.mobileMedia.matches,
          onFirstFrame: () => this.setStageState('ready'),
          onContextLost: () => this.setStageState('unavailable'),
          onContextRestored: () => this.setStageState('loading'),
          onRenderError: (error) => this.reportStageError(error),
        }
      );
      this.stage3D = stage;
      stage.onTelemetry = (t) => this.handleTelemetry(t);
      stage.loadStretch(this.active3DSpec, this.phase, this.mistakeMode);
      if (this.selectedCamera === -1) {
        stage.fitFullBody(true);
      } else if (this.selectedCamera !== undefined) {
        const camera = this.active3DSpec.cameras[this.selectedCamera];
        if (camera) stage.setCameraPreset(camera, true);
      }
      this.syncCameraSelectionFromStage();
      stage.setPlaying(this.playing);
      stage.setSpeed(SPEEDS[this.speedIndex]);
      stage.setXrayMode(this.xray);
      stage.setShowLabels(this.labelsVisible);
      stage.setPlaybackSuspended(this.mobilePanel === 'steps');
    } catch (error) {
      this.reportStageError(error);
    }
  }

  private reportStageError(error: unknown): void {
    console.error('无法显示 3D 模型', error);
    this.stage3D?.dispose();
    this.stage3D = undefined;
    this.setStageState('unavailable');
  }

  private setStageState(state: StageState, message?: string): void {
    this.stageState = state;
    this.stageEl.dataset.stageState = state;
    this.stageStatusEl.hidden = state === 'ready';
    document.getElementById('stage-status-message')!.textContent =
      message ?? (state === 'loading' ? '正在准备 3D 视图…' : '当前无法显示 3D 模型。');
    document.getElementById('stage-status-actions')!.hidden = state !== 'unavailable';
    document.getElementById('btn-fallback-steps')!.hidden = !this.bookIndex;
    this.shellEl.querySelectorAll<HTMLButtonElement>('[data-needs-index]').forEach((btn) => {
      btn.disabled = !this.bookIndex;
    });
    this.shellEl.querySelectorAll<HTMLButtonElement>('[data-needs-stage]').forEach((btn) => {
      btn.disabled = state !== 'ready';
    });
  }

  private buildShell(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = `
      <div class="app-shell">
        <header class="top-bar">
          <div class="brand-group">
            <button type="button" class="icon-btn active desktop-only" id="btn-toggle-left" aria-controls="nav-sidebar" aria-expanded="true">☰ 动作目录</button>
            <span class="brand-title desktop-only">精准拉伸 · 3D 动态人体解剖伴读系统</span>
            <span class="brand-title mobile-only">精准拉伸</span>
            <span class="brand-badge desktop-only">40 个拉伸动作 · 14 套疼痛处方</span>
          </div>

          <div class="top-controls">
            <button type="button" class="icon-btn desktop-only" id="btn-prev-stretch" data-needs-index>◀ 上一动作</button>
            <button type="button" class="icon-btn desktop-only" id="btn-next-stretch" data-needs-index>下一动作 ▶</button>
            <button type="button" class="icon-btn active desktop-only" id="btn-toggle-right" aria-controls="inspector-sidebar" aria-expanded="true">📋 步骤面板</button>
            <button type="button" class="icon-btn" id="btn-copy-link" data-needs-index><span class="desktop-only" aria-hidden="true">🔗 </span><span id="share-label">分享</span></button>
            <button type="button" class="icon-btn" id="btn-open-copyright" aria-label="版权说明"><span class="desktop-only">版权说明</span><span class="mobile-only" aria-hidden="true">···</span></button>
          </div>
        </header>

        <main class="workspace" id="workspace">
          <!-- Column 1: Left Directory Sidebar -->
          <aside class="nav-sidebar" id="nav-sidebar">
            <div class="sidebar-top">
              <div class="sidebar-tabs">
                <button type="button" class="sidebar-tab active" id="tab-stretches">💪 40 个拉伸动作</button>
                <button type="button" class="sidebar-tab" id="tab-pains">🩺 14 套疼痛处方</button>
              </div>
              <input
                type="search"
                id="sidebar-search"
                class="search-input"
                aria-label="搜索动作或疼痛处方"
                placeholder="搜索肌肉、英文、页码或症状…"
              />
              <button type="button" class="icon-btn mobile-only" id="btn-mobile-clear-pain" hidden>退出当前处方</button>
            </div>
            <div class="sidebar-list" id="sidebar-list"></div>
          </aside>

          <!-- Column 2: Full-Height 3D Anatomical Stage (100% vertical height!) -->
          <section class="stage-column" id="stage-column" aria-label="3D 动作示范">
            <div class="mobile-action-nav mobile-only">
              <button type="button" class="icon-btn" id="btn-mobile-prev" aria-label="上一个动作" data-needs-index>‹</button>
              <div class="mobile-action-title">
                <strong id="mobile-action-name">拉伸动作</strong>
                <small id="mobile-action-number"></small>
                <button type="button" class="mobile-mode-badge" id="mobile-mode-badge" title="点击切回正确动作示范" hidden>✕ 代偿 · 切回正确</button>
              </div>
              <button type="button" class="icon-btn" id="btn-mobile-next" aria-label="下一个动作" data-needs-index>›</button>
            </div>
            <div class="mobile-stage-toolbar mobile-only">
              <button type="button" class="icon-btn" id="btn-mobile-directory" aria-haspopup="dialog" aria-controls="mobile-sheet" data-needs-index>动作目录</button>
              <span class="mobile-toolbar-spacer"></span>
              <button type="button" class="icon-btn" id="btn-mobile-fit" aria-label="完整显示全身" data-needs-stage>⌖ 全身</button>
              <button type="button" class="icon-btn" id="btn-mobile-view" aria-haspopup="dialog" aria-controls="mobile-sheet" data-needs-stage>视角</button>
            </div>
            <div class="active-pain-hud" id="active-pain-hud" style="display:none;"></div>
            <div class="viewport-wrap">
              <div class="canvas-mount" id="stage3d-canvas"></div>
              <div class="overlay-mount" id="stage3d-overlays"></div>

              <div class="viewport-hud-top" id="view-controls">
                <div class="cam-presets" id="cam-presets"></div>
                <div class="view-toggles">
                  <button type="button" class="hud-chip desktop-only" id="btn-fit-body" title="自动居中完整显示全身模型（或双击画面）" data-needs-stage>⌖ 完整居中</button>
                  <button type="button" class="hud-chip" id="btn-toggle-xray" data-needs-stage>🦴 骨骼深层透视</button>
                  <button type="button" class="hud-chip active" id="btn-toggle-labels" data-needs-stage>🏷️ 解剖标签</button>
                </div>
                <p class="mobile-view-help mobile-only">单指旋转 · 双指捏合缩放 · 双指同向滑动平移</p>
              </div>
              <div class="stage-status" id="stage-status">
                <p id="stage-status-message" role="status">正在加载动作目录…</p>
                <div class="stage-status-actions" id="stage-status-actions" hidden>
                  <button type="button" class="btn-primary" id="btn-retry-stage">重试</button>
                  <button type="button" class="icon-btn" id="btn-fallback-steps" hidden>查看步骤</button>
                </div>
              </div>
            </div>
            <div class="mobile-gesture-hint mobile-only">单指旋转 <span>·</span> 双指缩放</div>
            <div class="viewport-hud-bottom">
              <button type="button" class="hud-play-btn" id="btn-play-pause" data-needs-stage>⏸ 暂停</button>
              <div class="hud-mini-steps" id="hud-mini-steps" role="group" aria-label="动作阶段">
                ${PHASES.map((_, idx) => `<button type="button" class="hud-step-pill" data-hud-step="${idx}" data-needs-stage><span class="desktop-only">S${idx + 1}</span><span class="mobile-only hud-step-mobile-label">${idx + 1} ${SHORT_PHASES[idx]}</span><span class="hud-step-bar mobile-only" aria-hidden="true"></span></button>`).join('')}
              </div>
              <button type="button" class="hud-chip" id="btn-speed" aria-label="播放倍速 1.0 倍" data-needs-stage>1.0×</button>
              <div class="hud-strain-inline">
                <div class="meter-track"><div class="meter-fill" id="strain-fill"></div></div>
                <strong id="strain-text" style="font-size:11px;">—</strong>
              </div>
              <button type="button" class="icon-btn mobile-only" id="btn-mobile-steps" aria-haspopup="dialog" aria-controls="mobile-sheet" data-needs-index>步骤</button>
            </div>
          </section>

          <!-- Column 3: Right Step-by-Step PNF & Anatomy Inspector Sidebar -->
          <aside class="inspector-sidebar" id="inspector-sidebar">
            <div class="inspector-header">
              <div>
                <div class="coach-eyebrow" id="coach-eyebrow"></div>
                <div class="coach-title" id="coach-title">动作步骤</div>
              </div>

              <div class="mode-compare-toggle">
                <button type="button" class="compare-btn active-correct" id="btn-mode-correct" data-needs-index>✓ 正确动作示范</button>
                <button type="button" class="compare-btn" id="btn-mode-mistake" data-needs-index>✕ 常见错误代偿</button>
              </div>
            </div>

            <div class="inspector-scroll">
              <div class="mistake-alert-card" id="mistake-alert-card" style="display:none;">
                <div class="mistake-alert-title" id="mistake-alert-title"></div>
                <div class="mistake-alert-desc" id="mistake-alert-desc"></div>
                <button type="button" class="icon-btn mobile-mistake-view mobile-only" id="btn-view-mistake-3d" data-needs-stage>在 3D 中查看此错误代偿</button>
              </div>

              <div class="section-label-row">
                <span class="desktop-only">PNF 四阶段步骤拆解（点击任一步骤定格观察）</span>
                <span class="mobile-only">PNF 四阶段 · 点开查看要领</span>
              </div>

              <div class="pnf-vertical-timeline" id="pnf-vertical-timeline">
                ${PHASES
                  .map(
                    (_, idx) => `
                  <div class="v-step-card" data-step-idx="${idx}">
                    <button type="button" class="v-step-header" aria-controls="step-detail-${idx}" aria-expanded="false">
                      <span class="v-step-badge-group">
                        <span class="v-step-num">STEP ${idx + 1}</span>
                        <span class="v-step-title">--</span>
                      </span>
                      <span class="v-step-timer">--s</span>
                    </button>
                    <div class="v-step-detail" id="step-detail-${idx}">
                      <div class="v-step-cue"></div>
                      <div class="v-step-tip"></div>
                    </div>
                    <button type="button" class="icon-btn mobile-step-view mobile-only" data-needs-stage>在 3D 中查看此步</button>
                    <div class="v-step-progress"></div>
                  </div>`
                  )
                  .join('')}
              </div>

              <div class="info-card" id="safety-card"></div>
              <div class="info-card" id="anatomy-card"></div>
            </div>
          </aside>
        </main>

        <footer class="app-footer">
          <span>左键拖拽 360° 旋转 · 滚轮缩放 · 右键平移 · 双击画面或点「⌖ 完整居中」一键完整显示全身</span>
          <span>
            非官方 3D 运动解剖伴读工具（不含原书文本与插图） · 原著 Kristian Berg & Human Kinetics ·
            <button type="button" class="footer-link" id="btn-footer-copyright">版权与免责声明</button>
          </span>
        </footer>

        <dialog id="mobile-sheet" class="mobile-sheet" aria-labelledby="mobile-sheet-title">
          <div class="mobile-sheet-inner">
            <div class="mobile-sheet-header">
              <h2 id="mobile-sheet-title"></h2>
              <button type="button" class="icon-btn" id="btn-close-sheet">关闭</button>
            </div>
            <div class="mobile-sheet-body"></div>
          </div>
        </dialog>

        <dialog class="share-fallback modal-card" id="share-fallback" aria-labelledby="share-title">
          <h2 id="share-title">分享当前动作</h2>
          <p>长按链接即可复制。</p>
          <input type="url" readonly aria-label="当前动作链接" class="search-input" />
          <form method="dialog"><button type="submit" class="icon-btn">关闭</button></form>
        </dialog>

        <div class="modal-backdrop" id="copyright-modal">
          <div class="modal-card">
            <h2>关于本项目 · 版权与医疗免责声明</h2>
            <ul>
              <li>本系统提供三维人体、肌束和动作演示，帮助读者对照《精准拉伸》（<em>Prescriptive Stretching</em>, Kristian Berg / Human Kinetics, 2011）理解解剖位置与 PNF 发力节奏。<strong>应用不包含原书 PDF、插图或原文。</strong></li>
              <li><strong>开源代码许可：</strong>本仓库中的 Three.js 参数化人体运动学与肌束引擎源代码基于 MIT License 开源。</li>
              <li>人体体表网格基于 <strong>MakeHuman 的 CC0 1.0 核心模型</strong>制作。</li>
              <li><strong>非医疗建议声明：</strong>三维动画、角度区间与要点提示仅供运动解剖学习交流，不构成亦不替代临床医疗诊断、物理治疗评估或康复处方。练习中一旦出现关节刺痛、头晕或放射麻木，请立即停止并咨询专业医师或物理治疗师。</li>
            </ul>
            <div style="text-align:right;">
              <button type="button" class="btn-primary" id="btn-close-copyright">我知道了</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.shellEl = app.querySelector('.app-shell')!;
    this.workspaceEl = document.getElementById('workspace')!;
    this.stageEl = document.getElementById('stage-column')!;
    this.sheetEl = document.getElementById('mobile-sheet') as HTMLDialogElement;
    this.stageStatusEl = document.getElementById('stage-status')!;
    this.sidebarListEl = document.getElementById('sidebar-list')!;
    this.tabStretchesBtn = document.getElementById('tab-stretches') as HTMLButtonElement;
    this.tabPainsBtn = document.getElementById('tab-pains') as HTMLButtonElement;
    this.searchInputEl = document.getElementById('sidebar-search') as HTMLInputElement;
    this.coachEyebrowEl = document.getElementById('coach-eyebrow')!;
    this.coachTitleEl = document.getElementById('coach-title')!;
    this.painHudEl = document.getElementById('active-pain-hud')!;
    this.camPresetsEl = document.getElementById('cam-presets')!;
    this.strainFillEl = document.getElementById('strain-fill')!;
    this.strainTextEl = document.getElementById('strain-text')!;
    this.hudPlayBtnEl = document.getElementById('btn-play-pause') as HTMLButtonElement;
    this.speedBtnEl = document.getElementById('btn-speed') as HTMLButtonElement;
    this.mistakeAlertEl = document.getElementById('mistake-alert-card')!;
    this.mistakeTitleEl = document.getElementById('mistake-alert-title')!;
    this.mistakeDescEl = document.getElementById('mistake-alert-desc')!;
    this.btnCorrectEl = document.getElementById('btn-mode-correct') as HTMLButtonElement;
    this.btnMistakeEl = document.getElementById('btn-mode-mistake') as HTMLButtonElement;
    this.anatomyCardEl = document.getElementById('anatomy-card')!;
    this.safetyCardEl = document.getElementById('safety-card')!;

    this.bindEvents();
  }

  private toggleLeftSidebar(forceCollapse?: boolean): void {
    this.leftCollapsed = forceCollapse ?? !this.leftCollapsed;
    this.workspaceEl.classList.toggle('left-collapsed', this.leftCollapsed);
    const button = document.getElementById('btn-toggle-left')!;
    button.classList.toggle('active', !this.leftCollapsed);
    button.setAttribute('aria-expanded', String(!this.leftCollapsed));
  }

  private toggleRightSidebar(forceCollapse?: boolean): void {
    this.rightCollapsed = forceCollapse ?? !this.rightCollapsed;
    this.workspaceEl.classList.toggle('right-collapsed', this.rightCollapsed);
    const button = document.getElementById('btn-toggle-right')!;
    button.classList.toggle('active', !this.rightCollapsed);
    button.setAttribute('aria-expanded', String(!this.rightCollapsed));
  }

  private get labelsVisible(): boolean {
    if (this.labelPreference !== undefined) return this.labelPreference;
    return !this.mobileMedia.matches || this.mistakeMode;
  }

  private applyLayout(): void {
    const mobile = this.mobileMedia.matches;
    this.shellEl.classList.toggle('is-mobile', mobile);
    if (!mobile) this.closeMobilePanel(false);
    this.stage3D?.setMobile(mobile);
    this.syncViewToggles();
    this.syncCameraSelectionFromStage();
    this.updateSheetViewport();
  }

  private updateSheetViewport = (): void => {
    const viewport = window.visualViewport;
    if (!viewport || !this.mobileMedia.matches) return;
    this.sheetEl.style.setProperty('--sheet-visible-height', `${viewport.height}px`);
    this.sheetEl.style.setProperty(
      '--sheet-keyboard-inset',
      `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`
    );
  };

  private openMobilePanel(panel: MobilePanel, trigger: HTMLElement): void {
    if (!this.mobileMedia.matches || (panel === 'view' ? this.stageState !== 'ready' : !this.bookIndex)) return;
    if (this.mobilePanel === panel) return;
    this.closeMobilePanel(false);
    const panels: Record<MobilePanel, [string, string]> = {
      directory: ['nav-sidebar', '动作目录'],
      steps: ['inspector-sidebar', '动作步骤'],
      view: ['view-controls', '视角与显示'],
    };
    const [id, title] = panels[panel];
    const content = document.getElementById(id)!;
    const anchor = document.createComment('mobile sheet home');
    content.before(anchor);
    this.sheetEl.querySelector('.mobile-sheet-body')!.append(content);
    this.panelHome = { content, anchor };
    this.mobilePanel = panel;
    this.panelTrigger = trigger;
    this.sheetEl.dataset.panel = panel;
    this.sheetEl.querySelector('#mobile-sheet-title')!.textContent = title;
    this.updateSheetViewport();
    if (panel === 'steps') {
      this.expandedPhase = this.phase;
      this.renderPlayback();
      content.querySelector('.inspector-scroll')?.scrollTo(0, 0);
    } else if (panel === 'view') {
      this.syncCameraSelectionFromStage();
    }
    this.stage3D?.setPlaybackSuspended(panel === 'steps');
    this.sheetEl.showModal();
    if (panel === 'directory') {
      requestAnimationFrame(() => {
        content
          .querySelector<HTMLElement>('.stretch-item-btn.active, .pain-card.active')
          ?.scrollIntoView({ block: 'center' });
      });
    }
  }

  private restoreMobilePanelDom(): void {
    if (this.panelHome) {
      this.panelHome.anchor.replaceWith(this.panelHome.content);
      this.panelHome = undefined;
    }
    this.mobilePanel = undefined;
    this.stage3D?.setPlaybackSuspended(false);
  }

  private closeMobilePanel(restoreFocus = true): void {
    if (!this.mobilePanel && !this.sheetEl.open) return;
    const trigger = this.panelTrigger;
    this.panelTrigger = undefined;
    if (this.sheetEl.open) this.sheetEl.close();
    this.restoreMobilePanelDom();
    if (restoreFocus) trigger?.focus({ preventScroll: true });
  }

  private syncViewToggles(): void {
    const settings = [
      ['btn-toggle-xray', this.xray],
      ['btn-toggle-labels', this.labelsVisible],
    ] as const;
    for (const [id, enabled] of settings) {
      const button = document.getElementById(id)!;
      button.classList.toggle('active', enabled);
      button.setAttribute('aria-pressed', String(enabled));
    }
    this.stage3D?.setXrayMode(this.xray);
    this.stage3D?.setShowLabels(this.labelsVisible);
  }

  private syncUrlHash(): void {
    const params = new URLSearchParams();
    params.set('stretch', this.activeSlug);
    if (!this.playing) params.set('phase', this.phase);
    if (this.mistakeMode) params.set('mode', 'mistake');
    const nextHash = `#${params.toString()}`;
    if (window.location.hash !== nextHash) {
      history.replaceState(null, '', nextHash);
    }
  }

  private jumpToPhase(phase: PnfPhaseId, pause: boolean): void {
    this.phase = phase;
    this.telemetry = undefined;
    if (pause) this.playing = false;
    this.setMistakeMode(false, false);
    this.stage3D?.setPhase(phase, pause);
    this.renderPlayback();
    this.syncUrlHash();
  }

  private bindEvents(): void {
    const onClick = (id: string, listener: (event: MouseEvent) => void) => {
      document.getElementById(id)!.addEventListener('click', listener);
    };
    onClick('btn-toggle-left', () => this.toggleLeftSidebar());
    onClick('btn-toggle-right', () => this.toggleRightSidebar());
    const fit = () => {
      this.selectedCamera = -1;
      this.syncCameraSelection(-1);
      this.stage3D?.fitFullBody(false);
    };
    onClick('btn-fit-body', fit);
    onClick('btn-mobile-fit', fit);
    onClick('btn-mobile-directory', (e) => this.openMobilePanel('directory', e.currentTarget as HTMLElement));
    onClick('btn-mobile-steps', (e) => this.openMobilePanel('steps', e.currentTarget as HTMLElement));
    onClick('btn-mobile-view', (e) => this.openMobilePanel('view', e.currentTarget as HTMLElement));
    onClick('btn-close-sheet', () => this.closeMobilePanel());
    onClick('btn-mobile-clear-pain', () => this.clearPainProgram());
    this.sheetEl.addEventListener('close', () => this.restoreMobilePanelDom());
    this.sheetEl.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.closeMobilePanel();
    });
    this.sheetEl.addEventListener('click', (event) => {
      if (event.target === this.sheetEl) this.closeMobilePanel();
    });
    onClick('btn-retry-stage', () => {
      if (this.bookIndex) this.prepareStage();
      else void this.loadBookIndex();
    });
    onClick('btn-fallback-steps', (e) => {
      if (this.mobileMedia.matches) this.openMobilePanel('steps', e.currentTarget as HTMLElement);
      else {
        this.toggleRightSidebar(false);
        this.btnCorrectEl.focus();
      }
    });

    this.tabStretchesBtn.addEventListener('click', () => {
      this.sidebarTab = 'stretches';
      this.tabStretchesBtn.classList.add('active');
      this.tabPainsBtn.classList.remove('active');
      this.renderSidebarList();
    });

    this.tabPainsBtn.addEventListener('click', () => {
      this.sidebarTab = 'pains';
      this.tabPainsBtn.classList.add('active');
      this.tabStretchesBtn.classList.remove('active');
      this.renderSidebarList();
    });

    this.searchInputEl.addEventListener('input', () => {
      this.searchQuery = this.searchInputEl.value.trim().toLowerCase();
      this.renderSidebarList();
    });

    onClick('btn-prev-stretch', () => this.stepStretch(-1));
    onClick('btn-next-stretch', () => this.stepStretch(1));
    onClick('btn-mobile-prev', () => this.stepStretch(-1));
    onClick('btn-mobile-next', () => this.stepStretch(1));

    const copyBtn = document.getElementById('btn-copy-link')!;
    const shareLabel = document.getElementById('share-label')!;
    copyBtn.addEventListener('click', async () => {
      const url = window.location.href;
      try {
        await navigator.clipboard.writeText(url);
        shareLabel.textContent = '✓ 已复制';
        setTimeout(() => {
          shareLabel.textContent = '分享';
        }, 1800);
      } catch {
        const dialog = document.getElementById('share-fallback') as HTMLDialogElement;
        const input = dialog.querySelector('input')!;
        input.value = url;
        if (!dialog.open) dialog.showModal();
        input.focus();
        input.select();
      }
    });

    this.btnCorrectEl.addEventListener('click', () => {
      this.setMistakeMode(false);
    });
    this.btnMistakeEl.addEventListener('click', () => {
      this.setMistakeMode(true);
      if (this.mobilePanel === 'steps') {
        this.sheetEl.querySelector('.inspector-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
    onClick('btn-view-mistake-3d', () => this.closeMobilePanel());
    onClick('mobile-mode-badge', () => this.setMistakeMode(false));

    onClick('btn-toggle-xray', () => {
      this.xray = !this.xray;
      this.syncViewToggles();
    });
    onClick('btn-toggle-labels', () => {
      this.labelPreference = !this.labelsVisible;
      this.syncViewToggles();
    });

    // Vertical Step Cards in Right Dock
    document.querySelectorAll('.v-step-card').forEach((el, idx) => {
      const card = el as HTMLDivElement;
      this.vStepCards.push(card);
      const header = card.querySelector('button.v-step-header') as HTMLButtonElement;
      this.vStepHeaders.push(header);
      this.vStepTitles.push(card.querySelector('.v-step-title') as HTMLElement);
      this.vStepTimers.push(card.querySelector('.v-step-timer') as HTMLElement);
      this.vStepCues.push(card.querySelector('.v-step-cue') as HTMLElement);
      this.vStepTips.push(card.querySelector('.v-step-tip') as HTMLElement);
      this.vStepBars.push(card.querySelector('.v-step-progress') as HTMLElement);
      card.addEventListener('click', () => {
        if (!this.mobileMedia.matches && this.bookIndex) this.jumpToPhase(PHASES[idx], false);
      });
      header.addEventListener('click', () => {
        if (!this.mobileMedia.matches) return;
        this.expandedPhase = PHASES[idx];
        this.renderPlayback();
      });
      card.querySelector('.mobile-step-view')!.addEventListener('click', () => {
        this.jumpToPhase(PHASES[idx], true);
        this.closeMobilePanel();
      });
    });

    // Mini HUD Step Pills in Bottom Floating Bar
    document.querySelectorAll('.hud-step-pill').forEach((el, idx) => {
      const pill = el as HTMLButtonElement;
      this.hudStepPills.push(pill);
      this.hudStepMobileLabels.push(pill.querySelector('.hud-step-mobile-label') as HTMLElement);
      this.hudStepBars.push(pill.querySelector('.hud-step-bar') as HTMLElement);
      pill.addEventListener('click', () => this.jumpToPhase(PHASES[idx], this.mobileMedia.matches));
    });

    this.hudPlayBtnEl.addEventListener('click', () => {
      this.playing = !this.playing;
      this.stage3D?.setPlaying(this.playing);
      this.renderPlayback();
      this.syncUrlHash();
    });

    this.speedBtnEl.addEventListener('click', () => {
      this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
      const speed = SPEEDS[this.speedIndex];
      this.stage3D?.setSpeed(speed);
      this.speedBtnEl.textContent = `${speed.toFixed(1)}×`;
      this.speedBtnEl.setAttribute('aria-label', `播放倍速 ${speed.toFixed(1)} 倍`);
    });

    const modal = document.getElementById('copyright-modal')!;
    document.getElementById('btn-open-copyright')!.addEventListener('click', () => modal.classList.add('open'));
    document.getElementById('btn-footer-copyright')!.addEventListener('click', () => modal.classList.add('open'));
    document.getElementById('btn-close-copyright')!.addEventListener('click', () => modal.classList.remove('open'));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('open');
    });
  }

  private renderSidebarList(): void {
    const bookIndex = this.bookIndex;
    if (!bookIndex) return;
    const q = this.searchQuery;
    this.sidebarListEl.innerHTML = '';
    const showEmpty = () => {
      if (this.sidebarListEl.childElementCount) return;
      const message = document.createElement('p');
      message.className = 'sidebar-empty';
      message.textContent = '没有找到匹配项，试试其他关键词。';
      this.sidebarListEl.appendChild(message);
    };

    if (this.sidebarTab === 'stretches') {
      for (const reg of bookIndex.regions) {
        const items = bookIndex.stretches.filter(
          (s) =>
            s.regionId === reg.id &&
            (!q ||
              s.chinese.toLowerCase().includes(q) ||
              s.english.toLowerCase().includes(q) ||
              s.printedPage.includes(q) ||
              String(s.order).includes(q))
        );
        if (items.length === 0) continue;

        const sec = document.createElement('div');
        const h = document.createElement('div');
        h.className = 'region-group-title';
        h.textContent = reg.name;
        sec.appendChild(h);

        for (const s of items) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `stretch-item-btn ${s.slug === this.activeSlug ? 'active' : ''}`;
          if (s.slug === this.activeSlug) btn.setAttribute('aria-current', 'true');
          btn.dataset.slug = s.slug;
          btn.innerHTML = `
            <span class="stretch-item-main">
              <span class="stretch-num">#${String(s.order).padStart(2, '0')}</span>
              <span class="stretch-zh">${s.chinese}</span>
            </span>
            <span class="page-pill">p.${s.printedPage}</span>
          `;
          btn.addEventListener('click', () => {
            this.selectStretch(s.slug);
            this.closeMobilePanel();
          });
          sec.appendChild(btn);
        }
        this.sidebarListEl.appendChild(sec);
      }
      showEmpty();
      return;
    }

    const groups: { key: 'waking' | 'program'; title: string }[] = [
      { key: 'waking', title: '一、晨起常见疼痛（原书 p.119–120）' },
      { key: 'program', title: '二、专项部位疼痛方案（原书 p.121–131）' },
    ];

    for (const grp of groups) {
      const entries = bookIndex.painPrograms
        .map((p, idx) => ({ p, idx }))
        .filter(
          ({ p }) =>
            p.category === grp.key &&
            (!q ||
              p.chinese.toLowerCase().includes(q) ||
              p.english.toLowerCase().includes(q) ||
              p.tip.toLowerCase().includes(q))
        );
      if (entries.length === 0) continue;

      const sec = document.createElement('div');
      const h = document.createElement('div');
      h.className = 'region-group-title';
      h.textContent = grp.title;
      sec.appendChild(h);

      for (const { p, idx } of entries) {
        const card = document.createElement('div');
        card.className = `pain-card ${idx === this.activePainIndex ? 'active' : ''}`;
        const chips = p.recommendedStretches
          .map((sl) => {
            const st = bookIndex.stretches.find((x) => x.slug === sl);
            if (!st) return '';
            return `<button type="button" class="pain-chip ${sl === this.activeSlug ? 'active' : ''}" data-pain-slug="${sl}" data-pain-idx="${idx}">${st.chinese}</button>`;
          })
          .join('');

        card.innerHTML = `
          <div class="pain-card-head">
            <span class="pain-card-title">${p.chinese}</span>
            <span class="page-pill">p.${p.printedPage}</span>
          </div>
          <div class="pain-card-tip">${p.tip}</div>
          <div class="pain-card-chips">${chips}</div>
        `;

        card.addEventListener('click', (ev) => {
          const target = ev.target as HTMLElement;
          if (target.dataset.painSlug) {
            ev.stopPropagation();
            this.activePainIndex = idx;
            this.selectStretch(target.dataset.painSlug);
            this.closeMobilePanel();
            return;
          }
          this.activePainIndex = idx;
          if (p.recommendedStretches.length > 0) {
            this.selectStretch(p.recommendedStretches[0]);
            this.closeMobilePanel();
          } else {
            this.renderPainHud();
            this.renderSidebarList();
          }
        });
        sec.appendChild(card);
      }
      this.sidebarListEl.appendChild(sec);
    }
    showEmpty();
  }

  private renderPainHud(): void {
    const bookIndex = this.bookIndex;
    const prog = bookIndex?.painPrograms[this.activePainIndex];
    document.getElementById('btn-mobile-clear-pain')!.hidden = !prog;
    if (!bookIndex || !prog) {
      this.painHudEl.style.display = 'none';
      return;
    }
    this.painHudEl.style.display = 'flex';
    const chipsHtml = prog.recommendedStretches
      .map((sl) => {
        const st = bookIndex.stretches.find((x) => x.slug === sl);
        if (!st) return '';
        return `<button type="button" class="pain-chip ${sl === this.activeSlug ? 'active' : ''}" data-hud-slug="${sl}">${st.chinese}</button>`;
      })
      .join('');

    this.painHudEl.innerHTML = `
      <strong class="pain-hud-label">🩺 ${prog.chinese}<span class="desktop-only">（p.${prog.printedPage}）</span>：</strong>
      ${chipsHtml}
      <button type="button" class="pain-chip pain-chip-close" id="btn-hud-pain-close" title="清除处方筛选">✕ 退出</button>
    `;

    this.painHudEl.querySelectorAll('[data-hud-slug]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectStretch((btn as HTMLElement).dataset.hudSlug!);
      });
    });
    this.painHudEl.querySelector('#btn-hud-pain-close')?.addEventListener('click', () => this.clearPainProgram());
    requestAnimationFrame(() => {
      this.painHudEl
        .querySelector<HTMLElement>('.pain-chip.active')
        ?.scrollIntoView({ inline: 'center', block: 'nearest' });
    });
  }

  private clearPainProgram(): void {
    this.activePainIndex = -1;
    this.renderPainHud();
    this.renderSidebarList();
  }

  private stepStretch(delta: -1 | 1): void {
    const entries = this.bookIndex?.stretches;
    if (!entries?.length) return;
    const curIdx = entries.findIndex((s) => s.slug === this.activeSlug);
    const nextIdx = (curIdx + delta + entries.length) % entries.length;
    this.selectStretch(entries[nextIdx].slug);
  }

  private setMistakeMode(mistake: boolean, syncHash = true): void {
    this.mistakeMode = mistake;
    this.stage3D?.setMistakeMode(mistake);
    this.btnCorrectEl.classList.toggle('active-correct', !mistake);
    this.btnMistakeEl.classList.toggle('active-mistake', mistake);
    this.btnCorrectEl.setAttribute('aria-pressed', String(!mistake));
    this.btnMistakeEl.setAttribute('aria-pressed', String(mistake));
    this.mistakeAlertEl.style.display = mistake ? 'flex' : 'none';
    document.getElementById('mobile-mode-badge')!.hidden = !mistake;
    this.syncViewToggles();
    this.renderPlayback();
    if (syncHash) this.syncUrlHash();
  }

  public selectStretch(
    slug: string,
    opts: { initialPhase?: PnfPhaseId; mistake?: boolean; keepHash?: boolean } = {}
  ): boolean {
    const entry = this.bookIndex?.stretches.find((s) => s.slug === slug);
    const spec = STRETCH_3D_SPECS[slug];
    if (!entry || !spec) return false;

    this.activeSlug = slug;
    this.active3DSpec = spec;
    this.selectedCamera = undefined;
    this.phase = opts.initialPhase ?? 'stretch';
    this.expandedPhase = this.phase;
    this.telemetry = undefined;
    this.renderCoachStaticMetadata(spec, entry);
    try {
      this.stage3D?.loadStretch(spec, this.phase, opts.mistake ?? false);
    } catch (error) {
      this.reportStageError(error);
    }
    this.syncCameraSelectionFromStage();
    this.setMistakeMode(opts.mistake ?? false, false);
    this.renderPainHud();
    this.renderSidebarList();

    if (!opts.keepHash) this.syncUrlHash();
    return true;
  }

  private renderCoachStaticMetadata(spec: Stretch3DSpec, entry: BookStretchEntry): void {
    this.coachEyebrowEl.textContent = `${entry.regionName} · 动作 #${String(entry.order).padStart(2, '0')}/40 · 原书第 ${entry.printedPage} 页`;
    this.coachTitleEl.innerHTML = `${spec.nameZh} <small>${spec.nameEn}</small>`;
    const title = document.getElementById('mobile-action-name')!;
    title.textContent = spec.nameZh;
    title.title = spec.nameZh;
    document.getElementById('mobile-action-number')!.textContent = `${String(entry.order).padStart(2, '0')}/${this.bookIndex?.stretches.length ?? 40}`;

    this.camPresetsEl.innerHTML = '';
    spec.cameras.forEach((cam, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `hud-chip ${i === 0 ? 'active' : ''}`;
      chip.dataset.needsStage = '';
      chip.disabled = this.stageState !== 'ready';
      chip.setAttribute('aria-pressed', String(i === 0));
      chip.textContent = `🎥 ${cam.label}`;
      chip.addEventListener('click', () => {
        this.selectedCamera = i;
        this.syncCameraSelection(i);
        this.stage3D?.setCameraPreset(cam, false);
        if (this.mobilePanel === 'view') this.closeMobilePanel();
      });
      this.camPresetsEl.appendChild(chip);
    });

    this.mistakeTitleEl.textContent = `✕ ${spec.mistakeInfo.title}`;
    this.mistakeDescEl.textContent = spec.mistakeInfo.description;

    // Populate all 4 vertical step cards & mini HUD pills
    spec.phases.forEach((ph, idx) => {
      this.vStepTitles[idx].textContent = ph.title;
      this.vStepCues[idx].textContent = ph.cue;
      this.vStepTips[idx].textContent = `💡 提示：${ph.breathingTip}`;
      const shortName = ph.title.split('：')[0];
      this.hudStepPills[idx].querySelector('.desktop-only')!.textContent = `${idx + 1}.${shortName}`;
      this.hudStepPills[idx].setAttribute('aria-label', `第 ${idx + 1} 阶段：${shortName}`);
    });

    this.safetyCardEl.innerHTML = `
      <div class="info-card-title">幅度标尺与安全叫停红线</div>
      <div style="color:#bfdbfe;margin-bottom:4px;"><strong>参考幅度：</strong>${spec.degreeGuide.angleTarget}</div>
      <div style="color:#a7f3d0;margin-bottom:4px;"><strong>目标体感：</strong>${spec.degreeGuide.sensationTarget}</div>
      <ul class="red-flag-list">
        ${spec.degreeGuide.stopRedFlags.map((r) => `<li>${r}</li>`).join('')}
      </ul>
    `;

    this.anatomyCardEl.innerHTML = `
      <div class="info-card-title">解剖起止点与功能（${spec.nameZh}）</div>
      <div><strong>起点：</strong>${spec.anatomySummary.originZh}</div>
      <div><strong>止点：</strong>${spec.anatomySummary.insertionZh}</div>
      <div><strong>功能：</strong>${spec.anatomySummary.actionZh}</div>
    `;
  }

  private syncCameraSelectionFromStage(): void {
    if (!this.stage3D) return;
    const activePreset = this.stage3D.getActivePreset();
    const idx = activePreset ? this.active3DSpec.cameras.indexOf(activePreset) : -1;
    this.syncCameraSelection(idx);
  }

  private syncCameraSelection(index: number): void {
    Array.from(this.camPresetsEl.children).forEach((button, i) => {
      button.classList.toggle('active', i === index);
      button.setAttribute('aria-pressed', String(i === index));
    });
  }

  private renderPlayback(): void {
    const spec = this.active3DSpec;
    const t = this.telemetry?.phase === this.phase && this.telemetry.isMistake === this.mistakeMode
      ? this.telemetry
      : undefined;
    const playLabel = this.playing ? '⏸ 暂停' : '▶ 播放';
    if (this.hudPlayBtnEl.textContent !== playLabel) this.hudPlayBtnEl.textContent = playLabel;
    const phaseIndex = PHASES.indexOf(this.phase);
    this.vStepCards.forEach((card, idx) => {
      const active = !this.mistakeMode && idx === phaseIndex;
      const expanded = this.mobileMedia.matches ? PHASES[idx] === this.expandedPhase : active;
      card.classList.toggle('active', active);
      card.classList.toggle('expanded', expanded);
      const expandedValue = String(expanded);
      if (this.vStepHeaders[idx].getAttribute('aria-expanded') !== expandedValue) {
        this.vStepHeaders[idx].setAttribute('aria-expanded', expandedValue);
      }
      this.hudStepPills[idx].classList.toggle('active', active);
      const pressedValue = String(active);
      if (this.hudStepPills[idx].getAttribute('aria-pressed') !== pressedValue) {
        this.hudStepPills[idx].setAttribute('aria-pressed', pressedValue);
      }
      const barWidth = active && t
        ? `${(t.phaseProgress * 100).toFixed(1)}%`
        : idx < phaseIndex && !this.mistakeMode
        ? '100%'
        : '0%';
      this.vStepBars[idx].style.width = barWidth;
      this.hudStepBars[idx].style.width = barWidth;

      const remSec = active && t ? Math.ceil(t.phaseRemainingSec) : spec.phases[idx].durationSec;
      const timer = `${remSec}s`;
      if (this.vStepTimers[idx].textContent !== timer) this.vStepTimers[idx].textContent = timer;

      const mobileLabel = active ? `${idx + 1} ${SHORT_PHASES[idx]} · ${remSec}s` : `${idx + 1} ${SHORT_PHASES[idx]}`;
      if (this.hudStepMobileLabels[idx].textContent !== mobileLabel) {
        this.hudStepMobileLabels[idx].textContent = mobileLabel;
      }
    });
  }

  private handleTelemetry(t: StageTelemetry): void {
    this.telemetry = t;
    const now = performance.now();
    if (this.mobileMedia.matches && t.phase === this.phase && now - this.lastTelemetry < 80) return;
    this.lastTelemetry = now;
    this.phase = t.phase;
    this.renderPlayback();

    // Update compact strain bar
    const pctWidth = t.isMistake ? 16 : Math.min(100, Math.round(18 + t.strainRatio * 78));
    this.strainFillEl.style.width = `${pctWidth}%`;
    if (t.isMistake) {
      this.strainTextEl.textContent = `⚠️ 代偿泄力 +${t.elongationPct.toFixed(1)}%`;
      this.strainTextEl.style.color = '#fda4af';
    } else if (t.phase === 'resist') {
      this.strainTextEl.textContent = `⚡ 等长抗阻中`;
      this.strainTextEl.style.color = '#fde68a';
    } else {
      this.strainTextEl.textContent = `牵拉 +${t.elongationPct.toFixed(1)}%`;
      this.strainTextEl.style.color = '#6ee7b7';
    }
  }

  private handleHashChange(): boolean {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const slug = params.get('stretch');
    if (!slug) return false;
    const initialPhase = PHASES.find((phase) => phase === params.get('phase'));
    if (initialPhase) {
      this.playing = false;
      this.stage3D?.setPlaying(false);
    }
    const ok = this.selectStretch(slug, {
      initialPhase,
      mistake: params.get('mode') === 'mistake',
      keepHash: true,
    });
    if (ok) this.renderPlayback();
    return ok;
  }
}

new Pure3DCompanionApp().init();

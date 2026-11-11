import './styles.css';
import { ALL_STRETCH_3D_LIST, STRETCH_3D_SPECS } from './data/stretches';
import { Stage3D, StageTelemetry } from './engine/Stage3D';
import type { BookIndexData, BookStretchEntry, PnfPhaseId, Stretch3DSpec } from './engine/types';

type SidebarTab = 'stretches' | 'pains';

class Pure3DCompanionApp {
  private bookIndex!: BookIndexData;
  private stage3D!: Stage3D;

  private activeSlug = 'upper-trapezius';
  private activeBookEntry!: BookStretchEntry;
  private active3DSpec: Stretch3DSpec = ALL_STRETCH_3D_LIST[0];
  private sidebarTab: SidebarTab = 'stretches';
  private searchQuery = '';
  private activePainIndex = -1;
  private leftCollapsed = false;
  private rightCollapsed = false;

  // DOM elements
  private workspaceEl!: HTMLElement;
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
  private vStepCards: HTMLDivElement[] = [];
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

  public async init(): Promise<void> {
    const resp = await fetch('./data/book_index.json');
    this.bookIndex = (await resp.json()) as BookIndexData;

    this.buildShell();

    const canvasMount = document.getElementById('stage3d-canvas')!;
    const overlayMount = document.getElementById('stage3d-overlays')!;
    this.stage3D = new Stage3D(canvasMount, overlayMount);
    this.stage3D.onTelemetry = (t) => this.handleTelemetry(t);

    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const initSlug = hashParams.get('stretch');
    const initPhase = (hashParams.get('phase') as PnfPhaseId | null) ?? 'stretch';
    const initMistake = hashParams.get('mode') === 'mistake';

    if (initSlug && STRETCH_3D_SPECS[initSlug]) {
      this.activeSlug = initSlug;
    }

    if (window.innerWidth <= 900) {
      this.toggleLeftSidebar(true);
    }

    this.selectStretch(this.activeSlug, { initialPhase: initPhase, mistake: initMistake });
    window.addEventListener('hashchange', () => this.handleHashChange());
  }

  private buildShell(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = `
      <div class="app-shell">
        <header class="top-bar">
          <div class="brand-group">
            <button type="button" class="icon-btn active" id="btn-toggle-left" title="展开/收起左侧动作与处方目录">☰ 动作目录</button>
            <span class="brand-title">精准拉伸 · 3D 动态人体解剖伴读系统</span>
            <span class="brand-badge">40 个拉伸动作 · 14 套疼痛处方</span>
          </div>

          <div class="top-controls">
            <button type="button" class="icon-btn" id="btn-prev-stretch" title="上一个拉伸动作">◀ 上一动作</button>
            <button type="button" class="icon-btn" id="btn-next-stretch" title="下一个拉伸动作">下一动作 ▶</button>
            <button type="button" class="icon-btn active" id="btn-toggle-right" title="展开/收起右侧 Step 教练详情栏">📋 步骤面板</button>
            <button type="button" class="icon-btn" id="btn-copy-link" title="复制当前动作 3D 深链">🔗 分享</button>
            <button type="button" class="icon-btn" id="btn-open-copyright">版权说明</button>
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
                placeholder="搜索肌肉、英文、页码或症状…"
              />
            </div>
            <div class="sidebar-list" id="sidebar-list"></div>
          </aside>

          <!-- Column 2: Full-Height 3D Anatomical Stage (100% vertical height!) -->
          <section class="stage-column">
            <div class="viewport-wrap">
              <div class="canvas-mount" id="stage3d-canvas"></div>
              <div class="overlay-mount" id="stage3d-overlays"></div>

              <div class="viewport-hud-top">
                <div class="cam-presets" id="cam-presets"></div>
                <div class="view-toggles">
                  <button type="button" class="hud-chip" id="btn-fit-body" title="自动居中完整显示全身模型（或双击画面）">⌖ 完整居中</button>
                  <button type="button" class="hud-chip" id="btn-toggle-xray">🦴 骨骼深层透视</button>
                  <button type="button" class="hud-chip active" id="btn-toggle-labels">🏷️ 解剖标签</button>
                </div>
              </div>

              <div class="active-pain-hud" id="active-pain-hud" style="display:none;"></div>

              <!-- Compact Floating Playback + Step Pill HUD at bottom of 3D Stage -->
              <div class="viewport-hud-bottom">
                <button type="button" class="hud-play-btn" id="btn-play-pause">⏸ 暂停</button>
                <div class="hud-mini-steps" id="hud-mini-steps">
                  ${[0, 1, 2, 3]
                    .map((idx) => `<button type="button" class="hud-step-pill" data-hud-step="${idx}">S${idx + 1}</button>`)
                    .join('')}
                </div>
                <button type="button" class="hud-chip" id="btn-speed">1.0x</button>
                <div class="hud-strain-inline">
                  <div class="meter-track"><div class="meter-fill" id="strain-fill"></div></div>
                  <strong id="strain-text" style="font-size:11px;">+8.0%</strong>
                </div>
              </div>
            </div>
          </section>

          <!-- Column 3: Right Step-by-Step PNF & Anatomy Inspector Sidebar -->
          <aside class="inspector-sidebar" id="inspector-sidebar">
            <div class="inspector-header">
              <div>
                <div class="coach-eyebrow" id="coach-eyebrow">一、颈肩肌群 · #01/40 · 原书 p.26</div>
                <div class="coach-title" id="coach-title">斜方肌上部 <small>Upper Trapezius</small></div>
              </div>

              <div class="mode-compare-toggle">
                <button type="button" class="compare-btn active-correct" id="btn-mode-correct">✓ 正确动作示范</button>
                <button type="button" class="compare-btn" id="btn-mode-mistake">✕ 常见错误代偿</button>
              </div>
            </div>

            <div class="inspector-scroll">
              <div class="mistake-alert-card" id="mistake-alert-card" style="display:none;">
                <div class="mistake-alert-title" id="mistake-alert-title"></div>
                <div class="mistake-alert-desc" id="mistake-alert-desc"></div>
              </div>

              <div class="section-label-row">
                <span>PNF 四阶段步骤拆解（点击任一步骤定格观察）</span>
              </div>

              <div class="pnf-vertical-timeline" id="pnf-vertical-timeline">
                ${[0, 1, 2, 3]
                  .map(
                    (idx) => `
                  <div class="v-step-card" data-step-idx="${idx}">
                    <div class="v-step-header">
                      <div class="v-step-badge-group">
                        <span class="v-step-num">STEP ${idx + 1}</span>
                        <span class="v-step-title">--</span>
                      </div>
                      <span class="v-step-timer">--s</span>
                    </div>
                    <div class="v-step-detail">
                      <div class="v-step-cue"></div>
                      <div class="v-step-tip"></div>
                    </div>
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

        <div class="modal-backdrop" id="copyright-modal">
          <div class="modal-card">
            <h2>关于本项目 · 版权与医疗免责声明</h2>
            <ul>
              <li><strong>纯净 3D 伴读定位：</strong>本在线系统仅提供程序化生成的三维人体骨骼肌束模型与生物力学动作演示，<strong>不包含任何原书 PDF 文件、原书插图或原文内容</strong>，供读者在阅读《精准拉伸》（<em>Prescriptive Stretching</em>, Kristian Berg / Human Kinetics, 2011）纸质书或正版电子书时对照理解解剖位置与 PNF 发力节奏。请支持购买正版图书。</li>
              <li><strong>开源代码许可：</strong>本仓库中的 Three.js 参数化人体运动学与肌束引擎源代码基于 MIT License 开源。</li>
              <li><strong>非医疗建议声明：</strong>三维动画、角度区间与要点提示仅供运动解剖学习交流，不构成亦不替代临床医疗诊断、物理治疗评估或康复处方。练习中一旦出现关节刺痛、头晕或放射麻木，请立即停止并咨询专业医师或物理治疗师。</li>
            </ul>
            <div style="text-align:right;">
              <button type="button" class="btn-primary" id="btn-close-copyright">我知道了</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.workspaceEl = document.getElementById('workspace')!;
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
    this.renderSidebarList();
  }

  private toggleLeftSidebar(forceCollapse?: boolean): void {
    this.leftCollapsed = forceCollapse ?? !this.leftCollapsed;
    this.workspaceEl.classList.toggle('left-collapsed', this.leftCollapsed);
    document.getElementById('btn-toggle-left')?.classList.toggle('active', !this.leftCollapsed);
  }

  private toggleRightSidebar(forceCollapse?: boolean): void {
    this.rightCollapsed = forceCollapse ?? !this.rightCollapsed;
    this.workspaceEl.classList.toggle('right-collapsed', this.rightCollapsed);
    document.getElementById('btn-toggle-right')?.classList.toggle('active', !this.rightCollapsed);
  }

  private bindEvents(): void {
    document.getElementById('btn-toggle-left')!.addEventListener('click', () => this.toggleLeftSidebar());
    document.getElementById('btn-toggle-right')!.addEventListener('click', () => this.toggleRightSidebar());

    document.getElementById('btn-fit-body')!.addEventListener('click', () => {
      this.stage3D.fitFullBody(false);
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

    document.getElementById('btn-prev-stretch')!.addEventListener('click', () => this.stepStretch(-1));
    document.getElementById('btn-next-stretch')!.addEventListener('click', () => this.stepStretch(1));

    const copyBtn = document.getElementById('btn-copy-link')!;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        copyBtn.textContent = '✓ 已复制';
        setTimeout(() => {
          copyBtn.textContent = '🔗 分享';
        }, 1800);
      } catch {
        // ignore
      }
    });

    this.btnCorrectEl.addEventListener('click', () => this.setMistakeMode(false));
    this.btnMistakeEl.addEventListener('click', () => this.setMistakeMode(true));

    let xray = false;
    const xrayBtn = document.getElementById('btn-toggle-xray')!;
    xrayBtn.addEventListener('click', () => {
      xray = !xray;
      xrayBtn.classList.toggle('active', xray);
      this.stage3D.setXrayMode(xray);
    });

    let labelsOn = true;
    const lblBtn = document.getElementById('btn-toggle-labels')!;
    lblBtn.addEventListener('click', () => {
      labelsOn = !labelsOn;
      lblBtn.classList.toggle('active', labelsOn);
      this.stage3D.setShowLabels(labelsOn);
    });

    const phaseIds: PnfPhaseId[] = ['setup', 'stretch', 'resist', 'deepen'];

    // Vertical Step Cards in Right Dock
    document.querySelectorAll('.v-step-card').forEach((el, idx) => {
      const card = el as HTMLDivElement;
      this.vStepCards.push(card);
      this.vStepTitles.push(card.querySelector('.v-step-title') as HTMLElement);
      this.vStepTimers.push(card.querySelector('.v-step-timer') as HTMLElement);
      this.vStepCues.push(card.querySelector('.v-step-cue') as HTMLElement);
      this.vStepTips.push(card.querySelector('.v-step-tip') as HTMLElement);
      this.vStepBars.push(card.querySelector('.v-step-progress') as HTMLElement);
      card.addEventListener('click', () => {
        this.setMistakeMode(false);
        this.stage3D.setPhase(phaseIds[idx], false);
      });
    });

    // Mini HUD Step Pills in Bottom Floating Bar
    document.querySelectorAll('.hud-step-pill').forEach((el, idx) => {
      const pill = el as HTMLButtonElement;
      this.hudStepPills.push(pill);
      pill.addEventListener('click', () => {
        this.setMistakeMode(false);
        this.stage3D.setPhase(phaseIds[idx], false);
      });
    });

    this.hudPlayBtnEl.addEventListener('click', () => {
      const playing = this.stage3D.togglePlaying();
      this.hudPlayBtnEl.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    });

    const speeds = [1.0, 0.5, 1.5];
    let spIdx = 0;
    this.speedBtnEl.addEventListener('click', () => {
      spIdx = (spIdx + 1) % speeds.length;
      this.stage3D.setSpeed(speeds[spIdx]);
      this.speedBtnEl.textContent = `${speeds[spIdx].toFixed(1)}x`;
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
    const q = this.searchQuery;
    this.sidebarListEl.innerHTML = '';

    if (this.sidebarTab === 'stretches') {
      for (const reg of this.bookIndex.regions) {
        const items = this.bookIndex.stretches.filter(
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
            if (window.innerWidth <= 900) this.toggleLeftSidebar(true);
          });
          sec.appendChild(btn);
        }
        this.sidebarListEl.appendChild(sec);
      }
      return;
    }

    const groups: { key: 'waking' | 'program'; title: string }[] = [
      { key: 'waking', title: '一、晨起常见疼痛（原书 p.119–120）' },
      { key: 'program', title: '二、专项部位疼痛方案（原书 p.121–131）' },
    ];

    for (const grp of groups) {
      const entries = this.bookIndex.painPrograms
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
            const st = this.bookIndex.stretches.find((x) => x.slug === sl);
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
            if (window.innerWidth <= 900) this.toggleLeftSidebar(true);
            return;
          }
          this.activePainIndex = idx;
          if (p.recommendedStretches.length > 0) {
            this.selectStretch(p.recommendedStretches[0]);
          } else {
            this.renderPainHud();
            this.renderSidebarList();
          }
        });
        sec.appendChild(card);
      }
      this.sidebarListEl.appendChild(sec);
    }
  }

  private renderPainHud(): void {
    if (this.activePainIndex < 0 || this.activePainIndex >= this.bookIndex.painPrograms.length) {
      this.painHudEl.style.display = 'none';
      return;
    }
    const prog = this.bookIndex.painPrograms[this.activePainIndex];
    this.painHudEl.style.display = 'flex';
    const chipsHtml = prog.recommendedStretches
      .map((sl) => {
        const st = this.bookIndex.stretches.find((x) => x.slug === sl);
        if (!st) return '';
        return `<button type="button" class="pain-chip ${sl === this.activeSlug ? 'active' : ''}" data-hud-slug="${sl}">${st.chinese}</button>`;
      })
      .join('');

    this.painHudEl.innerHTML = `
      <strong style="color:#7dd3fc;">🩺 ${prog.chinese}（p.${prog.printedPage}）：</strong>
      ${chipsHtml}
      <button type="button" class="pain-chip" id="btn-hud-pain-close" title="清除处方筛选">✕ 退出</button>
    `;

    this.painHudEl.querySelectorAll('[data-hud-slug]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectStretch((btn as HTMLElement).dataset.hudSlug!);
      });
    });
    this.painHudEl.querySelector('#btn-hud-pain-close')?.addEventListener('click', () => {
      this.activePainIndex = -1;
      this.painHudEl.style.display = 'none';
      this.renderSidebarList();
    });
  }

  private stepStretch(delta: -1 | 1): void {
    const curIdx = this.bookIndex.stretches.findIndex((s) => s.slug === this.activeSlug);
    const nextIdx = (curIdx + delta + this.bookIndex.stretches.length) % this.bookIndex.stretches.length;
    this.selectStretch(this.bookIndex.stretches[nextIdx].slug);
  }

  private setMistakeMode(mistake: boolean): void {
    this.stage3D.setMistakeMode(mistake);
    this.btnCorrectEl.classList.toggle('active-correct', !mistake);
    this.btnMistakeEl.classList.toggle('active-mistake', mistake);
    this.mistakeAlertEl.style.display = mistake ? 'flex' : 'none';
  }

  public selectStretch(
    slug: string,
    opts: { initialPhase?: PnfPhaseId; mistake?: boolean } = {}
  ): void {
    const entry = this.bookIndex.stretches.find((s) => s.slug === slug);
    const spec = STRETCH_3D_SPECS[slug];
    if (!entry || !spec) return;

    this.activeSlug = slug;
    this.activeBookEntry = entry;
    this.active3DSpec = spec;

    this.stage3D.loadStretch(spec, opts.initialPhase ?? 'stretch', opts.mistake ?? false);
    this.setMistakeMode(opts.mistake ?? false);
    this.renderCoachStaticMetadata(spec, entry);
    this.renderPainHud();
    this.renderSidebarList();

    history.replaceState(null, '', `#stretch=${slug}`);
  }

  private renderCoachStaticMetadata(spec: Stretch3DSpec, entry: BookStretchEntry): void {
    this.coachEyebrowEl.textContent = `${entry.regionName} · 动作 #${String(entry.order).padStart(2, '0')}/40 · 原书第 ${entry.printedPage} 页`;
    this.coachTitleEl.innerHTML = `${spec.nameZh} <small>${spec.nameEn}</small>`;

    this.camPresetsEl.innerHTML = '';
    spec.cameras.forEach((cam, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `hud-chip ${i === 0 ? 'active' : ''}`;
      chip.textContent = `🎥 ${cam.label}`;
      chip.addEventListener('click', () => {
        this.camPresetsEl.querySelectorAll('.hud-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        this.stage3D.setCameraPreset(cam, false);
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
      this.hudStepPills[idx].textContent = `${idx + 1}.${shortName}`;
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

  private handleTelemetry(t: StageTelemetry): void {
    const spec = this.active3DSpec;

    this.hudPlayBtnEl.textContent = t.isPlaying ? '⏸ 暂停' : '▶ 播放';

    // Update Vertical Step Cards & Bottom HUD Step Pills
    this.vStepCards.forEach((card, idx) => {
      const active = !t.isMistake && idx === t.phaseIndex;
      card.classList.toggle('active', active);
      this.hudStepPills[idx].classList.toggle('active', active);
      this.vStepBars[idx].style.width = active
        ? `${(t.phaseProgress * 100).toFixed(1)}%`
        : idx < t.phaseIndex && !t.isMistake
        ? '100%'
        : '0%';
      this.vStepTimers[idx].textContent = active
        ? `${Math.ceil(t.phaseRemainingSec)}s`
        : `${spec.phases[idx].durationSec}s`;
    });

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

  private handleHashChange(): void {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const slug = params.get('stretch');
    if (slug && STRETCH_3D_SPECS[slug] && slug !== this.activeSlug) {
      const ph = (params.get('phase') as PnfPhaseId | null) ?? undefined;
      const mistake = params.get('mode') === 'mistake';
      this.selectStretch(slug, { initialPhase: ph, mistake });
    }
  }
}

void new Pure3DCompanionApp().init();

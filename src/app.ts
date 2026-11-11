import * as THREE from 'three';
import { buildConstellation, type Constellation, type StarBody } from './galaxy/constellation';
import { lanesFrom, scannableFiles, type Lane } from './galaxy/imports';
import { colorFor } from './galaxy/languages';
import { buildSystem, type PlanetBody, type SystemModel } from './galaxy/system';
import { GitHubError, NotFoundError, RateLimitError, type GitHubClient, type RateLimit } from './github/client';
import type { CacheStore } from './github/cache';
import type { GhRepo, GhWeek } from './github/types';
import { ConstellationView, type StarPickable } from './scene/constellation-view';
import { reducedMotion, type Pickable, Stage } from './scene/stage';
import { SystemView, type SystemPickable } from './scene/system-view';
import { Tour } from './tour';
import { byId, compact, el, extLink, formatBytes, formatNumber, timeAgo } from './ui/dom';

const TOKEN_KEY = 'starmap.token';
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const DOUBLE_CLICK_MS = 380;

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function saveToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: the token lasts for this visit only */
  }
}

type Mode = 'landing' | 'constellation' | 'system';

/** Wires GitHub data, the 3D stage and the HTML panels together. */
export class App {
  private readonly stage: Stage;
  private mode: Mode = 'landing';
  private constellation: Constellation | null = null;
  private constellationView: ConstellationView | null = null;
  private systemView: SystemView | null = null;
  private system: SystemModel | null = null;
  private activity: GhWeek[] | null | 'loading' = null;
  private week = 51;
  private playTimer: number | null = null;
  private lanes: Lane[] = [];
  private scanning: string | null = null;
  private filterText = '';
  private filterLanguage: string | null = null;
  private selected: Pickable | null = null;
  private hovered: Pickable | null = null;
  private savedCamera: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  /** Bumped on every navigation so slow responses for an old view are ignored. */
  private seq = 0;
  private lastClick = { id: '', at: 0 };
  private tour: Tour | null = null;

  private readonly panel = byId('panel');
  private readonly timeline = byId('timeline');
  private readonly crumbs = byId('crumbs');
  private readonly tooltip = byId('tooltip');
  private readonly rate = byId<HTMLButtonElement>('rate');

  constructor(
    private readonly client: GitHubClient,
    private readonly cache: CacheStore,
  ) {
    this.stage = new Stage(byId<HTMLCanvasElement>('scene'), byId('labels'));
    this.bindChrome();
    this.bindCanvas();
    this.client.onRateChange((rate) => this.renderRate(rate));
    addEventListener('popstate', () => void this.route());
    addEventListener('keydown', (event) => {
      if (document.querySelector('dialog[open]')) return;
      const typing = event.target instanceof HTMLInputElement;
      if (this.tour?.active && !typing) {
        const actions: Record<string, () => void> = {
          ' ': () => this.tour!.next(),
          ArrowRight: () => this.tour!.next(),
          ArrowLeft: () => this.tour!.prev(),
          Escape: () => this.tour!.stop(),
        };
        const action = actions[event.key];
        if (action) {
          event.preventDefault();
          action();
        }
        return;
      }
      if (event.key !== 'Escape') return;
      if (this.selected) this.select(null);
      else if (this.mode === 'system') void this.leaveSystem();
    });
  }

  /** Show whatever the URL asks for: ?user=login&repo=name. */
  async route() {
    const params = new URLSearchParams(location.search);
    const user = params.get('user');
    const repo = params.get('repo');
    if (!user || !LOGIN.test(user)) return this.showLanding();
    if (this.constellation?.user.login.toLowerCase() !== user.toLowerCase()) {
      const ok = await this.openUser(user, false);
      if (!ok) return;
    }
    if (repo) {
      const star = this.constellation?.stars.find((s) => s.repo.name.toLowerCase() === repo.toLowerCase());
      if (star) await this.enterSystem(star, false);
      else this.toast(`@${user} has no public repo named “${repo}”.`);
    } else if (this.mode === 'system') await this.leaveSystem(false);
  }

  // ---------------------------------------------------------------- navigation

  private showLanding() {
    this.tour?.stop(false);
    this.seq++;
    this.mode = 'landing';
    byId('landing').hidden = false;
    byId('search').hidden = true;
    this.panel.hidden = true;
    this.timeline.hidden = true;
    this.crumbs.replaceChildren();
    byId<HTMLInputElement>('landing-input').focus();
  }

  private async openUser(login: string, push = true): Promise<boolean> {
    if (!LOGIN.test(login)) {
      this.toast('That does not look like a GitHub username.');
      return false;
    }
    const seq = ++this.seq;
    this.loading(`Mapping @${login}'s constellation…`);
    try {
      const user = await this.client.user(login);
      const repos = await this.client.repos(user);
      if (seq !== this.seq) return false;
      if (push) this.navigate({ user: user.login });
      this.constellation = buildConstellation(user, repos);
      this.filterText = '';
      this.filterLanguage = null;
      byId('landing').hidden = true;
      byId('search').hidden = false;
      byId<HTMLInputElement>('search-input').value = '';
      this.showConstellation();
      if (!repos.length) this.toast(`@${user.login} has no public repositories yet. An empty sky!`);
      return true;
    } catch (error) {
      if (seq === this.seq) {
        this.fail(error);
        if (this.mode === 'landing') byId('landing').hidden = false;
      }
      return false;
    } finally {
      if (seq === this.seq) this.loading(null);
    }
  }

  private showConstellation(restoreCamera = false) {
    const constellation = this.constellation!;
    this.tour?.stop(false);
    this.stopPlayback();
    this.mode = 'constellation';
    this.system = null;
    this.systemView = null;
    this.selected = null;
    this.timeline.hidden = true;
    const view = new ConstellationView(constellation);
    this.constellationView = view;
    const extent = Math.max(60, ...constellation.stars.map((s) => Math.hypot(s.position.x, s.position.y, s.position.z)));
    this.stage.controls.maxDistance = extent * 5;
    this.stage.setView(
      view,
      restoreCamera && this.savedCamera
        ? this.savedCamera.position
        : new THREE.Vector3(0, 0.38, 1).normalize().multiplyScalar(extent * 1.6),
      restoreCamera && this.savedCamera ? this.savedCamera.target : new THREE.Vector3(),
    );
    this.applyFilter();
    this.renderCrumbs();
    this.renderPanel();
  }

  private async enterSystem(star: StarBody, push = true) {
    this.tour?.stop(false);
    const seq = ++this.seq;
    const repo = star.repo;
    this.stopPlayback();
    const body = this.constellationView?.pickables().find((p) => p.id === star.id);
    if (this.mode === 'constellation' && body) {
      this.savedCamera = { position: this.stage.camera.position.clone(), target: this.stage.controls.target.clone() };
    }
    const fly = (async () => {
      if (this.mode !== 'constellation' || !body) return;
      const at = this.stage.positionOf(body);
      const away = this.stage.camera.position.clone().sub(at).normalize().multiplyScalar(star.radius * 5);
      await this.stage.flyTo(at.clone().add(away), at, 1.2);
    })();
    const slow = setTimeout(() => seq === this.seq && this.loading(`Charting ${repo.name}…`), 500);
    try {
      const [tree] = await Promise.all([this.client.tree(repo), fly]);
      if (seq !== this.seq) return;
      if (push) this.navigate({ user: repo.owner.login, repo: repo.name });
      this.system = buildSystem(repo, tree);
      this.lanes = [];
      this.scanning = null;
      this.scannedEmpty.clear();
      this.mode = 'system';
      const view = new SystemView(this.system);
      this.systemView = view;
      this.constellationView = null;
      const extent = (this.system.planets.at(-1)?.orbitRadius ?? this.system.beltRadius) + 6;
      this.stage.controls.maxDistance = extent * 6;
      const arrive = new THREE.Vector3(0, extent * 0.55, extent * 1.25);
      this.stage.setView(view, arrive.clone().multiplyScalar(2.2), new THREE.Vector3());
      void this.stage.flyTo(arrive, new THREE.Vector3(), 1.6);
      this.selected = null;
      this.renderCrumbs();
      this.renderPanel();
      void this.loadActivity(repo, seq);
    } catch (error) {
      if (seq !== this.seq) return;
      this.fail(error);
      if (this.mode === 'constellation' && this.savedCamera)
        void this.stage.flyTo(this.savedCamera.position, this.savedCamera.target, 0.9);
    } finally {
      clearTimeout(slow);
      if (seq === this.seq) this.loading(null);
    }
  }

  private async leaveSystem(push = true) {
    if (!this.constellation) return this.showLanding();
    this.seq++;
    if (push) this.navigate({ user: this.constellation.user.login });
    this.showConstellation(true);
  }

  private navigate(params: { user: string; repo?: string }) {
    const search = new URLSearchParams(params as Record<string, string>).toString();
    history.pushState(null, '', `${location.pathname}?${search}`);
  }

  // ---------------------------------------------------------------- activity + imports

  private async loadActivity(repo: GhRepo, seq: number) {
    this.activity = 'loading';
    this.renderTimeline();
    try {
      const weeks = await this.client.activity(repo);
      if (seq !== this.seq) return;
      this.activity = weeks && weeks.length ? weeks : null;
    } catch (error) {
      if (seq !== this.seq) return;
      this.activity = null;
      if (error instanceof RateLimitError) this.fail(error);
    }
    this.week = Array.isArray(this.activity) ? this.activity.length - 1 : 0;
    this.renderTimeline();
    this.applyWeek();
    if (Array.isArray(this.activity) && !reducedMotion()) this.play(true);
    this.renderPanel();
  }

  private applyWeek() {
    if (!this.systemView || !Array.isArray(this.activity)) return this.systemView?.setFlare(0);
    const max = Math.max(1, ...this.activity.map((w) => w.total));
    this.systemView.setFlare((this.activity[this.week]?.total ?? 0) / max);
    this.timeline.querySelectorAll<HTMLElement>('.bar').forEach((bar, i) => bar.classList.toggle('bar--on', i === this.week));
    const label = this.timeline.querySelector('.week-label');
    const week = this.activity[this.week];
    if (label && week) {
      const date = new Date(week.week * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      label.textContent = `Week of ${date} · ${week.total} commit${week.total === 1 ? '' : 's'}`;
    }
  }

  private play(fromStart = false) {
    if (!Array.isArray(this.activity)) return;
    this.stopPlayback();
    const weeks = this.activity.length;
    if (fromStart || this.week >= weeks - 1) this.week = 0;
    this.applyWeek();
    this.playTimer = window.setInterval(() => {
      if (this.week >= weeks - 1) return this.stopPlayback();
      this.week++;
      this.applyWeek();
    }, 140);
    this.timeline.querySelector('.play')?.replaceChildren('❚❚');
  }

  private stopPlayback() {
    if (this.playTimer !== null) clearInterval(this.playTimer);
    this.playTimer = null;
    this.timeline.querySelector('.play')?.replaceChildren('▶');
  }

  private async scanImports(planet: PlanetBody) {
    const system = this.system!;
    const seq = this.seq;
    const files = scannableFiles(planet.files);
    this.scanning = planet.id;
    this.renderPanel();
    const sources: { path: string; source: string }[] = [];
    let failed = 0;
    const queue = [...files];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let file = queue.shift(); file; file = queue.shift()) {
          try {
            sources.push({ path: file.path, source: await this.client.raw(system.repo, file.path) });
          } catch {
            failed++;
          }
        }
      }),
    );
    if (seq !== this.seq || this.system !== system) return;
    const lanes = lanesFrom(planet.id, sources, {
      topDirs: new Set(system.planets.map((p) => p.id)),
      fullName: system.repo.full_name.toLowerCase(),
    });
    this.lanes = [...this.lanes.filter((l) => l.from !== planet.id), ...lanes];
    this.systemView?.setLanes(this.lanes);
    this.scanning = null;
    if (failed) this.toast(`${failed} file${failed === 1 ? '' : 's'} could not be read.`);
    this.renderPanel();
  }

  // ---------------------------------------------------------------- selection + input

  private startTour() {
    if (!this.constellation || !this.constellationView) return;
    this.select(null);
    this.tour = new Tour(this.stage, this.constellationView, this.constellation, byId('tour'), {
      enter: (star) => void this.enterSystem(star),
      ended: () => {
        this.tour = null;
        this.renderPanel();
      },
    });
    this.tour.start();
    this.renderPanel();
  }

  private select(body: Pickable | null) {
    this.selected = body;
    if (this.mode === 'constellation')
      this.constellationView?.setMarker(body ? (body as StarPickable).index ?? null : null);
    this.stage.highlight([body?.id, this.hovered?.id].filter((id): id is string => !!id));
    this.renderPanel();
  }

  private activate(body: Pickable) {
    const now = performance.now();
    const isDouble = this.lastClick.id === body.id && now - this.lastClick.at < DOUBLE_CLICK_MS;
    this.lastClick = { id: body.id, at: now };
    this.select(body);
    if (!isDouble) return;
    if (this.mode === 'constellation') {
      const star = this.constellation?.stars.find((s) => s.id === body.id);
      if (star) void this.enterSystem(star);
    } else {
      const at = this.stage.positionOf(body);
      const away = this.stage.camera.position.clone().sub(at).normalize().multiplyScalar(body.radius * 8 + 6);
      void this.stage.flyTo(at.clone().add(away), at, 0.9);
    }
  }

  private bindCanvas() {
    const canvas = byId<HTMLCanvasElement>('scene');
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      down = null;
      if (this.mode === 'landing') return;
      const body = this.stage.pickAt(e.clientX, e.clientY);
      if (body) {
        this.tour?.stop(false);
        this.activate(body);
      }
      else if (this.selected) this.select(null);
    });
    let pending = false;
    canvas.addEventListener('pointermove', (e) => {
      if (pending || e.buttons) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const body = this.mode === 'landing' ? null : this.stage.pickAt(e.clientX, e.clientY);
        if (body?.id !== this.hovered?.id) {
          this.hovered = body;
          this.stage.highlight([body?.id, this.selected?.id].filter((id): id is string => !!id));
        }
        canvas.style.cursor = body ? 'pointer' : '';
        this.showTooltip(body, e.clientX, e.clientY);
      });
    });
    canvas.addEventListener('pointerleave', () => this.showTooltip(null, 0, 0));
  }

  private showTooltip(body: Pickable | null, x: number, y: number) {
    const text = body ? this.tooltipText(body) : null;
    this.tooltip.hidden = !text;
    if (!text) return;
    this.tooltip.textContent = text;
    this.tooltip.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  }

  private tooltipText(body: Pickable): string | null {
    if (this.mode === 'constellation') {
      const star = this.constellation?.stars.find((s) => s.id === body.id);
      if (!star) return null;
      const r = star.repo;
      return [r.name, r.language, r.stargazers_count ? `★ ${formatNumber(r.stargazers_count)}` : null, `pushed ${timeAgo(r.pushed_at)}`]
        .filter(Boolean)
        .join(' · ');
    }
    const picked = body as SystemPickable;
    if (picked.kind === 'planet')
      return `${picked.planet.name}/ · ${formatNumber(picked.planet.fileCount)} files · ${formatBytes(picked.planet.bytes)}`;
    return this.system ? `${this.system.repo.name} · ${formatNumber(this.system.totalFiles)} files` : null;
  }

  private bindChrome() {
    const landing = byId<HTMLFormElement>('landing-form');
    landing.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.openUser(byId<HTMLInputElement>('landing-input').value.trim().replace(/^@/, ''));
    });
    byId('landing').querySelectorAll<HTMLButtonElement>('[data-user]').forEach((button) =>
      button.addEventListener('click', () => void this.openUser(button.dataset.user!)),
    );
    byId<HTMLFormElement>('search').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = byId<HTMLInputElement>('search-input');
      const login = input.value.trim().replace(/^@/, '');
      if (login) void this.openUser(login);
      input.blur();
    });

    const settings = byId<HTMLDialogElement>('settings');
    const tokenInput = byId<HTMLInputElement>('token-input');
    const status = byId('token-status');
    const refreshStatus = () => {
      status.textContent = this.client.hasToken ? 'A token is saved in this browser.' : 'No token saved.';
    };
    const openSettings = () => {
      tokenInput.value = '';
      refreshStatus();
      settings.showModal();
    };
    byId('settings-btn').addEventListener('click', openSettings);
    this.rate.addEventListener('click', openSettings);
    byId('token-save').addEventListener('click', () => {
      const token = tokenInput.value.trim();
      if (!token) return tokenInput.focus();
      this.client.setToken(token);
      saveToken(token);
      tokenInput.value = '';
      refreshStatus();
      this.rate.hidden = true;
      this.toast('Token saved. Your next request will use it.');
    });
    byId('token-clear').addEventListener('click', () => {
      this.client.setToken(null);
      saveToken(null);
      refreshStatus();
      this.rate.hidden = true;
      this.toast('Token removed.');
    });
    byId('cache-clear').addEventListener('click', async () => {
      await this.cache.clear();
      this.toast('Cache cleared.');
    });
    byId('legend-btn').addEventListener('click', () => byId<HTMLDialogElement>('legend').showModal());
  }

  // ---------------------------------------------------------------- rendering

  private renderRate(rate: RateLimit) {
    this.rate.hidden = false;
    this.rate.classList.toggle('rate--low', rate.remaining < Math.max(5, rate.limit * 0.1));
    const reset = new Date(rate.resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    this.rate.replaceChildren(el('span', { class: 'rate-dot', 'aria-hidden': 'true' }), `${formatNumber(rate.remaining)}/${formatNumber(rate.limit)}`);
    this.rate.title = `GitHub API: ${rate.remaining} of ${rate.limit} requests left, resets at ${reset}. Click to add a token.`;
  }

  private renderCrumbs() {
    const c = this.constellation;
    if (!c) return this.crumbs.replaceChildren();
    const userCrumb =
      this.mode === 'system'
        ? el('button', { type: 'button', class: 'crumb', on: { click: () => void this.leaveSystem() } }, `@${c.user.login}`)
        : el('span', { class: 'crumb crumb--here' }, `@${c.user.login}`);
    this.crumbs.replaceChildren(
      ...compact([userCrumb, this.mode === 'system' && this.system ? el('span', { class: 'crumb crumb--here' }, this.system.repo.name) : null]),
    );
  }

  private renderPanel() {
    if (this.mode === 'landing') return;
    if (this.tour?.active) {
      this.panel.hidden = true;
      return;
    }
    this.panel.hidden = false;
    const content =
      this.mode === 'constellation'
        ? this.selected
          ? this.starPanel(this.selected)
          : this.userPanel()
        : this.selected && (this.selected as SystemPickable).kind === 'planet'
          ? this.planetPanel((this.selected as SystemPickable & { kind: 'planet' }).planet)
          : this.repoPanel();
    this.panel.replaceChildren(...content);
  }

  private userPanel(): Node[] {
    const c = this.constellation!;
    const u = c.user;
    const filter = el('input', {
      type: 'search',
      class: 'filter',
      placeholder: 'Filter repos',
      'aria-label': 'Filter repositories by name',
      value: this.filterText,
    });
    filter.addEventListener('input', () => {
      this.filterText = filter.value;
      this.applyFilter();
    });
    const chips = el(
      'div',
      { class: 'chips' },
      ...c.languages.slice(0, 10).map(([language, count]) => {
        const chip = el(
          'button',
          { type: 'button', class: `chip${this.filterLanguage === language ? ' chip--on' : ''}`, 'aria-pressed': String(this.filterLanguage === language) },
          el('span', { class: 'swatch', style: `background:${colorFor(language)}` }),
          `${language} ${count}`,
        );
        chip.addEventListener('click', () => {
          this.filterLanguage = this.filterLanguage === language ? null : language;
          this.applyFilter();
          this.renderPanel();
        });
        return chip;
      }),
    );
    return compact([
      el(
        'div',
        { class: 'user' },
        el('img', { class: 'avatar', src: u.avatar_url, alt: '', width: 56, height: 56 }),
        el('div', {}, el('h2', {}, u.name || u.login), extLink(u.html_url, `@${u.login}`)),
      ),
      u.bio ? el('p', { class: 'bio' }, u.bio) : null,
      el(
        'p',
        { class: 'stats' },
        `${formatNumber(c.stars.length)} public repo${c.stars.length === 1 ? '' : 's'}`,
        u.public_repos > c.stars.length ? ` (showing the ${c.stars.length} most recently pushed)` : '',
      ),
      c.stars.length ? filter : null,
      c.languages.length ? chips : null,
      c.stars.length
        ? el('button', { type: 'button', class: 'primary', on: { click: () => this.startTour() } }, 'Take the tour ✦')
        : null,
      el('p', { class: 'hint' }, 'Click a star to inspect it. Double-click to fly in.'),
    ]);
  }

  private starPanel(body: Pickable): Node[] {
    const star = this.constellation!.stars.find((s) => s.id === body.id)!;
    const r = star.repo;
    return compact([
      el('button', { type: 'button', class: 'back', on: { click: () => this.select(null) } }, `← @${r.owner.login}`),
      el('h2', {}, r.name),
      r.description ? el('p', { class: 'bio' }, r.description) : null,
      el(
        'div',
        { class: 'chips' },
        r.language ? el('span', { class: 'chip' }, el('span', { class: 'swatch', style: `background:${star.color}` }), r.language) : null,
        el('span', { class: 'chip' }, `★ ${formatNumber(r.stargazers_count)}`),
        el('span', { class: 'chip' }, `⑂ ${formatNumber(r.forks_count)}`),
        el('span', { class: 'chip' }, formatBytes(r.size * 1024)),
        r.fork ? el('span', { class: 'chip chip--muted' }, 'fork') : null,
        r.archived ? el('span', { class: 'chip chip--muted' }, 'archived') : null,
      ),
      el('p', { class: 'stats' }, `Created ${timeAgo(r.created_at)} · pushed ${timeAgo(r.pushed_at)}`),
      el('button', { type: 'button', class: 'primary', on: { click: () => void this.enterSystem(star) } }, 'Fly into system →'),
      extLink(r.html_url, 'Open on GitHub ↗'),
    ]);
  }

  private repoPanel(): Node[] {
    const s = this.system!;
    const r = s.repo;
    const commits = Array.isArray(this.activity) ? this.activity.reduce((sum, w) => sum + w.total, 0) : null;
    const notes: string[] = [];
    if (s.truncated) notes.push('GitHub cut this tree short because the repo is very large, so some files are missing.');
    if (s.hiddenMoons) notes.push(`${formatNumber(s.hiddenMoons)} smaller files are not drawn, to keep things smooth.`);
    if (s.mergedDirectories) notes.push(`${s.mergedDirectories} smaller folders are merged into the “…other” planet.`);
    return compact([
      el('button', { type: 'button', class: 'back', on: { click: () => void this.leaveSystem() } }, `← @${r.owner.login}`),
      el('h2', {}, r.name),
      r.description ? el('p', { class: 'bio' }, r.description) : null,
      el(
        'dl',
        { class: 'facts' },
        el('dt', {}, 'Planets'), el('dd', {}, formatNumber(s.planets.length)),
        el('dt', {}, 'Moons'), el('dd', {}, formatNumber(s.totalFiles)),
        el('dt', {}, 'Commits, 52 wks'), el('dd', {}, commits === null ? '…' : formatNumber(commits)),
        el('dt', {}, 'Branch'), el('dd', {}, r.default_branch),
      ),
      ...notes.map((note) => el('p', { class: 'note' }, note)),
      s.planets.length
        ? el('p', { class: 'hint' }, 'Click a planet to see its folder and scan its imports.')
        : el('p', { class: 'hint' }, 'All files live at the root, so they form the belt around the star.'),
      extLink(r.html_url, 'Open on GitHub ↗'),
    ]);
  }

  private planetPanel(planet: PlanetBody): Node[] {
    const s = this.system!;
    const scannable = scannableFiles(planet.files);
    const out = this.lanes.filter((l) => l.from === planet.id);
    const scanned = this.lanes.some((l) => l.from === planet.id) || this.scannedEmpty.has(planet.id);
    const scanning = this.scanning === planet.id;
    const scan = el(
      'button',
      { type: 'button', class: 'primary', disabled: scanning || !scannable.length },
      scanning ? 'Scanning…' : scanned ? 'Rescan imports' : `Scan imports (${scannable.length} files)`,
    );
    scan.addEventListener('click', async () => {
      await this.scanImports(planet);
      if (!this.lanes.some((l) => l.from === planet.id)) {
        this.scannedEmpty.add(planet.id);
        this.renderPanel();
      }
    });
    return compact([
      el('button', { type: 'button', class: 'back', on: { click: () => this.select(null) } }, `← ${s.repo.name}`),
      el('h2', {}, `${planet.name}/`),
      el(
        'div',
        { class: 'chips' },
        planet.language ? el('span', { class: 'chip' }, el('span', { class: 'swatch', style: `background:${planet.color}` }), planet.language) : null,
        el('span', { class: 'chip' }, `${formatNumber(planet.fileCount)} files`),
        el('span', { class: 'chip' }, formatBytes(planet.bytes)),
      ),
      planet.subdirs.length
        ? el('div', {}, el('h3', {}, 'Largest folders'), el('ul', { class: 'list' }, ...planet.subdirs.map((d) => el('li', {}, el('span', {}, `${d.name}/`), el('span', { class: 'muted' }, formatNumber(d.fileCount))))))
        : null,
      el('h3', {}, 'Trade lanes'),
      scannable.length
        ? el('p', { class: 'muted small' }, `Reads up to ${scannable.length} source files from raw.githubusercontent.com, which does not use your API budget.`)
        : el('p', { class: 'muted small' }, 'No TypeScript, JavaScript, Python, Rust or Go files to scan here.'),
      scan,
      out.length
        ? el('ul', { class: 'list' }, ...out.map((l) => el('li', {}, el('span', {}, `→ ${l.to}/`), el('span', { class: 'muted' }, `${l.count} import${l.count === 1 ? '' : 's'}`))))
        : scanned && !scanning
          ? el('p', { class: 'muted small' }, 'No imports into other top-level folders found.')
          : null,
      planet.id === '…other' ? null : extLink(`${s.repo.html_url}/tree/${encodeURIComponent(s.repo.default_branch)}/${encodeURIComponent(planet.name)}`, 'Open folder on GitHub ↗'),
    ]);
  }

  private readonly scannedEmpty = new Set<string>();

  private renderTimeline() {
    if (this.mode !== 'system') return;
    this.timeline.hidden = false;
    if (this.activity === 'loading') {
      this.timeline.replaceChildren(el('p', { class: 'muted small' }, 'Loading a year of commits…'));
      return;
    }
    if (!this.activity) {
      const retry = el('button', { type: 'button', class: 'ghost' }, 'Try again');
      retry.addEventListener('click', () => this.system && void this.loadActivity(this.system.repo, this.seq));
      this.timeline.replaceChildren(
        el('p', { class: 'muted small' }, 'GitHub is still computing commit activity for this repo. It is usually ready within a minute.'),
        retry,
      );
      return;
    }
    const weeks = this.activity;
    const max = Math.max(1, ...weeks.map((w) => w.total));
    const play = el('button', { type: 'button', class: 'play', 'aria-label': 'Play the year' }, '▶');
    play.addEventListener('click', () => (this.playTimer === null ? this.play() : this.stopPlayback()));
    const bars = el(
      'div',
      { class: 'bars', role: 'slider', tabindex: 0, 'aria-label': 'Week', 'aria-valuemin': 0, 'aria-valuemax': weeks.length - 1 },
      ...weeks.map((w, i) => {
        const bar = el('button', { type: 'button', class: 'bar', tabindex: -1, 'aria-label': `Week ${i + 1}: ${w.total} commits` });
        bar.style.setProperty('--h', `${Math.max(4, (w.total / max) * 100)}%`);
        bar.addEventListener('click', () => {
          this.stopPlayback();
          this.week = i;
          this.applyWeek();
        });
        bar.addEventListener('pointerenter', (e) => {
          if (!e.buttons) return;
          this.stopPlayback();
          this.week = i;
          this.applyWeek();
        });
        return bar;
      }),
    );
    bars.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      this.stopPlayback();
      this.week = Math.max(0, Math.min(weeks.length - 1, this.week + step));
      this.applyWeek();
    });
    this.timeline.replaceChildren(play, el('div', { class: 'timeline-main' }, bars, el('p', { class: 'week-label' })));
  }

  private applyFilter() {
    const text = this.filterText.trim().toLowerCase();
    const language = this.filterLanguage;
    this.constellationView?.setFilter(
      text || language
        ? (star) =>
            (!text || star.repo.name.toLowerCase().includes(text) || (star.repo.description ?? '').toLowerCase().includes(text)) &&
            (!language || star.repo.language === language)
        : null,
    );
  }

  // ---------------------------------------------------------------- feedback

  private loading(text: string | null) {
    const overlay = byId('loading');
    overlay.hidden = text === null;
    if (text) byId('loading-text').textContent = text;
  }

  private toastTimer: number | null = null;
  private toast(message: string) {
    const toast = byId('toast');
    toast.textContent = message;
    toast.hidden = false;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (toast.hidden = true), 6000);
  }

  private fail(error: unknown) {
    if (error instanceof NotFoundError && error.message.startsWith('User @'))
      this.toast(`No GitHub user named ${error.message.slice(5).replace(' was not found on GitHub.', '')}.`);
    else if (error instanceof GitHubError) this.toast(error.message);
    else {
      console.error(error);
      this.toast('Could not reach GitHub. Check your connection and try again.');
    }
  }
}

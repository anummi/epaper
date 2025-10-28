'use strict';

const maxScale = 4;
const minScale = 1;
const scaleStep = 0.5;
const articleBaseUrl = 'https://sandbox-devtest2.anygraaf.net/';
const SETTINGS_STORAGE_KEY = 'epaper-settings';
const SUPPORTED_LANGUAGES = {
  fi: 'fi-FI',
  en: 'en-US'
};

const state = {
  config: null,
  imagePaths: [],
  pageMaps: [],
  pageArticles: [],
  articleLookup: new Map(),
  articlePageLookup: new Map(),
  archiveItems: [],
  archiveLoaded: false,
  currentIssuePath: null,
  slideDefinitions: [],
  slides: [],
  currentSlide: 0,
  activePageIndex: 0,
  articleOrder: [],
  currentArticleId: null,
  orientation: null,
  isCompact: false,
  viewBox: null,
  zoom: {
    scale: 1,
    translateX: 0,
    translateY: 0
  },
  resizeTimer: null,
  listenersAttached: false,
  settings: {
    language: 'fi',
    darkMode: false
  },
  dom: {}
};

const panState = {
  active: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  baseX: 0,
  baseY: 0
};

const swipeState = {
  pointerId: null,
  startX: 0,
  startY: 0,
  startTime: 0,
  isTracking: false,
  isSwipe: false
};

function normalizeLanguage(value) {
  if (!value) {
    return null;
  }
  const lower = String(value).toLowerCase();
  if (lower.startsWith('fi')) {
    return 'fi';
  }
  if (lower.startsWith('en')) {
    return 'en';
  }
  return null;
}

function getLocale(language) {
  return SUPPORTED_LANGUAGES[language] || SUPPORTED_LANGUAGES.fi;
}

function getLocalizedValue(source, fallback = '') {
  if (typeof source === 'string') {
    return source;
  }
  if (source && typeof source === 'object') {
    const lang = state.settings.language || 'fi';
    if (source[lang]) {
      return source[lang];
    }
    const configLang = normalizeLanguage(state.config?.lang);
    if (configLang && source[configLang]) {
      return source[configLang];
    }
    if (source.fi) {
      return source.fi;
    }
    if (source.en) {
      return source.en;
    }
    const first = Object.values(source)[0];
    if (typeof first === 'string') {
      return first;
    }
  }
  return fallback;
}

function resolveLabel(key, fallback = '') {
  const labels = state.config?.labels || {};
  return getLocalizedValue(labels[key], fallback);
}

function getNavigationLabelByAction(action) {
  if (!action) {
    return '';
  }
  const items = Array.isArray(state.config?.navigation) ? state.config.navigation : [];
  const entry = items.find(item => item && item.action === action);
  if (!entry) {
    return '';
  }
  return getLocalizedValue(entry.label, '');
}

function loadStoredSettings() {
  try {
    const raw = window.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed;
  } catch (error) {
    console.warn('Asetusten lukeminen epäonnistui:', error);
    return {};
  }
}

function saveSettings() {
  try {
    const payload = {
      language: state.settings.language,
      darkMode: state.settings.darkMode
    };
    window.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('Asetusten tallentaminen epäonnistui:', error);
  }
}

function buildLayout() {
  const root = document.getElementById('app-root') || document.body;
  if (!root) {
    return;
  }
  root.innerHTML = '';

  const shell = document.createElement('div');
  shell.className = 'app-shell';
  root.appendChild(shell);

  const menuBar = document.createElement('header');
  menuBar.className = 'menu-bar menu-top';
  shell.appendChild(menuBar);

  const menuContent = document.createElement('div');
  menuContent.className = 'menu-content';
  menuContent.dataset.role = 'menu';
  menuBar.appendChild(menuContent);

  const stage = document.createElement('main');
  stage.className = 'page-stage';
  shell.appendChild(stage);

  const navPrev = document.createElement('button');
  navPrev.type = 'button';
  navPrev.className = 'nav-button nav-prev';
  stage.appendChild(navPrev);

  const pageTrack = document.createElement('div');
  pageTrack.className = 'page-track';
  pageTrack.setAttribute('aria-live', 'polite');
  stage.appendChild(pageTrack);

  const navNext = document.createElement('button');
  navNext.type = 'button';
  navNext.className = 'nav-button nav-next';
  stage.appendChild(navNext);

  const zoomMenu = document.createElement('div');
  zoomMenu.className = 'zoom-menu';
  zoomMenu.setAttribute('aria-hidden', 'true');
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.className = 'zoom-button zoom-out';
  zoomOut.textContent = '−';
  zoomMenu.appendChild(zoomOut);
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.className = 'zoom-button zoom-in';
  zoomIn.textContent = '+';
  zoomMenu.appendChild(zoomIn);
  const zoomReset = document.createElement('button');
  zoomReset.type = 'button';
  zoomReset.className = 'zoom-button zoom-reset';
  zoomMenu.appendChild(zoomReset);
  shell.appendChild(zoomMenu);

  const allPages = document.createElement('aside');
  allPages.className = 'all-pages';
  allPages.setAttribute('aria-hidden', 'true');
  const allPagesHeader = document.createElement('header');
  allPagesHeader.className = 'all-pages__header';
  const allPagesTitle = document.createElement('h2');
  allPagesHeader.appendChild(allPagesTitle);
  const allPagesClose = document.createElement('button');
  allPagesClose.type = 'button';
  allPagesClose.className = 'all-pages__close';
  allPagesClose.textContent = '×';
  allPagesHeader.appendChild(allPagesClose);
  const allPagesGrid = document.createElement('div');
  allPagesGrid.className = 'all-pages__grid';
  allPages.appendChild(allPagesHeader);
  allPages.appendChild(allPagesGrid);
  shell.appendChild(allPages);

  const archivePanel = document.createElement('aside');
  archivePanel.className = 'archive-panel';
  archivePanel.setAttribute('aria-hidden', 'true');
  const archiveDialog = document.createElement('div');
  archiveDialog.className = 'archive-panel__dialog';
  archiveDialog.setAttribute('role', 'dialog');
  archiveDialog.setAttribute('aria-modal', 'true');
  const archiveHeader = document.createElement('header');
  archiveHeader.className = 'archive-panel__header';
  const archiveTitle = document.createElement('h2');
  archiveTitle.id = 'archive-title';
  archiveTitle.className = 'archive-panel__title';
  const archiveClose = document.createElement('button');
  archiveClose.type = 'button';
  archiveClose.className = 'archive-panel__close';
  archiveClose.textContent = '×';
  archiveHeader.appendChild(archiveTitle);
  archiveHeader.appendChild(archiveClose);
  const archiveList = document.createElement('ul');
  archiveList.className = 'archive-panel__list';
  archiveDialog.appendChild(archiveHeader);
  archiveDialog.appendChild(archiveList);
  archivePanel.appendChild(archiveDialog);
  shell.appendChild(archivePanel);

  const readingBackdrop = document.createElement('div');
  readingBackdrop.className = 'reading-backdrop';
  readingBackdrop.setAttribute('aria-hidden', 'true');
  shell.appendChild(readingBackdrop);

  const readingWindow = document.createElement('section');
  readingWindow.className = 'reading-window';
  readingWindow.setAttribute('aria-hidden', 'true');
  const readingHeader = document.createElement('div');
  readingHeader.className = 'reading-window__header';

  const readingToolbar = document.createElement('div');
  readingToolbar.className = 'reading-window__toolbar';
  const readingLabel = document.createElement('span');
  readingLabel.className = 'reading-window__label';
  readingToolbar.appendChild(readingLabel);

  const readingControls = document.createElement('div');
  readingControls.className = 'reading-window__controls';

  const readingPrev = document.createElement('button');
  readingPrev.type = 'button';
  readingPrev.className = 'reading-window__nav-button reading-window__nav-button--prev';
  readingPrev.innerHTML = '<span aria-hidden="true">←</span>';
  readingControls.appendChild(readingPrev);

  const readingNext = document.createElement('button');
  readingNext.type = 'button';
  readingNext.className = 'reading-window__nav-button reading-window__nav-button--next';
  readingNext.innerHTML = '<span aria-hidden="true">→</span>';
  readingControls.appendChild(readingNext);

  const readingClose = document.createElement('button');
  readingClose.type = 'button';
  readingClose.className = 'close-article';
  readingClose.textContent = '×';
  readingControls.appendChild(readingClose);

  readingToolbar.appendChild(readingControls);
  readingHeader.appendChild(readingToolbar);

  const readingTitle = document.createElement('h2');
  readingTitle.className = 'reading-window__title';
  readingHeader.appendChild(readingTitle);
  const readingContent = document.createElement('div');
  readingContent.id = 'article-content';
  readingContent.className = 'reading-window__content';
  readingWindow.appendChild(readingHeader);
  readingWindow.appendChild(readingContent);
  shell.appendChild(readingWindow);

  const settingsPanel = document.createElement('aside');
  settingsPanel.className = 'settings-panel';
  settingsPanel.setAttribute('aria-hidden', 'true');
  const settingsDialog = document.createElement('div');
  settingsDialog.className = 'settings-panel__dialog';
  settingsDialog.setAttribute('role', 'dialog');
  settingsDialog.setAttribute('aria-modal', 'true');
  const settingsHeader = document.createElement('header');
  settingsHeader.className = 'settings-panel__header';
  const settingsTitle = document.createElement('h2');
  settingsTitle.className = 'settings-panel__title';
  settingsTitle.id = 'settings-title';
  settingsDialog.setAttribute('aria-labelledby', 'settings-title');
  const settingsClose = document.createElement('button');
  settingsClose.type = 'button';
  settingsClose.className = 'settings-panel__close';
  settingsClose.textContent = '×';
  settingsHeader.appendChild(settingsTitle);
  settingsHeader.appendChild(settingsClose);
  const settingsBody = document.createElement('div');
  settingsBody.className = 'settings-panel__body';
  const languageField = document.createElement('label');
  languageField.className = 'settings-field';
  const languageSpan = document.createElement('span');
  languageSpan.className = 'settings-field__label';
  const languageSelect = document.createElement('select');
  languageSelect.className = 'settings-field__control';
  const optionFi = document.createElement('option');
  optionFi.value = 'fi';
  optionFi.textContent = 'Suomi';
  const optionEn = document.createElement('option');
  optionEn.value = 'en';
  optionEn.textContent = 'English';
  languageSelect.appendChild(optionFi);
  languageSelect.appendChild(optionEn);
  languageField.appendChild(languageSpan);
  languageField.appendChild(languageSelect);
  const darkModeField = document.createElement('label');
  darkModeField.className = 'settings-field settings-field--toggle';
  const darkModeSpan = document.createElement('span');
  darkModeSpan.className = 'settings-field__label';
  const darkModeToggle = document.createElement('input');
  darkModeToggle.type = 'checkbox';
  darkModeToggle.className = 'settings-field__control';
  darkModeField.appendChild(darkModeSpan);
  darkModeField.appendChild(darkModeToggle);
  settingsBody.appendChild(languageField);
  settingsBody.appendChild(darkModeField);
  settingsDialog.appendChild(settingsHeader);
  settingsDialog.appendChild(settingsBody);
  settingsPanel.appendChild(settingsDialog);
  shell.appendChild(settingsPanel);

  state.dom = {
    shell,
    menuContent,
    navPrev,
    navNext,
    pageTrack,
    zoomMenu,
    zoomOut,
    zoomIn,
    zoomReset,
    allPages,
    allPagesTitle,
    allPagesClose,
    allPagesGrid,
    archivePanel,
    archiveDialog,
    archiveTitle,
    archiveClose,
    archiveList,
    readingBackdrop,
    readingWindow,
    readingLabel,
    readingPrev,
    readingNext,
    readingTitle,
    readingClose,
    readingContent,
    settingsPanel,
    settingsDialog,
    settingsTitle,
    settingsClose,
    languageLabel: languageSpan,
    languageSelect,
    darkModeLabel: darkModeSpan,
    darkModeToggle
  };
}

function applyTheme() {
  const isDark = Boolean(state.settings.darkMode);
  document.body.classList.toggle('theme-dark', isDark);
  document.documentElement.classList.toggle('theme-dark', isDark);
  document.documentElement.style.setProperty('color-scheme', isDark ? 'dark' : 'light');
}

function refreshLocalizedTexts(options = {}) {
  const { rebuildNavigation = false } = options;
  const { dom } = state;
  if (!dom) {
    return;
  }

  if (rebuildNavigation) {
    buildNavigation();
    bindNavigationHandlers();
  }

  dom.navPrev?.setAttribute('aria-label', resolveLabel('prevPage', 'Edellinen sivu'));
  dom.navNext?.setAttribute('aria-label', resolveLabel('nextPage', 'Seuraava sivu'));
  dom.zoomOut?.setAttribute('aria-label', resolveLabel('zoomOut', 'Zoomaa ulos'));
  dom.zoomIn?.setAttribute('aria-label', resolveLabel('zoomIn', 'Zoomaa sisään'));
  if (dom.zoomReset) {
    const resetLabel = resolveLabel('zoomReset', 'Palauta');
    dom.zoomReset.textContent = resetLabel;
    dom.zoomReset.setAttribute('aria-label', resetLabel);
  }

  if (dom.allPagesTitle) {
    const overviewLabel = getNavigationLabelByAction('toggle-all-pages') || resolveLabel('allPagesTitle', 'Kaikki sivut');
    dom.allPagesTitle.textContent = overviewLabel;
  }
  dom.allPagesClose?.setAttribute('aria-label', resolveLabel('closeAllPages', 'Sulje kaikki sivut'));

  if (dom.archiveTitle) {
    dom.archiveTitle.textContent = resolveLabel('archiveTitle', 'Arkisto');
  }
  dom.archiveClose?.setAttribute('aria-label', resolveLabel('closeArchive', 'Sulje arkisto'));

  if (dom.readingTitle) {
    dom.readingTitle.textContent = resolveLabel('readingTitle', 'Artikkeli');
  }
  dom.readingClose?.setAttribute('aria-label', resolveLabel('closeArticle', 'Sulje artikkeli'));
  updateReadingNavigation();

  if (dom.settingsTitle) {
    dom.settingsTitle.textContent = resolveLabel('settingsTitle', 'Asetukset');
  }
  dom.settingsClose?.setAttribute('aria-label', resolveLabel('settingsClose', 'Sulje asetukset'));
  if (dom.languageLabel) {
    dom.languageLabel.textContent = resolveLabel('settingsLanguage', 'Kieli');
  }
  if (dom.languageSelect) {
    Array.from(dom.languageSelect.options || []).forEach(option => {
      if (option.value === 'fi') {
        option.textContent = state.settings.language === 'en' ? 'Finnish' : 'Suomi';
      } else if (option.value === 'en') {
        option.textContent = state.settings.language === 'en' ? 'English' : 'Englanti';
      }
    });
  }
  if (dom.darkModeLabel) {
    dom.darkModeLabel.textContent = resolveLabel('settingsDarkMode', 'Tumma tila');
  }

  document.documentElement.lang = state.settings.language || 'fi';

  updateFullscreenUI();
  updateZoomUI();
  if (state.archiveLoaded) {
    buildArchiveList();
  }
  updateAllPagesSizing();
}

function applySettings(options = {}) {
  const { persist = true } = options;
  const storedLanguage = state.settings.language;
  if (!storedLanguage) {
    state.settings.language = normalizeLanguage(state.config?.lang) || 'fi';
  }
  const { languageSelect, darkModeToggle } = state.dom;
  if (languageSelect) {
    languageSelect.value = state.settings.language;
  }
  if (darkModeToggle) {
    darkModeToggle.checked = Boolean(state.settings.darkMode);
  }
  applyTheme();
  refreshLocalizedTexts({ rebuildNavigation: true });
  if (persist) {
    saveSettings();
  }
}

function parseInitialLocation() {
  const params = new URLSearchParams(window.location.search);
  const rawIssue = params.get('issue');
  const issueParam = rawIssue && rawIssue.trim() ? rawIssue.trim() : null;
  const pageParam = Number.parseInt(params.get('page') || '', 10);
  const pageIndex = Number.isFinite(pageParam) && pageParam > 0 ? pageParam - 1 : 0;
  return {
    issuePath: issueParam,
    pageIndex
  };
}

function normalizeArchivePath(path) {
  if (!path) {
    return '';
  }
  return path.endsWith('/') ? path : `${path}/`;
}

function updateLocation() {
  if (!state.currentIssuePath) {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const shareableIssue = state.currentIssuePath.replace(/\/$/, '');
  params.set('issue', shareableIssue);
  params.set('page', String((state.activePageIndex || 0) + 1));
  const newUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({ issue: state.currentIssuePath, page: state.activePageIndex }, '', newUrl);
}

document.addEventListener('DOMContentLoaded', init);

async function init() {
  state.config = window.epaperConfig;
  if (!state.config) {
    console.error('epaperConfig puuttuu.');
    return;
  }

  buildLayout();
  document.body.classList.add('menu-collapsed');

  const storedSettings = loadStoredSettings();
  const configLanguage = normalizeLanguage(state.config.lang) || 'fi';
  state.settings.language = normalizeLanguage(storedSettings.language) || configLanguage;
  state.settings.darkMode = typeof storedSettings.darkMode === 'boolean' ? storedSettings.darkMode : false;

  applySettings({ persist: false });
  attachGlobalListeners();

  const initialLocation = parseInitialLocation();
  
  try {
    const issue = await loadIssueData(state.config, initialLocation.issuePath);
    applyIssue(issue, { targetPageIndex: initialLocation.pageIndex });
  } catch (error) {
    console.error('Näköislehden lataaminen epäonnistui:', error);
  } finally {
    requestAnimationFrame(() => document.body.classList.add('menu-animated'));
  }
}

function applyIssue(issue, options = {}) {
  if (!issue) {
    return;
  }

  const targetPageIndex = Number.isFinite(options.targetPageIndex)
    ? clamp(options.targetPageIndex, 0, Math.max(0, (issue.imagePaths?.length || 1) - 1))
    : 0;
  
  state.imagePaths = Array.isArray(issue.imagePaths) ? issue.imagePaths : [];
  state.pageMaps = Array.isArray(issue.pageMaps) ? issue.pageMaps : [];
  state.pageArticles = Array.isArray(issue.pageArticles) ? issue.pageArticles : [];
  state.articleLookup = new Map(state.pageArticles.map(article => [String(article.id), article]));
  state.articlePageLookup = buildArticlePageLookup(state.pageMaps);
  state.articleOrder = state.pageArticles
    .map(article => String(article.id))
    .filter(id => Boolean(id));
  state.currentArticleId = null;
  state.viewBox = computeViewBox(issue.res);
  if (Array.isArray(issue.archiveItems) && issue.archiveItems.length) {
    state.archiveItems = issue.archiveItems;
  }
  if (issue.path) {
    state.currentIssuePath = normalizeArchivePath(issue.path);
  }
  state.activePageIndex = targetPageIndex;

  toggleAllPages(false);
  closeArchivePanel();
  closeReadingWindow();
  closeSettingsPanel();
  buildAllPagesGrid();
  renderSlides();
  updateNavButtons();
  buildArchiveList();
  updateAllPagesSizing();
  updateLocation();
  document.title = issue.label
    ? `${issue.label} – ${state.config.paper}`
    : state.config.paper;
  updateReadingNavigation();
}

function buildArticlePageLookup(pageMaps) {
  const lookup = new Map();
  if (!Array.isArray(pageMaps)) {
    return lookup;
  }
  pageMaps.forEach((items, pageIndex) => {
    if (!Array.isArray(items)) {
      return;
    }
    items.forEach(item => {
      if (!item || item.t !== 0 || item.id == null) {
        return;
      }
      const id = String(item.id);
      if (!lookup.has(id)) {
        lookup.set(id, pageIndex);
      }
    });
  });
  return lookup;
}

function buildNavigation() {
  const container = state.dom?.menuContent || document.querySelector('.menu-content');
  if (!container) {
    return;
  }

  container.innerHTML = '';

  const navigationItems = Array.isArray(state.config?.navigation)
    ? state.config.navigation
    : [];
  navigationItems.forEach(item => {
    if (!item) {
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('menu-item');
    if (item.className) {
      button.classList.add(item.className);
    }
    if (item.action) {
      button.dataset.action = item.action;
    }
    button.dataset.bound = 'false';
    
    if (item.icon && item.icon.path) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('viewBox', item.icon.viewBox || '0 0 24 24');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', item.icon.path);
      svg.appendChild(path);
      button.appendChild(svg);
    }

    const labelText = getLocalizedValue(item.label, '');
    if (labelText) {
      const label = document.createElement('span');
      label.textContent = labelText;
      button.appendChild(label);
      button.title = labelText;
      button.setAttribute('aria-label', labelText);
    }

    container.appendChild(button);
  });
}

function bindNavigationHandlers() {
  const container = state.dom?.menuContent;
  if (!container) {
    return;
  }
  const buttons = container.querySelectorAll('[data-action]');
  buttons.forEach(button => {
    if (!button || button.dataset.bound === 'true') {
      return;
    }
    button.dataset.bound = 'true';
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      handleNavigationAction(action);
    });
  });
}

function handleNavigationAction(action) {
  switch (action) {
    case 'toggle-menu':
      toggleMenuCollapsed();
      break;
    case 'fullscreen':
      enterFullscreen();
      break;
    case 'exit-fullscreen':
      exitFullscreenMode();
      break;
    case 'toggle-all-pages':
      toggleAllPages(true);
      break;
    case 'archive':
      openArchivePanel();
      break;
    case 'settings':
      openSettingsPanel();
      break;
    default:
      break;
  }
}

function attachGlobalListeners() {
  if (state.listenersAttached) {
    bindNavigationHandlers();
    return;
  }
  state.listenersAttached = true;

  const {
    navPrev,
    navNext,
    zoomIn,
    zoomOut,
    zoomReset,
    allPages,
    allPagesClose,
    archivePanel,
    archiveClose,
    readingPrev,
    readingNext,
    readingClose,
    readingBackdrop,
    settingsPanel,
    settingsClose,
    languageSelect,
    darkModeToggle
  } = state.dom;

  navPrev?.addEventListener('click', () => gotoSlide(state.currentSlide - 1));
  navNext?.addEventListener('click', () => gotoSlide(state.currentSlide + 1));

  zoomIn?.addEventListener('click', () => adjustZoom(1));
  zoomOut?.addEventListener('click', () => adjustZoom(-1));
  zoomReset?.addEventListener('click', resetZoom);
  
  allPagesClose?.addEventListener('click', () => toggleAllPages(false));
  allPages?.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const isPage = target.closest('.all-pages__page');
    const isHeader = target.closest('.all-pages__header');
    if (!isPage && !isHeader) {
      toggleAllPages(false);
    }
  });

  archiveClose?.addEventListener('click', closeArchivePanel);
  archivePanel?.addEventListener('click', event => {
    if (event.target === archivePanel) {
      closeArchivePanel();
    }
  });

  readingPrev?.addEventListener('click', () => gotoAdjacentArticle(-1));
  readingNext?.addEventListener('click', () => gotoAdjacentArticle(1));
  readingClose?.addEventListener('click', closeReadingWindow);
  readingBackdrop?.addEventListener('click', closeReadingWindow);

  settingsClose?.addEventListener('click', closeSettingsPanel);
  settingsPanel?.addEventListener('click', event => {
    if (event.target === settingsPanel) {
      closeSettingsPanel();
    }
  });

  languageSelect?.addEventListener('change', handleLanguageChange);
  darkModeToggle?.addEventListener('change', handleDarkModeChange);

  document.addEventListener('fullscreenchange', updateFullscreenUI);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('resize', handleResize);

  bindNavigationHandlers();
}

function toggleMenuCollapsed() {
  document.body.classList.toggle('menu-collapsed');
}

function handleLanguageChange(event) {
  const value = normalizeLanguage(event?.target?.value);
  if (!value || value === state.settings.language) {
    return;
  }
  state.settings.language = value;
  applySettings();
}

function handleDarkModeChange(event) {
  const nextValue = Boolean(event?.target?.checked);
  if (nextValue === state.settings.darkMode) {
    return;
  }
  state.settings.darkMode = nextValue;
  applySettings();
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    if (document.body.classList.contains('is-zoomed')) {
      resetZoom();
      return;
    }
    if (state.dom.allPages?.classList.contains('is-open')) {
      toggleAllPages(false);
      return;
    }
    if (state.dom.archivePanel?.classList.contains('is-open')) {
      closeArchivePanel();
      return;
    }
    if (state.dom.settingsPanel?.classList.contains('is-open')) {
      closeSettingsPanel();
      return;
    }
    if (state.dom.readingWindow?.classList.contains('is-open')) {
      closeReadingWindow();
      return;
    }
  }

  const isReadingOpen = state.dom.readingWindow?.classList.contains('is-open');
  if (isReadingOpen) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      gotoAdjacentArticle(1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      gotoAdjacentArticle(-1);
      return;
    }
  }

  if (document.body.classList.contains('is-zoomed')) {
    return;
  }

  if (event.key === 'ArrowRight') {
    gotoSlide(state.currentSlide + 1);
  } else if (event.key === 'ArrowLeft') {
    gotoSlide(state.currentSlide - 1);
  }
}

function enterFullscreen() {
  const shell = document.querySelector('.app-shell');
  if (!shell || document.fullscreenElement || !shell.requestFullscreen) {
    return;
  }
  shell.requestFullscreen().catch(error => {
    console.error('Kokonäyttötilan avaaminen epäonnistui:', error);
  });
}

function exitFullscreenMode() {
  if (!document.fullscreenElement || !document.exitFullscreen) {
    return;
  }
  document.exitFullscreen().catch(error => {
    console.error('Kokonäyttötilan sulkeminen epäonnistui:', error);
  });
}

function updateFullscreenUI() {
  const menuRoot = state.dom.menuContent || document;
  const fullscreenButton = menuRoot.querySelector('[data-action="fullscreen"]');
  const exitFullscreenButton = menuRoot.querySelector('[data-action="exit-fullscreen"]');
  const isFullscreen = Boolean(document.fullscreenElement);
  document.body.classList.toggle('is-fullscreen', isFullscreen);
  if (fullscreenButton) {
    fullscreenButton.hidden = isFullscreen;
    fullscreenButton.setAttribute('aria-hidden', isFullscreen ? 'true' : 'false');
    const label = resolveLabel('fullscreenLabel', 'Koko näyttö');
    fullscreenButton.setAttribute('aria-label', label);
    fullscreenButton.title = label;
  }
  if (exitFullscreenButton) {
    exitFullscreenButton.hidden = !isFullscreen;
    exitFullscreenButton.setAttribute('aria-hidden', !isFullscreen ? 'true' : 'false');
    const exitLabel = resolveLabel('windowedLabel', 'Sulje koko näyttö');
    exitFullscreenButton.setAttribute('aria-label', exitLabel);
    exitFullscreenButton.title = exitLabel;
  }
}

function setArticleNavButton(button, targetId, label) {
  if (!button) {
    return;
  }
  button.setAttribute('aria-label', label);
  button.title = label;
  if (targetId) {
    button.disabled = false;
    button.dataset.targetArticle = targetId;
    button.setAttribute('aria-disabled', 'false');
  } else {
    button.disabled = true;
    delete button.dataset.targetArticle;
    button.setAttribute('aria-disabled', 'true');
  }
}

function updateReadingNavigation() {
  const { readingLabel, readingPrev, readingNext } = state.dom || {};
  if (readingLabel) {
    readingLabel.textContent = resolveLabel('readingWindowTitle', 'Lukuikkuna');
  }

  const prevLabel = resolveLabel('prevArticle', 'Edellinen juttu');
  const nextLabel = resolveLabel('nextArticle', 'Seuraava juttu');

  const order = Array.isArray(state.articleOrder) ? state.articleOrder : [];
  const currentId = state.currentArticleId ? String(state.currentArticleId) : null;
  const currentIndex = currentId ? order.indexOf(currentId) : -1;

  const prevId = currentIndex > 0 ? order[currentIndex - 1] : null;
  const nextId = currentIndex !== -1 && currentIndex < order.length - 1 ? order[currentIndex + 1] : null;

  setArticleNavButton(readingPrev, prevId, prevLabel);
  setArticleNavButton(readingNext, nextId, nextLabel);
}

function gotoAdjacentArticle(step) {
  if (!Number.isInteger(step) || step === 0) {
    return;
  }
  const order = Array.isArray(state.articleOrder) ? state.articleOrder : [];
  const currentId = state.currentArticleId ? String(state.currentArticleId) : null;
  if (!currentId || !order.length) {
    return;
  }
  const currentIndex = order.indexOf(currentId);
  if (currentIndex === -1) {
    return;
  }
  const targetIndex = currentIndex + step;
  if (targetIndex < 0 || targetIndex >= order.length) {
    return;
  }
  const targetId = order[targetIndex];
  if (targetId) {
    openArticleById(targetId);
  }
}

function focusPageForArticle(articleId, options = {}) {
  const id = String(articleId);
  const pageIndex = state.articlePageLookup.get(id);
  if (!Number.isInteger(pageIndex)) {
    return;
  }
  const slideIndex = state.slideDefinitions.findIndex(def => def.includes(pageIndex));
  if (slideIndex === -1) {
    return;
  }
  if (slideIndex === state.currentSlide) {
    if (state.activePageIndex !== pageIndex) {
      state.activePageIndex = pageIndex;
      updateLocation();
    }
    return;
  }
  updateActiveSlide(slideIndex, {
    preserveZoom: false,
    keepReadingOpen: Boolean(options.keepReadingOpen),
    activePageIndex: pageIndex
  });
}

function openArticleById(articleId) {
  if (!articleId) {
    return;
  }
  const id = String(articleId);
  const article = state.articleLookup.get(id);
  if (!article) {
    console.warn('Artikkelia ei löytynyt arkistosta:', articleId);
    return;
  }
  focusPageForArticle(id, { keepReadingOpen: true });
  const heading = state.dom.readingTitle;
  if (heading) {
    heading.textContent = article.hl || resolveLabel('readingTitle', 'Artikkeli');
  }
  state.currentArticleId = id;
  updateReadingNavigation();
  if (article.url) {
    loadArticleContent(article.url);
  }
}

function openArchivePanel() {
  const panel = state.dom.archivePanel || document.querySelector('.archive-panel');
  if (!panel) {
    return;
  }
  toggleAllPages(false);
  closeSettingsPanel();
  closeReadingWindow();
  buildArchiveList();
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
}

function closeArchivePanel() {
  const panel = state.dom.archivePanel || document.querySelector('.archive-panel');
  if (!panel) {
    return;
  }
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
}

function openSettingsPanel() {
  const panel = state.dom.settingsPanel;
  if (!panel) {
    return;
  }
  toggleAllPages(false);
  closeArchivePanel();
  closeReadingWindow();
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  state.dom.languageSelect?.focus({ preventScroll: true });
}

function closeSettingsPanel() {
  const panel = state.dom.settingsPanel;
  if (!panel) {
    return;
  }
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
}

function handleResize() {
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    const newOrientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
    const isCompact = window.innerWidth < 900;
    if (newOrientation !== state.orientation || isCompact !== state.isCompact) {
      renderSlides();
      updateAllPagesSizing();
      return;
    }
    const surface = getActiveSurface();
    if (surface) {
      captureBaseSize(surface);
      const constrained = constrainTranslation(surface, state.zoom.translateX, state.zoom.translateY, state.zoom.scale);
      state.zoom.translateX = constrained.x;
      state.zoom.translateY = constrained.y;
      applyZoom(surface);
    }
    updateAllPagesSizing();
  }, 180);
}

async function loadIssueData(config, issuePath) {
  const rootPath = `static/${config.id}`;
  let archiveData = Array.isArray(state.archiveItems) && state.archiveItems.length
    ? state.archiveItems
    : null;
  const normalizedTargetPath = issuePath ? normalizeArchivePath(issuePath) : null;
  
  if (!archiveData) {
    const archiveUrl = `${rootPath}/${config.paper}_arch.htm`;
    const archiveResponse = await fetch(archiveUrl);
    if (!archiveResponse.ok) {
      throw new Error(`Arkistotiedoston lataus epäonnistui: ${archiveResponse.status}`);
    }
    const parsed = await archiveResponse.json();
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Arkistodata on tyhjä.');
    }
    archiveData = parsed;
  }

  state.archiveLoaded = true;

  const selectedEntry = normalizedTargetPath
    ? archiveData.find(entry => normalizeArchivePath(entry.p) === normalizedTargetPath)
    : archiveData[0];

  if (!selectedEntry) {
    throw new Error('Lehden polkua ei löytynyt arkistosta.');
  }

  const issueUrl = `${rootPath}/${selectedEntry.p}${config.paper}_cont.htm`;
  const issueResponse = await fetch(issueUrl);
  if (!issueResponse.ok) {
    throw new Error(`Lehden datan lataus epäonnistui: ${issueResponse.status}`);
  }
  const issueData = await issueResponse.json();
  if (!issueData.pages) {
    throw new Error('Lehden sivumäärää ei löytynyt.');
  }

  const imagePaths = Array.from(
    { length: issueData.pages },
    (_, index) => `${rootPath}/${selectedEntry.p}p${index + 1}.webp`
  );

  return {
    imagePaths,
    pageMaps: issueData.pageMaps || [],
    pageArticles: issueData.pageArticles || [],
    res: issueData.res,
    archiveItems: archiveData,
    path: normalizeArchivePath(selectedEntry.p),
    label: selectedEntry.d
  };
}

function renderSlides() {
  if (!Array.isArray(state.imagePaths) || state.imagePaths.length === 0) {
    console.warn('Ei sivuja näytettäväksi.');
    return;
  }

  const orientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
  const isCompact = window.innerWidth < 900;
  state.orientation = orientation;
  state.isCompact = isCompact;

  const definitions = buildSlideDefinitions({ orientation, isCompact });
  state.slideDefinitions = definitions;

  const pageTrack = document.querySelector('.page-track');
  pageTrack.innerHTML = '';

  const slides = definitions.map(pages => createSlide(pages));
  slides.forEach(slide => pageTrack.appendChild(slide.element));
  state.slides = slides;

  requestAnimationFrame(() => {
    slides.forEach(slide => captureBaseSize(slide.surface));
  });

  let targetIndex = definitions.findIndex(def => def.includes(state.activePageIndex));
  if (targetIndex === -1) {
    targetIndex = 0;
  }
  updateActiveSlide(targetIndex, { preserveZoom: false });
  highlightAllPages();
}

function buildSlideDefinitions({ orientation, isCompact }) {
  if (isCompact || orientation === 'portrait') {
    return state.imagePaths.map((_, index) => [index]);
  }
  return buildSpreadDefinitions();
}

function buildSpreadDefinitions() {
  const total = state.imagePaths.length;
  if (total === 0) {
    return [];
  }

  const spreads = [[0]];
  const lastIndex = total - 1;
  let index = 1;

  while (index < lastIndex) {
    if (index + 1 >= lastIndex) {
      spreads.push([index]);
      break;
    }
    spreads.push([index, index + 1]);
    index += 2;
  }

  if (total > 1) {
    spreads.push([lastIndex]);
  }

  return spreads;
}

function createSlide(pages) {
  const slide = document.createElement('div');
  slide.className = 'page-slide';
  slide.dataset.pages = pages.join(',');

  const surface = document.createElement('div');
  surface.className = 'page-surface';
  const ratio = state.viewBox && state.viewBox.width && state.viewBox.height
    ? state.viewBox.width / state.viewBox.height
    : 0.75;
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 0.75;
  surface.style.setProperty('--page-ratio', String(safeRatio));

  const shouldOffsetFirstPage = pages.length === 1
    && pages[0] === 0
    && state.orientation === 'landscape'
    && !state.isCompact
    && state.imagePaths.length > 1;
  if (shouldOffsetFirstPage) {
    surface.classList.add('page-surface--offset');
  }

  const pageMultiplier = shouldOffsetFirstPage ? pages.length + 0.5 : pages.length;
  surface.style.setProperty('--page-count', String(pageMultiplier));

  pages.forEach(pageIndex => {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-image';

    const img = document.createElement('img');
    img.src = state.imagePaths[pageIndex];
    img.alt = `Sivu ${pageIndex + 1}`;
    img.addEventListener('load', () => captureBaseSize(surface));
    if (img.complete) {
      captureBaseSize(surface);
    }
    wrapper.appendChild(img);

    const overlay = createSvgOverlay(pageIndex);
    if (overlay) {
      wrapper.appendChild(overlay);
    }

    surface.appendChild(wrapper);
  });

  surface.addEventListener('dblclick', handleDoubleClick);
  surface.addEventListener('wheel', handleWheel, { passive: false });
  surface.addEventListener('pointerdown', startPan);
  surface.addEventListener('pointermove', movePan);
  surface.addEventListener('pointerup', endPan);
  surface.addEventListener('pointercancel', endPan);
  surface.addEventListener('click', suppressSwipeClicks, true);

  slide.appendChild(surface);
  return { element: slide, surface, pages };
}

function createSvgOverlay(pageIndex) {
  const pageMap = state.pageMaps[pageIndex];
  if (!pageMap || pageMap.length === 0) {
    return null;
  }

  const viewBox = state.viewBox || computeViewBox();
  if (!viewBox) {
    return null;
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewBox.width} ${viewBox.height}`);
  svg.classList.add('pagerect');

  pageMap.forEach(item => {
    if (item.t !== 0 || !item.c) {
      return;
    }
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const coords = item.c
      .split(',')
      .map(value => parseFloat(value.trim()) / 1000);

    const x = (coords[0] * viewBox.width).toFixed(2);
    const y = (coords[1] * viewBox.height).toFixed(2);
    const width = ((coords[2] - coords[0]) * viewBox.width).toFixed(2);
    const height = ((coords[3] - coords[1]) * viewBox.height).toFixed(2);

    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', width);
    rect.setAttribute('height', height);
    rect.setAttribute('class', 'maprect');
    rect.setAttribute('role', 'button');
    rect.setAttribute('tabindex', '0');

    const article = state.articleLookup.get(String(item.id));
    if (article) {
      rect.dataset.url = article.url;
      rect.dataset.articleId = String(article.id);
      rect.setAttribute('aria-label', article.hl || 'Artikkeli');
    }

    rect.addEventListener('click', handleRectClick);
    rect.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleRectClick(event);
      }
    });

    svg.appendChild(rect);
  });

  return svg;
}

function handleRectClick(event) {
  if (state.zoom.scale > 1) {
    return;
  }
  const target = event.currentTarget;
  const articleId = target.dataset.articleId;
  if (articleId) {
    openArticleById(articleId);
    return;
  }
  const url = target.dataset.url;
  if (url) {
    state.currentArticleId = null;
    updateReadingNavigation();
    loadArticleContent(url);
  }
}

function gotoSlide(index) {
  if (index < 0 || index >= state.slides.length) {
    return;
  }
  updateActiveSlide(index);
}

function updateActiveSlide(index, options = {}) {
  const {
    preserveZoom = false,
    keepReadingOpen = false,
    activePageIndex = null
  } = options;
  if (state.currentSlide != null && state.slides[state.currentSlide]) {
    state.slides[state.currentSlide].element.classList.remove('is-active');
  }

  state.currentSlide = index;
  const current = state.slides[index];
  if (!current) {
    return;
  }
  current.element.classList.add('is-active');
  const nextActivePageIndex = Number.isInteger(activePageIndex)
    ? activePageIndex
    : current.pages[0];
  state.activePageIndex = nextActivePageIndex;
  if (!keepReadingOpen) {
    closeReadingWindow();
  }

  if (!preserveZoom) {
    resetZoom();
  }

  highlightAllPages();
  updateNavButtons();
  updateLocation();
}

function highlightAllPages() {
  if (!state.slideDefinitions.length) {
    return;
  }
  const container = state.dom.allPagesGrid || document;
  const buttons = container.querySelectorAll('.all-pages__page');
  buttons.forEach(button => {
    const pages = button.dataset.pages
      ? button.dataset.pages.split(',').map(value => Number(value.trim()))
      : [];
    const activePages = state.slideDefinitions[state.currentSlide] || [];
    const isActive = pages.some(page => activePages.includes(page));
    button.classList.toggle('is-active', isActive);
  });
}

function updateNavButtons() {
  const prevButton = state.dom.navPrev || document.querySelector('.nav-prev');
  const nextButton = state.dom.navNext || document.querySelector('.nav-next');
  const disableNav = state.zoom.scale > 1;

  if (prevButton) {
    prevButton.disabled = disableNav || state.currentSlide <= 0;
  }
  if (nextButton) {
    nextButton.disabled = disableNav || state.currentSlide >= state.slides.length - 1;
  }
}

function getActiveSurface() {
  const current = state.slides[state.currentSlide];
  return current ? current.surface : null;
}

function resetZoom() {
  state.zoom.scale = 1;
  state.zoom.translateX = 0;
  state.zoom.translateY = 0;
  const surface = getActiveSurface();
  if (surface) {
    surface.classList.remove('is-zoomed');
    surface.style.transform = 'translate(0px, 0px) scale(1)';
  }
  document.body.classList.remove('is-zoomed');
  const zoomMenu = document.querySelector('.zoom-menu');
  if (zoomMenu) {
    zoomMenu.classList.remove('is-visible');
    zoomMenu.setAttribute('aria-hidden', 'true');
  }
  updateZoomUI();
  updateNavButtons();
}

function adjustZoom(direction) {
  const newScale = state.zoom.scale + direction * scaleStep;
  setZoom(newScale);
}

function setZoom(scale, focalPoint) {
  const surface = getActiveSurface();
  if (!surface) {
    return;
  }

  const previousScale = state.zoom.scale;
  const clampedScale = clamp(scale, minScale, maxScale);
  let translateX = state.zoom.translateX;
  let translateY = state.zoom.translateY;

  if (clampedScale === 1) {
    translateX = 0;
    translateY = 0;
  } else if (focalPoint) {
    const rect = surface.getBoundingClientRect();
    const offsetX = focalPoint.x - (rect.left + rect.width / 2);
    const offsetY = focalPoint.y - (rect.top + rect.height / 2);
    const scaleRatio = clampedScale / previousScale;
    translateX -= offsetX * (scaleRatio - 1);
    translateY -= offsetY * (scaleRatio - 1);
  }

  const constrained = constrainTranslation(surface, translateX, translateY, clampedScale);
  state.zoom.scale = clampedScale;
  state.zoom.translateX = constrained.x;
  state.zoom.translateY = constrained.y;

  applyZoom(surface);
}

function applyZoom(surface) {
  surface.style.transform = `translate(${state.zoom.translateX}px, ${state.zoom.translateY}px) scale(${state.zoom.scale})`;
  const isZoomed = state.zoom.scale > 1;
  surface.classList.toggle('is-zoomed', isZoomed);
  document.body.classList.toggle('is-zoomed', isZoomed);
  const zoomMenu = document.querySelector('.zoom-menu');
  if (zoomMenu) {
    zoomMenu.classList.toggle('is-visible', isZoomed);
    zoomMenu.setAttribute('aria-hidden', isZoomed ? 'false' : 'true');
  }
  updateZoomUI();
  updateNavButtons();
}

function updateZoomUI() {
  const zoomIn = document.querySelector('.zoom-in');
  const zoomOut = document.querySelector('.zoom-out');
  const zoomReset = document.querySelector('.zoom-reset');

  if (zoomIn) {
    zoomIn.disabled = state.zoom.scale >= maxScale;
  }
  if (zoomOut) {
    zoomOut.disabled = state.zoom.scale <= minScale;
  }
  if (zoomReset) {
    zoomReset.disabled = state.zoom.scale === 1;
  }
}

function constrainTranslation(surface, translateX, translateY, scale) {
  const stage = document.querySelector('.page-stage');
  if (!stage) {
    return { x: translateX, y: translateY };
  }

  const baseWidth = parseFloat(surface.dataset.baseWidth) || surface.getBoundingClientRect().width / scale;
  const baseHeight = parseFloat(surface.dataset.baseHeight) || surface.getBoundingClientRect().height / scale;
  const scaledWidth = baseWidth * scale;
  const scaledHeight = baseHeight * scale;

  const stageWidth = stage.clientWidth;
  const stageHeight = stage.clientHeight;

  const maxX = Math.max(0, (scaledWidth - stageWidth) / 2);
  const maxY = Math.max(0, (scaledHeight - stageHeight) / 2);

  return {
    x: clamp(translateX, -maxX, maxX),
    y: clamp(translateY, -maxY, maxY)
  };
}

function captureBaseSize(surface) {
  const rect = surface.getBoundingClientRect();
  surface.dataset.baseWidth = String(rect.width);
  surface.dataset.baseHeight = String(rect.height);
}

function handleWheel(event) {
  event.preventDefault();
  const delta = event.deltaY > 0 ? -scaleStep : scaleStep;
  const newScale = state.zoom.scale + delta;
  setZoom(newScale, { x: event.clientX, y: event.clientY });
}

function handleDoubleClick(event) {
  if (state.zoom.scale > 1) {
    resetZoom();
  } else {
    setZoom(2, { x: event.clientX, y: event.clientY });
  }
}

function startPan(event) {
  if (state.zoom.scale === 1) {
    swipeState.pointerId = event.pointerId;
    swipeState.startX = event.clientX;
    swipeState.startY = event.clientY;
    swipeState.startTime = event.timeStamp || performance.now();
    swipeState.isTracking = true;
    swipeState.isSwipe = false;
    return;
  }
  swipeState.isTracking = false;
  swipeState.pointerId = null;
  swipeState.isSwipe = false;
  event.preventDefault();
  const surface = event.currentTarget;
  surface.setPointerCapture(event.pointerId);
  panState.active = true;
  panState.pointerId = event.pointerId;
  panState.startX = event.clientX;
  panState.startY = event.clientY;
  panState.baseX = state.zoom.translateX;
  panState.baseY = state.zoom.translateY;
}

function movePan(event) {
  if (swipeState.isTracking && event.pointerId === swipeState.pointerId) {
    const dx = event.clientX - swipeState.startX;
    const dy = event.clientY - swipeState.startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      event.preventDefault();
    }
    return;
  }
  if (!panState.active || event.pointerId !== panState.pointerId) {
    return;
  }
  event.preventDefault();
  const surface = event.currentTarget;
  const dx = event.clientX - panState.startX;
  const dy = event.clientY - panState.startY;
  const constrained = constrainTranslation(surface, panState.baseX + dx, panState.baseY + dy, state.zoom.scale);
  state.zoom.translateX = constrained.x;
  state.zoom.translateY = constrained.y;
  applyZoom(surface);
}

function endPan(event) {
  if (swipeState.isTracking && event.pointerId === swipeState.pointerId) {
    const isCancel = event.type === 'pointercancel';
    if (!isCancel) {
      const dx = event.clientX - swipeState.startX;
      const dy = event.clientY - swipeState.startY;
      const elapsed = (event.timeStamp || performance.now()) - swipeState.startTime;
      const horizontalDominant = Math.abs(dx) > Math.abs(dy);
      if (horizontalDominant && Math.abs(dx) > 60 && elapsed < 600) {
        const direction = dx < 0 ? 1 : -1;
        gotoSlide(state.currentSlide + direction);
        swipeState.isSwipe = true;
      } else {
        swipeState.isSwipe = false;
      }
    } else {
      swipeState.isSwipe = false;
    }
    swipeState.isTracking = false;
    swipeState.pointerId = null;
    return;
  }
  if (!panState.active || event.pointerId !== panState.pointerId) {
    return;
  }
  const surface = event.currentTarget;
  surface.releasePointerCapture(event.pointerId);
  panState.active = false;
  panState.pointerId = null;
}

function suppressSwipeClicks(event) {
  if (!swipeState.isSwipe) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  swipeState.isSwipe = false;
}

function toggleAllPages(forceOpen) {
  const overlay = state.dom.allPages || document.querySelector('.all-pages');
  if (!overlay) {
    return;
  }
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !overlay.classList.contains('is-open');
  if (shouldOpen) {
    resetZoom();
    closeArchivePanel();
    closeSettingsPanel();
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    highlightAllPages();
    updateAllPagesSizing();
  } else {
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }
}

function buildAllPagesGrid() {
  const grid = state.dom.allPagesGrid || document.querySelector('.all-pages__grid');
  if (!grid) {
    return;
  }
  grid.innerHTML = '';
  const spreads = buildSpreadDefinitions();
  const ratio = state.viewBox && state.viewBox.width && state.viewBox.height
    ? state.viewBox.width / state.viewBox.height
    : 0.75;
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 0.75;
  spreads.forEach(pages => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'all-pages__page';
    button.dataset.pages = pages.join(',');
    const shouldOffsetFirstPage = pages.length === 1 && pages[0] === 0 && state.imagePaths.length > 1;
    const sizingCount = shouldOffsetFirstPage ? pages.length + 0.5 : pages.length;
    button.dataset.pageCount = String(sizingCount);
    if (pages.length > 1) {
      button.classList.add('all-pages__page--spread');
    }

    const preview = document.createElement('div');
    preview.className = 'all-pages__preview';
    preview.style.setProperty('--page-ratio', String(safeRatio));
    if (shouldOffsetFirstPage) {
      preview.classList.add('all-pages__preview--offset');
    }
    pages.forEach(pageIndex => {
      const img = document.createElement('img');
      img.src = state.imagePaths[pageIndex];
      const altBase = state.settings.language === 'en' ? 'Page' : 'Sivu';
      img.alt = `${altBase} ${pageIndex + 1}`;
      preview.appendChild(img);
    });
    button.appendChild(preview);

    const label = document.createElement('span');
    label.textContent = pages.length > 1
      ? `${pages[0] + 1}–${pages[pages.length - 1] + 1}`
      : String(pages[0] + 1);
    button.appendChild(label);

    button.addEventListener('click', () => {
      const slideIndex = state.slideDefinitions.findIndex(def => pages.some(page => def.includes(page)));
      toggleAllPages(false);
      if (slideIndex !== -1) {
        updateActiveSlide(slideIndex);
        return;
      }
      const fallbackIndex = state.slideDefinitions.findIndex(def => def.includes(pages[0]));
      if (fallbackIndex !== -1) {
        updateActiveSlide(fallbackIndex);
      }
    });

    grid.appendChild(button);
  });
}

function buildArchiveList() {
  const list = state.dom.archiveList || document.querySelector('.archive-panel__list');
  if (!list) {
    return;
  }
  list.innerHTML = '';
  if (!Array.isArray(state.archiveItems) || state.archiveItems.length === 0) {
    if (state.archiveLoaded) {
      const empty = document.createElement('li');
      empty.className = 'archive-panel__empty';
      empty.textContent = resolveLabel('archiveEmpty', 'Arkistossa ei ole numeroita.');
      list.appendChild(empty);
    }
    return;
  }

  const currentPath = normalizeArchivePath(state.currentIssuePath);
  state.archiveItems.forEach(entry => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'archive-panel__item';
    const entryPath = normalizeArchivePath(entry.p);
    button.dataset.path = entryPath;
    if (entryPath === currentPath) {
      button.classList.add('is-active');
    }

    const figure = document.createElement('div');
    figure.className = 'archive-panel__media';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = (entry.d || entry.p || '').trim() || state.config.paper;
    img.src = getArchiveCoverSrc(entry.p);
    figure.appendChild(img);
    button.appendChild(figure);

    const info = document.createElement('div');
    info.className = 'archive-panel__info';
    const title = document.createElement('span');
    title.className = 'archive-panel__date';
    title.textContent = formatArchiveDate(entry.d) || entry.d || entry.p;
    info.appendChild(title);
    if (entry.p) {
      const meta = document.createElement('small');
      meta.className = 'archive-panel__path';
      meta.textContent = entry.p.replace(/\/$/, '');
      info.appendChild(meta);
    }
    button.appendChild(info);
    const accessibleLabel = title.textContent || entry.p || '';
    if (accessibleLabel) {
      button.setAttribute('aria-label', accessibleLabel);
    }

    button.addEventListener('click', () => handleArchiveSelection(entryPath));
    item.appendChild(button);
    list.appendChild(item);
  });
}

function formatArchiveDate(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  try {
    return new Intl.DateTimeFormat(getLocale(state.settings.language), {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(date);
  } catch (error) {
    console.warn('Päivämäärän muotoilu epäonnistui:', error);
    return value;
  }
}

function getArchiveCoverSrc(path) {
  if (!state.config) {
    return '';
  }
  const normalized = normalizeArchivePath(path);
  if (!normalized) {
    return '';
  }
  return `static/${state.config.id}/${normalized}p1.webp`;
}

function handleArchiveSelection(path) {
  if (!path) {
    return;
  }
  closeArchivePanel();
  if (normalizeArchivePath(path) === state.currentIssuePath) {
    return;
  }
  loadArchiveIssue(path);
}

async function loadArchiveIssue(path) {
  try {
    const issue = await loadIssueData(state.config, path);
    applyIssue(issue);
  } catch (error) {
    console.error('Arkistonumeron lataaminen epäonnistui:', error);
  }
}

function updateAllPagesSizing() {
  const grid = state.dom.allPagesGrid || document.querySelector('.all-pages__grid');
  if (!grid) {
    return;
  }
  const ratio = state.viewBox && state.viewBox.width && state.viewBox.height
    ? state.viewBox.width / state.viewBox.height
    : 0.75;
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 0.75;
  const minHeight = 140;
  const maxHeight = 260;
  const targetHeight = Math.max(minHeight, Math.min(maxHeight, window.innerHeight * 0.22));
  grid.style.setProperty('--preview-height', `${Math.round(targetHeight)}px`);

  const buttons = grid.querySelectorAll('.all-pages__page');
  buttons.forEach(button => {
    const pageCount = Number.parseFloat(button.dataset.pageCount || '1') || 1;
    const width = Math.max(targetHeight * safeRatio * pageCount, 120);
    button.style.setProperty('--preview-width', `${Math.round(width)}px`);
  });
}

function resolveArticleUrl(url) {
  const base = (state.config && state.config.articleBaseUrl) || articleBaseUrl;
  try {
    return new URL(url, base).href;
  } catch (error) {
    try {
      const normalizedBase = new URL(base);
      const cleaned = String(url || '').replace(/^\/+/, '');
      return `${normalizedBase.origin}/${cleaned}`;
    } catch (nestedError) {
      console.warn('Virhe URL-osoitteen muodostamisessa, palautetaan alkuperäinen arvo.', error);
      return url;
    }
  }
}

async function loadArticleContent(url) {
  const readingWindow = state.dom.readingWindow || document.querySelector('.reading-window');
  const content = state.dom.readingContent || document.querySelector('#article-content');
  if (!readingWindow || !content) {
    return;
  }

  openReadingWindow();
  readingWindow.scrollTop = 0;
  content.innerHTML = `<p>${resolveLabel('articleLoading', 'Ladataan sisältöä…')}</p>`;

  try {
    const articleUrl = resolveArticleUrl(url);
    const response = await fetch(articleUrl);
    if (!response.ok) {
      throw new Error(`Artikkelin lataus epäonnistui: ${response.status}`);
    }
    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const selector = state.config.articleClass || '.zoomArticle';
    const articleNode = doc.querySelector(selector) || doc.body;
    content.innerHTML = articleNode.innerHTML;

    const images = content.querySelectorAll('img');
    images.forEach(image => {
      const src = image.getAttribute('src');
      const dataSrc = image.getAttribute('data-aghref');
      const resolved = dataSrc || src;
      if (resolved) {
        image.src = resolveArticleUrl(resolved);
      }
    });

    const links = content.querySelectorAll('a[href]');
    links.forEach(link => {
      const href = link.getAttribute('href');
      if (href) {
        link.href = resolveArticleUrl(href);
      }
    });
  } catch (error) {
    console.error('Artikkelin lataaminen epäonnistui:', error);
    content.innerHTML = `<p>${resolveLabel('articleError', 'Artikkelin lataaminen epäonnistui.')}</p>`;
  }
}

function openReadingWindow() {
  const { readingWindow, readingBackdrop } = state.dom;
  if (!readingWindow) {
    return;
  }
  readingWindow.classList.add('is-open');
  readingWindow.setAttribute('aria-hidden', 'false');
  document.body.classList.add('reading-open');
  if (readingBackdrop) {
    readingBackdrop.classList.add('is-visible');
    readingBackdrop.setAttribute('aria-hidden', 'false');
  }
}

function closeReadingWindow() {
  const { readingWindow, readingBackdrop } = state.dom;
  if (!readingWindow) {
    return;
  }
  readingWindow.classList.remove('is-open');
  readingWindow.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('reading-open');
  if (readingBackdrop) {
    readingBackdrop.classList.remove('is-visible');
    readingBackdrop.setAttribute('aria-hidden', 'true');
  }
  state.currentArticleId = null;
  updateReadingNavigation();
  if (state.dom.readingTitle) {
    state.dom.readingTitle.textContent = resolveLabel('readingTitle', 'Artikkeli');
  }
}

function computeViewBox(res) {
  if (res && res.pagew && res.pageh && res.pageres) {
    const width = Math.round((res.pagew * res.pageres) / 72);
    const height = Math.round((res.pageh * res.pageres) / 72);
    return { width, height };
  }
  return { width: 1000, height: 1000 };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

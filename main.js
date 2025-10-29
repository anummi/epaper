'use strict';

const maxScale = 4;
const minScale = 1;
const scaleStep = 0.5;
const articleBaseUrl = 'https://sandbox-devtest2.anygraaf.net/';
const SETTINGS_STORAGE_KEY = 'epaper-settings';
const AUDIO_PROGRESS_STORAGE_KEY = 'epaper-audio-progress';
const AUDIO_PRODUCT_ID = 49;
const AUDIO_KEYBOARD_SEEK_SECONDS = 10;
const SUPPORTED_LANGUAGES = {
  fi: 'fi-FI',
  en: 'en-US'
};
const AD_ACTION_FALLBACKS = {
  openLink: 'Avaa verkkosivusto',
  call: 'Soita',
  navigate: 'Navigoi',
  openImage: 'Avaa mainos',
  hotspot: 'Mainostoiminnot',
  windowTitle: 'Mainos',
  imageUnavailable: 'Mainoksen kuva ei ole saatavilla.'
};

const state = {
  config: null,
  imagePaths: [],
  pageMaps: [],
  pageArticles: [],
  pageAds: [],
  articleLookup: new Map(),
  articlePageLookup: new Map(),
  adLookup: new Map(),
  adPageLookup: new Map(),
  archiveItems: [],
  archiveLoaded: false,
  currentIssuePath: null,
  slideDefinitions: [],
  slides: [],
  currentSlide: 0,
  activePageIndex: 0,
  articleOrder: [],
  currentArticleId: null,
  currentAdId: null,
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
  audio: {
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    isLoading: false,
    error: null,
    resume: null,
    resumePromptVisible: false,
    lastSavedTime: 0,
    audioElement: null,
    playerVisible: false,
    pendingSeekTime: null
  },
  dom: {}
};

const panState = {
  active: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  baseX: 0,
  baseY: 0,
  surface: null
};

const pointerTracker = new Map();

let pendingZoomFrame = null;
let pendingZoomSurface = null;

const pinchState = {
  active: false,
  surface: null,
  initialDistance: 0,
  initialScale: 1
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

function getAdConfig() {
  return state.config?.ads || {};
}

function getAdActionLabel(key, fallback = '') {
  const labels = getAdConfig().labels || {};
  const defaultValue = fallback || AD_ACTION_FALLBACKS[key] || '';
  return getLocalizedValue(labels[key], defaultValue);
}

function getAdIconDefinition(key) {
  const icons = getAdConfig().icons || {};
  const icon = icons[key];
  if (!icon || !icon.path) {
    return null;
  }
  return icon;
}

function getInterfaceIconDefinition(key) {
  const icons = state.config?.icons || {};
  const icon = icons[key];
  if (!icon || !icon.path) {
    return null;
  }
  return icon;
}

function areArticleClicksEnabled() {
  const value = state.config?.articleClicksEnabled;
  if (value == null) {
    return true;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized !== 'false' && normalized !== '0' && normalized !== 'no';
  }
  return Boolean(value);
}

function createIconElement(definition) {
  if (!definition || !definition.path) {
    return null;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', definition.viewBox || '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', definition.path);
  svg.appendChild(path);
  return svg;
}

function getAdWindowTitle() {
  return getAdActionLabel('windowTitle', AD_ACTION_FALLBACKS.windowTitle);
}

function parseMapCoordinates(source) {
  if (!source) {
    return null;
  }
  const values = String(source)
    .split(',')
    .map(part => Number.parseFloat(part.trim()));
  if (values.length !== 4 || values.some(value => Number.isNaN(value))) {
    return null;
  }
  const [x1, y1, x2, y2] = values.map(value => value / 1000);
  if (x2 <= x1 || y2 <= y1) {
    return null;
  }
  return {
    x1,
    y1,
    x2,
    y2,
    width: x2 - x1,
    height: y2 - y1
  };
}

function resolveAdUrl(value) {
  if (!value) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  if (/^https?:/i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function normalizeHomePageUrl(value) {
  if (!value && value !== 0) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('//')) {
    const protocol = typeof window !== 'undefined' && window?.location?.protocol
      ? window.location.protocol
      : 'https:';
    return `${protocol}${trimmed}`;
  }
  if (trimmed.startsWith('/')) {
    return trimmed;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function getDefaultHomePageUrl() {
  if (typeof window === 'undefined') {
    return '/';
  }
  const { location } = window;
  if (!location) {
    return '/';
  }
  if (location.origin && location.origin !== 'null') {
    return location.origin;
  }
  if (location.protocol && location.host) {
    return `${location.protocol}//${location.host}`;
  }
  return '/';
}

function getHomePageUrl() {
  const override = normalizeHomePageUrl(state.config?.homePageUrl);
  if (override) {
    return override;
  }
  return getDefaultHomePageUrl();
}

function normalizePhoneNumber(value) {
  if (!value) {
    return null;
  }
  const cleaned = String(value).replace(/[^\d+]/g, '');
  if (!cleaned || cleaned === '0') {
    return null;
  }
  return cleaned;
}

function buildAdNavigationQuery(ad) {
  if (!ad) {
    return null;
  }
  const parts = [ad.st, ad.zi, ad.ci]
    .map(part => (part ? String(part).trim() : ''))
    .filter(Boolean);
  if (!parts.length && ad.n) {
    parts.push(String(ad.n).trim());
  }
  if (!parts.length) {
    return null;
  }
  return parts.join(', ');
}

function resolveAdImageUrl(adId) {
  const configId = state.config?.id;
  const issuePath = state.currentIssuePath;
  if (!configId || !issuePath || !adId) {
    return null;
  }
  const normalized = normalizeArchivePath(issuePath);
  return `static/${configId}/${normalized}a${adId}`;
}

function createAdActionElement({ key, href = null, target = '_self', rel = null, onClick = null, className = '' }) {
  const label = getAdActionLabel(key, AD_ACTION_FALLBACKS[key] || '');
  let element;
  if (href) {
    element = document.createElement('a');
    element.href = href;
    if (target) {
      element.target = target;
    }
    if (rel) {
      element.rel = rel;
    } else if (target === '_blank') {
      element.rel = 'noopener noreferrer';
    }
  } else {
    element = document.createElement('button');
    element.type = 'button';
  }
  element.classList.add('ad-action');
  element.dataset.actionKey = key;
  if (className) {
    element.classList.add(className);
  }
  element.setAttribute('aria-label', label);
  element.title = label;
  const icon = createIconElement(getAdIconDefinition(key));
  if (icon) {
    element.appendChild(icon);
  } else {
    element.textContent = label;
  }
  if (typeof onClick === 'function') {
    element.addEventListener('click', event => {
      onClick(event);
    });
  }
  return element;
}

function getAdContactDetails(ad) {
  if (!ad) {
    return {
      address: '',
      phone: null,
      website: null,
      navigationUrl: null
    };
  }
  const addressParts = [ad.st, ad.zi, ad.ci]
    .map(part => (part ? String(part).trim() : ''))
    .filter(Boolean);
  const phone = normalizePhoneNumber(ad.p);
  const website = resolveAdUrl(ad.s);
  const navigationQuery = buildAdNavigationQuery(ad);
  const navigationUrl = navigationQuery
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(navigationQuery)}`
    : null;
  return {
    address: addressParts.join(', '),
    phone,
    website,
    navigationUrl
  };
}

function createAdDetailsSection(ad) {
  const details = getAdContactDetails(ad);
  const container = document.createElement('div');
  container.className = 'ad-details';

  if (details.address) {
    const address = document.createElement('p');
    address.className = 'ad-details__address';
    address.textContent = details.address;
    container.appendChild(address);
  }

  const links = [];
  if (details.phone) {
    const phoneLink = document.createElement('a');
    phoneLink.className = 'ad-details__link ad-details__link--phone';
    phoneLink.href = `tel:${details.phone}`;
    phoneLink.textContent = details.phone;
    phoneLink.setAttribute('aria-label', `${getAdActionLabel('call', AD_ACTION_FALLBACKS.call)} ${details.phone}`.trim());
    links.push(phoneLink);
  }
  if (details.website) {
    const websiteLink = document.createElement('a');
    websiteLink.className = 'ad-details__link ad-details__link--website';
    websiteLink.href = details.website;
    websiteLink.target = '_blank';
    websiteLink.rel = 'noopener noreferrer';
    websiteLink.textContent = details.website;
    websiteLink.setAttribute('aria-label', getAdActionLabel('openLink', AD_ACTION_FALLBACKS.openLink));
    links.push(websiteLink);
  }
  if (details.navigationUrl) {
    const navigateLink = document.createElement('a');
    navigateLink.className = 'ad-details__link ad-details__link--navigate';
    navigateLink.href = details.navigationUrl;
    navigateLink.target = '_blank';
    navigateLink.rel = 'noopener noreferrer';
    navigateLink.textContent = getAdActionLabel('navigate', AD_ACTION_FALLBACKS.navigate);
    navigateLink.setAttribute('aria-label', getAdActionLabel('navigate', AD_ACTION_FALLBACKS.navigate));
    links.push(navigateLink);
  }

  if (links.length) {
    const linkWrapper = document.createElement('div');
    linkWrapper.className = 'ad-details__links';
    links.forEach(link => linkWrapper.appendChild(link));
    container.appendChild(linkWrapper);
  }

  if (!container.childNodes.length) {
    return null;
  }

  return container;
}

function buildAdActionDescriptors(adId, ad) {
  const descriptors = [];
  const details = getAdContactDetails(ad);
  if (details.website) {
    descriptors.push({ key: 'openLink', href: details.website, target: '_blank' });
  }
  if (details.phone) {
    descriptors.push({ key: 'call', href: `tel:${details.phone}` });
  }
  if (details.navigationUrl) {
    descriptors.push({ key: 'navigate', href: details.navigationUrl, target: '_blank' });
  }
  descriptors.push({
    key: 'openImage',
    onClick: event => {
      if (event) {
        event.preventDefault();
      }
      openAdById(adId);
    }
  });
  return descriptors;
}

function createAdActionsContainer(adId, ad) {
  const descriptors = buildAdActionDescriptors(adId, ad);
  if (!descriptors.length) {
    return null;
  }
  const actions = document.createElement('div');
  actions.className = 'ad-actions';
  ['pointerdown', 'pointerup'].forEach(type => {
    actions.addEventListener(type, event => event.stopPropagation());
  });
  actions.addEventListener('click', event => event.stopPropagation());
  descriptors.forEach(descriptor => {
    const button = createAdActionElement(descriptor);
    actions.appendChild(button);
  });
  return actions;
}

function getAdImageSources(adId) {
  const imageBase = resolveAdImageUrl(adId);
  if (!imageBase) {
    return [];
  }
  return [`${imageBase}.webp`, `${imageBase}.jpg`, `${imageBase}.png`];
}

function createAdImageElement(adId, ad, options = {}) {
  const sources = getAdImageSources(adId);
  if (!sources.length) {
    return null;
  }
  const image = document.createElement('img');
  image.alt = ad?.n || getAdWindowTitle();
  image.src = sources[0];
  if (options.loading) {
    image.loading = options.loading;
  }
  if (sources.length > 1) {
    let index = 1;
    const handleError = () => {
      if (index >= sources.length) {
        image.removeEventListener('error', handleError);
        return;
      }
      image.src = sources[index];
      index += 1;
    };
    image.addEventListener('error', handleError);
  }
  if (typeof options.onLoad === 'function') {
    if (image.complete) {
      options.onLoad(image);
    } else {
      image.addEventListener('load', () => options.onLoad(image), { once: true });
    }
  }
  return image;
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
  menuBar.id = 'main-menu';
  shell.appendChild(menuBar);

  const menuContent = document.createElement('div');
  menuContent.className = 'menu-content';
  menuContent.dataset.role = 'menu';
  menuBar.appendChild(menuContent);

  const mobileMenuClose = document.createElement('button');
  mobileMenuClose.type = 'button';
  mobileMenuClose.className = 'mobile-menu-close';
  mobileMenuClose.textContent = '×';
  menuBar.appendChild(mobileMenuClose);

  const stage = document.createElement('main');
  stage.className = 'page-stage';
  shell.appendChild(stage);

  const navPrev = document.createElement('button');
  navPrev.type = 'button';
  navPrev.className = 'nav-button nav-prev';
  stage.appendChild(navPrev);
  const navPrevIcon = createIconElement(getInterfaceIconDefinition('arrowLeft'));
  if (navPrevIcon) {
    navPrevIcon.classList.add('nav-button__icon');
    navPrev.appendChild(navPrevIcon);
  } else {
    navPrev.textContent = '‹';
  }

  const pageTrack = document.createElement('div');
  pageTrack.className = 'page-track';
  pageTrack.setAttribute('aria-live', 'polite');
  stage.appendChild(pageTrack);

  const navNext = document.createElement('button');
  navNext.type = 'button';
  navNext.className = 'nav-button nav-next';
  stage.appendChild(navNext);
  const navNextIcon = createIconElement(getInterfaceIconDefinition('arrowLeft'));
  if (navNextIcon) {
    navNextIcon.classList.add('nav-button__icon', 'nav-button__icon--next');
    navNext.appendChild(navNextIcon);
  } else {
    navNext.textContent = '›';
  }

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

  const mobileMenuBackdrop = document.createElement('div');
  mobileMenuBackdrop.className = 'mobile-menu-backdrop';
  mobileMenuBackdrop.setAttribute('aria-hidden', 'true');
  shell.appendChild(mobileMenuBackdrop);

  const mobileMenuButton = document.createElement('button');
  mobileMenuButton.type = 'button';
  mobileMenuButton.className = 'mobile-menu-button';
  mobileMenuButton.setAttribute('aria-controls', 'main-menu');
  mobileMenuButton.setAttribute('aria-expanded', 'false');
  const mobileMenuIcon = document.createElement('span');
  mobileMenuIcon.className = 'mobile-menu-button__icon';
  mobileMenuIcon.setAttribute('aria-hidden', 'true');
  mobileMenuIcon.textContent = '☰';
  const mobileMenuLabel = document.createElement('span');
  mobileMenuLabel.className = 'mobile-menu-button__label';
  mobileMenuButton.appendChild(mobileMenuIcon);
  mobileMenuButton.appendChild(mobileMenuLabel);
  shell.appendChild(mobileMenuButton);

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
  const readingPrevIcon = createIconElement(getInterfaceIconDefinition('arrowLeft'));
  if (readingPrevIcon) {
    readingPrevIcon.classList.add('reading-window__nav-button-icon');
    readingPrev.appendChild(readingPrevIcon);
  } else {
    const fallbackPrev = document.createElement('span');
    fallbackPrev.setAttribute('aria-hidden', 'true');
    fallbackPrev.textContent = '←';
    readingPrev.appendChild(fallbackPrev);
  }
  readingControls.appendChild(readingPrev);

  const readingNext = document.createElement('button');
  readingNext.type = 'button';
  readingNext.className = 'reading-window__nav-button reading-window__nav-button--next';
  const readingNextIcon = createIconElement(getInterfaceIconDefinition('arrowLeft'));
  if (readingNextIcon) {
    readingNextIcon.classList.add('reading-window__nav-button-icon', 'reading-window__nav-button-icon--next');
    readingNext.appendChild(readingNextIcon);
  } else {
    const fallbackNext = document.createElement('span');
    fallbackNext.setAttribute('aria-hidden', 'true');
    fallbackNext.textContent = '→';
    readingNext.appendChild(fallbackNext);
  }
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

  const adsPanel = document.createElement('aside');
  adsPanel.className = 'ads-panel';
  adsPanel.setAttribute('aria-hidden', 'true');
  const adsDialog = document.createElement('div');
  adsDialog.className = 'ads-panel__dialog';
  adsDialog.setAttribute('role', 'dialog');
  adsDialog.setAttribute('aria-modal', 'true');
  const adsHeader = document.createElement('header');
  adsHeader.className = 'ads-panel__header';
  const adsTitle = document.createElement('h2');
  adsTitle.id = 'ads-panel-title';
  adsTitle.className = 'ads-panel__title';
  adsHeader.appendChild(adsTitle);
  const adsClose = document.createElement('button');
  adsClose.type = 'button';
  adsClose.className = 'ads-panel__close';
  adsClose.textContent = '×';
  adsHeader.appendChild(adsClose);
  const adsContent = document.createElement('div');
  adsContent.className = 'ads-panel__content';
  const adsEmpty = document.createElement('p');
  adsEmpty.className = 'ads-panel__empty';
  adsEmpty.hidden = true;
  adsEmpty.setAttribute('aria-hidden', 'true');
  const adsGrid = document.createElement('div');
  adsGrid.className = 'ads-panel__grid';
  adsContent.appendChild(adsEmpty);
  adsContent.appendChild(adsGrid);
  adsDialog.appendChild(adsHeader);
  adsDialog.appendChild(adsContent);
  adsDialog.setAttribute('aria-labelledby', 'ads-panel-title');
  adsPanel.appendChild(adsDialog);
  shell.appendChild(adsPanel);

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

  const audioBackdrop = document.createElement('div');
  audioBackdrop.className = 'audio-player__backdrop';
  audioBackdrop.hidden = true;
  audioBackdrop.setAttribute('aria-hidden', 'true');
  shell.appendChild(audioBackdrop);

  const audioPlayer = document.createElement('section');
  audioPlayer.className = 'audio-player';
  audioPlayer.setAttribute('aria-hidden', 'true');

  const audioHeader = document.createElement('div');
  audioHeader.className = 'audio-player__header';
  const audioInfo = document.createElement('div');
  audioInfo.className = 'audio-player__info';

  const audioPage = document.createElement('span');
  audioPage.className = 'audio-player__page';
  audioInfo.appendChild(audioPage);

  const audioTitle = document.createElement('h3');
  audioTitle.className = 'audio-player__title';
  audioInfo.appendChild(audioTitle);

  const audioClose = document.createElement('button');
  audioClose.type = 'button';
  audioClose.className = 'audio-player__close';
  audioClose.textContent = '×';

  audioHeader.appendChild(audioInfo);
  audioHeader.appendChild(audioClose);
  audioPlayer.appendChild(audioHeader);

  const audioControls = document.createElement('div');
  audioControls.className = 'audio-player__controls';

  const audioPrev = document.createElement('button');
  audioPrev.type = 'button';
  audioPrev.className = 'audio-player__button audio-player__button--prev';
  audioPrev.innerHTML = '<span aria-hidden="true">⏮</span>';

  const audioPlay = document.createElement('button');
  audioPlay.type = 'button';
  audioPlay.className = 'audio-player__button audio-player__button--play';
  audioPlay.innerHTML = '<span aria-hidden="true">▶</span>';

  const audioNext = document.createElement('button');
  audioNext.type = 'button';
  audioNext.className = 'audio-player__button audio-player__button--next';
  audioNext.innerHTML = '<span aria-hidden="true">⏭</span>';

  audioControls.appendChild(audioPrev);
  audioControls.appendChild(audioPlay);
  audioControls.appendChild(audioNext);
  audioPlayer.appendChild(audioControls);

  const audioProgress = document.createElement('div');
  audioProgress.className = 'audio-player__progress';
  const audioTimeCurrent = document.createElement('span');
  audioTimeCurrent.className = 'audio-player__time audio-player__time--current';
  audioTimeCurrent.textContent = '0:00';
  const audioTimeline = document.createElement('div');
  audioTimeline.className = 'audio-player__timeline';
  audioTimeline.setAttribute('role', 'slider');
  audioTimeline.setAttribute('aria-valuemin', '0');
  audioTimeline.setAttribute('aria-valuemax', '100');
  audioTimeline.setAttribute('aria-valuenow', '0');
  audioTimeline.tabIndex = 0;
  const audioTimeTotal = document.createElement('span');
  audioTimeTotal.className = 'audio-player__time audio-player__time--total';
  audioTimeTotal.textContent = '0:00';
  audioProgress.appendChild(audioTimeCurrent);
  audioProgress.appendChild(audioTimeline);
  audioProgress.appendChild(audioTimeTotal);
  audioPlayer.appendChild(audioProgress);

  const audioStatus = document.createElement('p');
  audioStatus.className = 'audio-player__status';
  audioStatus.hidden = true;
  audioStatus.setAttribute('aria-live', 'polite');
  audioPlayer.appendChild(audioStatus);

  shell.appendChild(audioPlayer);

  const audioResumeOverlay = document.createElement('div');
  audioResumeOverlay.className = 'audio-resume';
  audioResumeOverlay.hidden = true;
  audioResumeOverlay.setAttribute('aria-hidden', 'true');
  audioResumeOverlay.setAttribute('role', 'dialog');
  audioResumeOverlay.setAttribute('aria-modal', 'true');
  const audioResumeDialog = document.createElement('div');
  audioResumeDialog.className = 'audio-resume__dialog';
  const audioResumeMessage = document.createElement('p');
  audioResumeMessage.className = 'audio-resume__message';
  audioResumeMessage.id = 'audio-resume-message';
  audioResumeOverlay.setAttribute('aria-labelledby', 'audio-resume-message');
  const audioResumeActions = document.createElement('div');
  audioResumeActions.className = 'audio-resume__actions';
  const audioResumeContinue = document.createElement('button');
  audioResumeContinue.type = 'button';
  audioResumeContinue.className = 'audio-resume__button audio-resume__button--primary';
  const audioResumeRestart = document.createElement('button');
  audioResumeRestart.type = 'button';
  audioResumeRestart.className = 'audio-resume__button audio-resume__button--secondary';
  audioResumeActions.appendChild(audioResumeContinue);
  audioResumeActions.appendChild(audioResumeRestart);
  audioResumeDialog.appendChild(audioResumeMessage);
  audioResumeDialog.appendChild(audioResumeActions);
  audioResumeOverlay.appendChild(audioResumeDialog);
  shell.appendChild(audioResumeOverlay);

  const audioElement = new Audio();
  audioElement.preload = 'auto';
  audioElement.crossOrigin = 'anonymous';
  state.audio.audioElement = audioElement;
  bindAudioElementEvents(audioElement);

  state.dom = {
    shell,
    stage,
    menuContent,
    menuBar,
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
    adsPanel,
    adsDialog,
    adsTitle,
    adsClose,
    adsGrid,
    adsEmpty,
    settingsPanel,
    settingsDialog,
    settingsTitle,
    settingsClose,
    languageLabel: languageSpan,
    languageSelect,
    darkModeLabel: darkModeSpan,
    darkModeToggle,
    audioBackdrop,
    audioPlayer,
    audioTitle,
    audioPage,
    audioClose,
    audioPrev,
    audioPlay,
    audioNext,
    audioTimeCurrent,
    audioTimeTotal,
    audioTimeline,
    audioStatus,
    audioResumeOverlay,
    audioResumeMessage,
    audioResumeContinue,
    audioResumeRestart,
    mobileMenuButton,
    mobileMenuClose,
    mobileMenuBackdrop
  };

  refreshMobileMenuAccessibility();
  updateAudioUI();
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

  if (dom.mobileMenuButton) {
    const openLabel = resolveLabel('openMenu', 'Avaa valikko');
    dom.mobileMenuButton.setAttribute('aria-label', openLabel);
    const labelElement = dom.mobileMenuButton.querySelector('.mobile-menu-button__label');
    if (labelElement) {
      labelElement.textContent = getNavigationLabelByAction('toggle-menu') || resolveLabel('menuLabel', 'Valikko');
    }
  }

  if (dom.mobileMenuClose) {
    const closeMenuLabel = resolveLabel('closeMenu', 'Sulje valikko');
    dom.mobileMenuClose.setAttribute('aria-label', closeMenuLabel);
    dom.mobileMenuClose.title = closeMenuLabel;
  }

  refreshMobileMenuAccessibility();

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
    if (state.currentAdId) {
      dom.readingTitle.textContent = getAdWindowTitle();
      dom.readingTitle.hidden = false;
      dom.readingTitle.setAttribute('aria-hidden', 'false');
    } else {
      dom.readingTitle.textContent = '';
      dom.readingTitle.hidden = true;
      dom.readingTitle.setAttribute('aria-hidden', 'true');
    }
  }
  dom.readingClose?.setAttribute('aria-label', resolveLabel('closeArticle', 'Sulje artikkeli'));
  updateReadingNavigation();
  updateAdHotspotLabels();

  if (dom.adsTitle) {
    dom.adsTitle.textContent = getNavigationLabelByAction('ads') || resolveLabel('adsTitle', 'Mainokset');
  }
  if (dom.adsClose) {
    const closeLabel = resolveLabel('closeAds', 'Sulje mainokset');
    dom.adsClose.setAttribute('aria-label', closeLabel);
    dom.adsClose.title = closeLabel;
  }
  if (dom.adsEmpty) {
    dom.adsEmpty.textContent = resolveLabel('adsEmpty', 'Lehdessä ei ole mainoksia.');
  }

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
  buildAdsPanelContent();
  if (state.currentAdId) {
    openAdById(state.currentAdId);
  }
  updateAudioUI();
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

function sanitizeIssueParam(value) {
  if (!value) {
    return '';
  }
  return String(value).replace(/\//g, '').trim();
}

function updateLocation() {
  if (!state.currentIssuePath) {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const shareableIssue = sanitizeIssueParam(state.currentIssuePath);
  if (shareableIssue) {
    params.set('issue', shareableIssue);
  } else {
    params.delete('issue');
  }
  params.set('page', String((state.activePageIndex || 0) + 1));
  const newUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({ issue: state.currentIssuePath, page: state.activePageIndex }, '', newUrl);
}

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('DOMContentLoaded', () => {
  const panel = document.querySelector('.ads-panel');
  if (!panel) {
    return;
  }

  const ensureLayout = () => {
    if (panel.classList.contains('is-open')) {
      refreshAdsPanelLayout();
    }
  };

  ensureLayout();

  const observer = new MutationObserver(ensureLayout);
  observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
});

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

  if (issue.path) {
    state.currentIssuePath = normalizeArchivePath(issue.path);
  }

  state.imagePaths = Array.isArray(issue.imagePaths) ? issue.imagePaths : [];
  state.pageMaps = Array.isArray(issue.pageMaps) ? issue.pageMaps : [];
  state.pageArticles = Array.isArray(issue.pageArticles) ? issue.pageArticles : [];
  state.pageAds = Array.isArray(issue.pageAds) ? issue.pageAds : [];
  state.articleLookup = new Map(state.pageArticles.map(article => [String(article.id), article]));
  state.articlePageLookup = buildArticlePageLookup(state.pageMaps);
  state.articleOrder = state.pageArticles
    .map(article => String(article.id))
    .filter(id => Boolean(id));
  prepareAudioForIssue();
  state.currentArticleId = null;
  state.currentAdId = null;
  state.adLookup = new Map();
  state.adPageLookup = new Map();
  state.pageAds.forEach((ads, pageIndex) => {
    if (!Array.isArray(ads)) {
      return;
    }
    ads.forEach(ad => {
      if (!ad || ad.i == null) {
        return;
      }
      const id = String(ad.i);
      state.adLookup.set(id, ad);
      if (!state.adPageLookup.has(id)) {
        state.adPageLookup.set(id, pageIndex);
      }
    });
  });
  buildAdsPanelContent();
  state.viewBox = computeViewBox(issue.res);
  if (Array.isArray(issue.archiveItems) && issue.archiveItems.length) {
    state.archiveItems = issue.archiveItems;
  }
  state.dom.readingWindow?.classList.remove('reading-window--ad');
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
      closeMobileMenu();
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
    case 'ads':
      openAdsPanel();
      break;
    case 'audio':
      handleAudioAction();
      break;
    case 'archive':
      openArchivePanel();
      break;
    case 'settings':
      openSettingsPanel();
      break;
    case 'home-page':
      navigateToHomePage();
      break;
    default:
      break;
  }
}

function navigateToHomePage() {
  const url = getHomePageUrl();
  if (!url) {
    return;
  }
  try {
    window.location.assign(url);
  } catch (error) {
    console.warn('Kotisivulle siirtyminen epäonnistui:', error);
    window.location.href = url;
  }
}

function attachGlobalListeners() {
  if (state.listenersAttached) {
    bindNavigationHandlers();
    return;
  }
  state.listenersAttached = true;

  const {
    stage,
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
    adsPanel,
    adsClose,
    settingsPanel,
    settingsClose,
    languageSelect,
    darkModeToggle,
    audioBackdrop,
    audioClose,
    audioPrev,
    audioPlay,
    audioNext,
    audioTimeline,
    audioResumeOverlay,
    audioResumeContinue,
    audioResumeRestart,
    mobileMenuButton,
    mobileMenuClose,
    mobileMenuBackdrop
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

  adsClose?.addEventListener('click', closeAdsPanel);
  adsPanel?.addEventListener('click', event => {
    if (event.target === adsPanel) {
      closeAdsPanel();
    }
  });

  settingsClose?.addEventListener('click', closeSettingsPanel);
  settingsPanel?.addEventListener('click', event => {
    if (event.target === settingsPanel) {
      closeSettingsPanel();
    }
  });

  languageSelect?.addEventListener('change', handleLanguageChange);
  darkModeToggle?.addEventListener('change', handleDarkModeChange);

  audioClose?.addEventListener('click', () => stopAudioPlayback());
  audioPrev?.addEventListener('click', () => skipAudio(-1));
  audioNext?.addEventListener('click', () => skipAudio(1));
  audioPlay?.addEventListener('click', toggleAudioPlayback);
  audioTimeline?.addEventListener('click', handleAudioTimelineClick);
  audioTimeline?.addEventListener('keydown', handleAudioTimelineKeydown);
  audioBackdrop?.addEventListener('click', () => stopAudioPlayback());
  audioResumeContinue?.addEventListener('click', handleAudioResumeContinue);
  audioResumeRestart?.addEventListener('click', handleAudioResumeRestart);

  mobileMenuButton?.addEventListener('click', toggleMobileMenu);
  mobileMenuClose?.addEventListener('click', () => closeMobileMenu({ focusTrigger: true }));
  mobileMenuBackdrop?.addEventListener('click', () => closeMobileMenu({ focusTrigger: true }));

  stage?.addEventListener('pointerdown', handleStagePointerDown);
  stage?.addEventListener('pointermove', movePan);
  stage?.addEventListener('pointerup', endPan);
  stage?.addEventListener('pointercancel', endPan);

  document.addEventListener('fullscreenchange', updateFullscreenUI);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('resize', handleResize);
  document.addEventListener('pointerdown', handleGlobalPointerDown);

  bindNavigationHandlers();
}

function toggleMenuCollapsed() {
  document.body.classList.toggle('menu-collapsed');
}

function shouldHideMobileMenuButton() {
  if (window.innerWidth >= 900) {
    return false;
  }
  if (document.body.classList.contains('mobile-menu-open')) {
    return true;
  }
  if (
    document.body.classList.contains('is-zoomed') ||
    document.body.classList.contains('reading-open') ||
    document.body.classList.contains('ads-open') ||
    document.body.classList.contains('audio-player-open')
  ) {
    return true;
  }
  const dom = state.dom || {};
  if (dom.allPages?.classList.contains('is-open')) {
    return true;
  }
  if (dom.archivePanel?.classList.contains('is-open')) {
    return true;
  }
  if (dom.settingsPanel?.classList.contains('is-open')) {
    return true;
  }
  if (dom.readingWindow?.classList.contains('is-open')) {
    return true;
  }
  return false;
}

function updateMobileMenuButtonVisibility() {
  const button = state.dom?.mobileMenuButton;
  if (!button) {
    return;
  }
  const shouldHide = shouldHideMobileMenuButton();
  button.classList.toggle('mobile-menu-button--hidden', shouldHide);
}

function refreshMobileMenuAccessibility() {
  const { menuBar, mobileMenuBackdrop, mobileMenuButton } = state.dom || {};
  const isSmallViewport = window.innerWidth < 900;
  const isOpen = document.body.classList.contains('mobile-menu-open');
  if (menuBar) {
    menuBar.setAttribute('aria-hidden', isSmallViewport && !isOpen ? 'true' : 'false');
  }
  if (mobileMenuBackdrop) {
    mobileMenuBackdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  }
  if (mobileMenuButton) {
    mobileMenuButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }
  updateMobileMenuButtonVisibility();
}

function openMobileMenu() {
  if (window.innerWidth >= 900) {
    refreshMobileMenuAccessibility();
    return;
  }
  if (document.body.classList.contains('mobile-menu-open')) {
    return;
  }
  document.body.classList.add('mobile-menu-open');
  refreshMobileMenuAccessibility();
  const firstItem = state.dom?.menuContent?.querySelector('.menu-item');
  if (firstItem instanceof HTMLElement) {
    firstItem.focus({ preventScroll: true });
  }
}

function closeMobileMenu(options = {}) {
  if (!document.body.classList.contains('mobile-menu-open')) {
    refreshMobileMenuAccessibility();
    return;
  }
  document.body.classList.remove('mobile-menu-open');
  refreshMobileMenuAccessibility();
  const focusTrigger = Boolean(options.focusTrigger);
  if (focusTrigger && state.dom?.mobileMenuButton instanceof HTMLElement) {
    state.dom.mobileMenuButton.focus({ preventScroll: true });
  }
}

function toggleMobileMenu() {
  if (document.body.classList.contains('mobile-menu-open')) {
    closeMobileMenu();
  } else {
    openMobileMenu();
  }
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
    deactivateAllAdHotspots();
    if (state.audio.playerVisible) {
      stopAudioPlayback();
      return;
    }
    if (document.body.classList.contains('is-zoomed')) {
      resetZoom();
      return;
    }
    if (document.body.classList.contains('mobile-menu-open')) {
      closeMobileMenu({ focusTrigger: true });
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
    if (isAdsPanelOpen()) {
      closeAdsPanel();
      return;
    }
  }

  const audioElement = state.audio.audioElement;
  const audioActive = Boolean(
    state.audio.isPlaying &&
    state.audio.currentIndex >= 0 &&
    audioElement &&
    (typeof HTMLAudioElement === 'undefined' || audioElement instanceof HTMLAudioElement)
  );

  if (audioActive && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    seekAudioBy(direction * AUDIO_KEYBOARD_SEEK_SECONDS);
    return;
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

function handleGlobalPointerDown(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (target.closest('.ad-hotspot')) {
    return;
  }
  deactivateAllAdHotspots();
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
  const isAd = Boolean(state.currentAdId);

  if (readingLabel) {
    readingLabel.textContent = isAd
      ? getAdWindowTitle()
      : resolveLabel('readingWindowTitle', 'Lukuikkuna');
  }

  if (isAd) {
    [readingPrev, readingNext].forEach(button => {
      if (!button) {
        return;
      }
      button.hidden = true;
      button.setAttribute('aria-hidden', 'true');
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      delete button.dataset.targetArticle;
    });
    return;
  }

  [readingPrev, readingNext].forEach(button => {
    if (!button) {
      return;
    }
    button.hidden = false;
    button.setAttribute('aria-hidden', 'false');
  });

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
  if (state.currentAdId) {
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
  state.currentAdId = null;
  state.dom.readingWindow?.classList.remove('reading-window--ad');
  deactivateAllAdHotspots();
  focusPageForArticle(id, { keepReadingOpen: true });
  const heading = state.dom.readingTitle;
  if (heading) {
    heading.textContent = '';
    heading.hidden = true;
    heading.setAttribute('aria-hidden', 'true');
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
  closeMobileMenu();
  toggleAllPages(false);
  closeSettingsPanel();
  closeReadingWindow();
  closeAdsPanel();
  buildArchiveList();
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  updateMobileMenuButtonVisibility();
}

function closeArchivePanel() {
  const panel = state.dom.archivePanel || document.querySelector('.archive-panel');
  if (!panel) {
    return;
  }
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  updateMobileMenuButtonVisibility();
}

function getAdsPanelGrid() {
  return state.dom?.adsGrid || document.querySelector('.ads-panel__grid');
}

function getAdsPanelColumnCount() {
  if (window.matchMedia?.('(max-width: 640px)').matches) {
    return 1;
  }
  if (window.matchMedia?.('(max-width: 1024px)').matches) {
    return 2;
  }
  return 3;
}

function destroyAdsPanelLayout() {}

function requestAdsPanelLayout() {
  refreshAdsPanelLayout();
}

function refreshAdsPanelLayout() {
  const grid = getAdsPanelGrid();
  if (!grid) {
    return;
  }
  const cards = grid.querySelectorAll('.ads-card');
  if (!cards.length) {
    return;
  }
  const columns = Math.max(getAdsPanelColumnCount(), 1);
  grid.style.setProperty('--ads-panel-columns', String(columns));
}

function openAdsPanel() {
  const { adsPanel, adsClose } = state.dom;
  if (!adsPanel) {
    return;
  }
  closeMobileMenu();
  toggleAllPages(false);
  closeArchivePanel();
  closeSettingsPanel();
  closeReadingWindow();
  buildAdsPanelContent();
  adsPanel.classList.add('is-open');
  adsPanel.setAttribute('aria-hidden', 'false');
  adsPanel.classList.remove('ads-panel--blurred');
  document.body.classList.add('ads-open');
  requestAdsPanelLayout();
  requestAnimationFrame(() => {
    adsClose?.focus({ preventScroll: true });
  });
  updateMobileMenuButtonVisibility();
}

function closeAdsPanel() {
  const panel = state.dom.adsPanel;
  if (!panel) {
    return;
  }
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('ads-open');
  panel.classList.remove('ads-panel--blurred');
  destroyAdsPanelLayout();
  updateMobileMenuButtonVisibility();
}

function isAdsPanelOpen() {
  const panel = state.dom.adsPanel;
  return Boolean(panel && panel.classList.contains('is-open'));
}

function openSettingsPanel() {
  const panel = state.dom.settingsPanel;
  if (!panel) {
    return;
  }
  closeMobileMenu();
  toggleAllPages(false);
  closeArchivePanel();
  closeReadingWindow();
  closeAdsPanel();
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  state.dom.languageSelect?.focus({ preventScroll: true });
  updateMobileMenuButtonVisibility();
}

function closeSettingsPanel() {
  const panel = state.dom.settingsPanel;
  if (!panel) {
    return;
  }
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  updateMobileMenuButtonVisibility();
}

function handleResize() {
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    const newOrientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
    const isCompact = window.innerWidth < 900;
    if (window.innerWidth >= 900 && document.body.classList.contains('mobile-menu-open')) {
      closeMobileMenu();
    }
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
    refreshAdsPanelLayout();
    refreshMobileMenuAccessibility();
  }, 180);
}

function collectAdsInOrder() {
  const ads = [];
  const seen = new Set();
  if (!Array.isArray(state.pageAds)) {
    return ads;
  }
  state.pageAds.forEach((adsOnPage, pageIndex) => {
    if (!Array.isArray(adsOnPage)) {
      return;
    }
    adsOnPage.forEach((ad, index) => {
      if (!ad || ad.i == null) {
        return;
      }
      const id = String(ad.i);
      if (seen.has(id)) {
        return;
      }
      const adData = state.adLookup.get(id) || ad;
      seen.add(id);
      ads.push({ id, ad: adData, pageIndex, order: index });
    });
  });
  ads.sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) {
      return a.pageIndex - b.pageIndex;
    }
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.id.localeCompare(b.id);
  });
  return ads;
}

function buildAdsPanelContent() {
  const grid = getAdsPanelGrid();
  const emptyMessage = state.dom.adsEmpty;
  if (!grid) {
    return;
  }
  destroyAdsPanelLayout();
  grid.innerHTML = '';
  const ads = collectAdsInOrder();
  if (!ads.length) {
    if (emptyMessage) {
      emptyMessage.hidden = false;
      emptyMessage.setAttribute('aria-hidden', 'false');
    }
    return;
  }
  if (emptyMessage) {
    emptyMessage.hidden = true;
    emptyMessage.setAttribute('aria-hidden', 'true');
  }
  const fragment = document.createDocumentFragment();
  ads.forEach(item => {
    const card = createAdsPanelCard(item);
    if (card) {
      fragment.appendChild(card);
    }
  });
  grid.appendChild(fragment);
  refreshAdsPanelLayout();
}

function createAdsPanelCard({ id, ad, pageIndex }) {
  if (!id || !ad) {
    return null;
  }
  const card = document.createElement('article');
  card.className = 'ads-card';
  card.dataset.adId = id;
  card.dataset.pageIndex = String(pageIndex);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  const label = ad?.n ? String(ad.n) : getAdWindowTitle();
  card.setAttribute('aria-label', label);

  const header = document.createElement('header');
  header.className = 'ads-card__header';
  if (ad?.n) {
    const title = document.createElement('h3');
    title.className = 'ads-card__title';
    title.textContent = ad.n;
    header.appendChild(title);
  } else {
    header.classList.add('ads-card__header--fallback');
    const title = document.createElement('h3');
    title.className = 'ads-card__title';
    title.textContent = label;
    header.appendChild(title);
  }
  card.appendChild(header);

  const mediaFigure = document.createElement('figure');
  mediaFigure.className = 'ads-card__media';
  const image = createAdImageElement(id, ad, {
    loading: 'lazy',
    onLoad: () => requestAdsPanelLayout()
  });
  if (image) {
    mediaFigure.appendChild(image);
    card.appendChild(mediaFigure);
  } else {
    mediaFigure.remove();
    const fallback = document.createElement('p');
    fallback.className = 'ads-card__fallback';
    fallback.textContent = getAdActionLabel('imageUnavailable', AD_ACTION_FALLBACKS.imageUnavailable);
    card.appendChild(fallback);
  }

  const actions = createAdActionsContainer(id, ad);

  if (actions) {
    const overlay = document.createElement('div');
    overlay.className = 'ads-card__overlay';
    overlay.appendChild(actions);
    card.appendChild(overlay);
  }

  card.addEventListener('pointerenter', () => card.classList.add('is-active'));
  card.addEventListener('pointerleave', () => card.classList.remove('is-active'));
  card.addEventListener('focusin', () => card.classList.add('is-active'));
  card.addEventListener('focusout', event => {
    if (!card.contains(event.relatedTarget)) {
      card.classList.remove('is-active');
    }
  });

  card.addEventListener('click', event => {
    if (event.target.closest('.ad-actions') || event.target.closest('.ad-details__link')) {
      return;
    }
    openAdById(id);
  });
  card.addEventListener('keydown', event => {
    if (event.target !== card) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openAdById(id);
    }
  });

  return card;
}

function bindAudioElementEvents(audio) {
  if (!audio) {
    return;
  }
  audio.addEventListener('play', () => {
    state.audio.isPlaying = true;
    state.audio.isLoading = false;
    state.audio.error = null;
    updateAudioUI();
  });
  audio.addEventListener('pause', () => {
    state.audio.isPlaying = false;
    updateAudioUI();
    saveAudioProgressSnapshot();
  });
  audio.addEventListener('timeupdate', handleAudioTimeUpdate);
  audio.addEventListener('ended', handleAudioEnded);
  audio.addEventListener('waiting', () => {
    state.audio.isLoading = true;
    updateAudioUI();
  });
  audio.addEventListener('canplay', () => {
    state.audio.isLoading = false;
    updateAudioUI();
  });
  audio.addEventListener('loadedmetadata', handleAudioLoadedMetadata);
  audio.addEventListener('error', handleAudioError);
}

function handleAudioLoadedMetadata() {
  const audio = state.audio.audioElement;
  if (!audio) {
    return;
  }
  const seekTime = state.audio.pendingSeekTime;
  if (typeof seekTime === 'number' && Number.isFinite(seekTime)) {
    try {
      audio.currentTime = clamp(seekTime, 0, Math.max(audio.duration || 0, 0));
    } catch (error) {
      console.warn('Ääniraidan kohdan palauttaminen epäonnistui:', error);
    }
  }
  state.audio.pendingSeekTime = null;
  updateAudioUI();
}

function handleAudioTimeUpdate() {
  const audio = state.audio.audioElement;
  if (!audio) {
    return;
  }
  updateAudioUI();
  const now = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  if (!state.audio.isPlaying) {
    return;
  }
  if (Math.abs(now - state.audio.lastSavedTime) >= 5) {
    state.audio.lastSavedTime = now;
    saveAudioProgressSnapshot();
  }
}

function handleAudioEnded() {
  saveAudioProgressSnapshot();
  const nextIndex = state.audio.currentIndex + 1;
  if (nextIndex < state.audio.queue.length) {
    startAudioFromIndex(nextIndex);
    return;
  }
  clearAudioProgressForCurrentIssue();
  const audio = state.audio.audioElement;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  state.audio.currentIndex = -1;
  state.audio.isPlaying = false;
  state.audio.isLoading = false;
  state.audio.error = null;
  updateAudioUI();
}

function handleAudioError() {
  const audio = state.audio.audioElement;
  state.audio.error = audio?.error || new Error('Audio error');
  state.audio.isLoading = false;
  state.audio.isPlaying = false;
  updateAudioUI();
}

function showAudioPlayer() {
  state.audio.playerVisible = true;
  updateAudioUI();
}

function hideAudioPlayer() {
  state.audio.playerVisible = false;
  updateAudioUI();
}

function toggleAudioPlayback() {
  if (!state.audio.queue.length) {
    return;
  }
  if (state.audio.currentIndex === -1) {
    startAudioFromIndex(0);
    return;
  }
  if (state.audio.isPlaying) {
    pauseAudioPlayback();
  } else {
    playAudioPlayback();
  }
}

function playAudioPlayback() {
  const audio = state.audio.audioElement;
  if (!audio) {
    return;
  }
  const playPromise = audio.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(error => {
      state.audio.error = error;
      updateAudioUI();
    });
  }
}

function pauseAudioPlayback() {
  const audio = state.audio.audioElement;
  if (!audio) {
    return;
  }
  audio.pause();
}

function handleAudioAction() {
  if (!state.audio.queue.length) {
    state.audio.playerVisible = true;
    updateAudioUI();
    return;
  }
  showAudioPlayer();
  if (state.audio.currentIndex === -1 && state.audio.resume && !state.audio.resumePromptVisible) {
    showAudioResumePrompt();
    return;
  }
  toggleAudioPlayback();
}

function startAudioFromIndex(index, options = {}) {
  const queue = state.audio.queue;
  if (!queue.length) {
    return;
  }
  const targetIndex = clamp(index, 0, queue.length - 1);
  const entry = queue[targetIndex];
  const audio = state.audio.audioElement;
  if (!entry || !audio) {
    return;
  }
  state.audio.currentIndex = targetIndex;
  state.audio.isLoading = true;
  state.audio.error = null;
  state.audio.pendingSeekTime = typeof options.resumeTime === 'number' ? options.resumeTime : null;
  state.audio.lastSavedTime = 0;
  hideAudioResumePrompt();
  focusPageForArticle(entry.id, { keepReadingOpen: false });
  showAudioPlayer();
  try {
    audio.pause();
    audio.src = entry.src;
    audio.load();
  } catch (error) {
    state.audio.error = error;
    state.audio.isLoading = false;
  }
  updateAudioUI();
  playAudioPlayback();
}

function skipAudio(step) {
  if (!Number.isInteger(step) || !state.audio.queue.length) {
    return;
  }
  const nextIndex = state.audio.currentIndex + step;
  if (nextIndex < 0 || nextIndex >= state.audio.queue.length) {
    return;
  }
  startAudioFromIndex(nextIndex);
}

function seekAudioBy(seconds) {
  const audio = state.audio.audioElement;
  if (!audio || !Number.isFinite(seconds) || seconds === 0) {
    return;
  }
  const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const duration = Number.isFinite(audio.duration) ? audio.duration : null;
  let target = current + seconds;
  if (duration != null) {
    target = clamp(target, 0, duration);
  } else {
    target = Math.max(0, target);
  }
  if (Number.isFinite(target)) {
    audio.currentTime = target;
  }
}

function stopAudioPlayback(options = {}) {
  const { hidePlayer: hide = true } = options;
  const audio = state.audio.audioElement;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  state.audio.currentIndex = -1;
  state.audio.isPlaying = false;
  state.audio.isLoading = false;
  state.audio.error = null;
  state.audio.pendingSeekTime = null;
  hideAudioResumePrompt();
  if (hide) {
    hideAudioPlayer();
  } else {
    updateAudioUI();
  }
}

function showAudioResumePrompt() {
  if (!state.audio.resume) {
    return;
  }
  state.audio.resumePromptVisible = true;
  updateAudioUI();
  requestAnimationFrame(() => {
    state.dom.audioResumeContinue?.focus({ preventScroll: true });
  });
}

function hideAudioResumePrompt() {
  state.audio.resumePromptVisible = false;
  const resume = state.dom.audioResumeOverlay;
  if (resume) {
    resume.hidden = true;
    resume.setAttribute('aria-hidden', 'true');
    resume.classList.remove('is-visible');
  }
}

function handleAudioResumeContinue() {
  if (!state.audio.resume) {
    return;
  }
  const { index, time } = state.audio.resume;
  state.audio.resume = null;
  startAudioFromIndex(Number.isInteger(index) ? index : 0, { resumeTime: time || 0 });
}

function handleAudioResumeRestart() {
  clearAudioProgressForCurrentIssue();
  state.audio.resume = null;
  hideAudioResumePrompt();
  startAudioFromIndex(0);
}

function handleAudioTimelineClick(event) {
  const timeline = state.dom.audioTimeline;
  const audio = state.audio.audioElement;
  if (!timeline || !audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
    return;
  }
  const rect = timeline.getBoundingClientRect();
  const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  const clamped = clamp(ratio, 0, 1);
  audio.currentTime = clamped * audio.duration;
  updateAudioUI();
}

function handleAudioTimelineKeydown(event) {
  const audio = state.audio.audioElement;
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
    return;
  }
  let handled = false;
  let newTime = audio.currentTime || 0;
  switch (event.key) {
    case 'ArrowLeft':
      newTime -= 5;
      handled = true;
      break;
    case 'ArrowRight':
      newTime += 5;
      handled = true;
      break;
    case 'Home':
      newTime = 0;
      handled = true;
      break;
    case 'End':
      newTime = audio.duration;
      handled = true;
      break;
    default:
      break;
  }
  if (!handled) {
    return;
  }
  event.preventDefault();
  audio.currentTime = clamp(newTime, 0, audio.duration);
  updateAudioUI();
}

function updateAudioUI() {
  const {
    audioBackdrop,
    audioPlayer,
    audioTitle,
    audioPage,
    audioClose,
    audioPrev,
    audioPlay,
    audioNext,
    audioTimeCurrent,
    audioTimeTotal,
    audioTimeline,
    audioStatus,
    audioResumeOverlay,
    audioResumeMessage,
    audioResumeContinue,
    audioResumeRestart
  } = state.dom;
  const queue = state.audio.queue;
  const entry = getCurrentAudioEntry();
  const audio = state.audio.audioElement;

  const playerVisible = Boolean(state.audio.playerVisible);

  if (audioPlayer) {
    audioPlayer.classList.toggle('is-visible', playerVisible);
    audioPlayer.setAttribute('aria-hidden', playerVisible ? 'false' : 'true');
  }

  if (audioBackdrop) {
    audioBackdrop.hidden = !playerVisible;
    audioBackdrop.setAttribute('aria-hidden', playerVisible ? 'false' : 'true');
    audioBackdrop.classList.toggle('is-visible', playerVisible);
  }

  document.body.classList.toggle('audio-player-open', playerVisible);

  if (audioTitle) {
    const fallbackTitle = resolveLabel('audioPlayerTitle', 'Kuuntele lehti');
    audioTitle.textContent = entry?.title || fallbackTitle;
  }

  if (audioPage) {
    if (entry?.pageNumber) {
      audioPage.hidden = false;
      audioPage.textContent = `${resolveLabel('audioPageLabel', 'Sivu')} ${entry.pageNumber}`;
    } else {
      audioPage.textContent = '';
      audioPage.hidden = true;
    }
  }

  if (audioClose) {
    audioClose.setAttribute('aria-label', resolveLabel('audioCloseLabel', 'Sulje kuuntelu'));
  }

  if (audioPlay) {
    audioPlay.disabled = !queue.length || state.audio.resumePromptVisible;
    const playing = state.audio.isPlaying;
    audioPlay.innerHTML = playing
      ? '<span aria-hidden="true">❚❚</span>'
      : '<span aria-hidden="true">▶</span>';
    audioPlay.setAttribute('aria-label', playing
      ? resolveLabel('audioPauseLabel', 'Tauota')
      : resolveLabel('audioPlayLabel', 'Toista'));
  }

  if (audioPrev) {
    audioPrev.disabled = !(queue.length && state.audio.currentIndex > 0);
    audioPrev.setAttribute('aria-label', resolveLabel('audioPrevLabel', 'Edellinen juttu'));
  }

  if (audioNext) {
    audioNext.disabled = !(queue.length && state.audio.currentIndex >= 0 && state.audio.currentIndex < queue.length - 1);
    audioNext.setAttribute('aria-label', resolveLabel('audioNextLabel', 'Seuraava juttu'));
  }

  const currentTime = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const duration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;

  if (audioTimeCurrent) {
    audioTimeCurrent.textContent = formatTime(currentTime);
  }
  if (audioTimeTotal) {
    audioTimeTotal.textContent = formatTime(duration);
  }
  if (audioTimeline) {
    const progress = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;
    audioTimeline.style.setProperty('--progress', String(progress));
    audioTimeline.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    audioTimeline.setAttribute('aria-valuetext', `${formatTime(currentTime)} / ${formatTime(duration)}`);
    audioTimeline.setAttribute('aria-label', resolveLabel('audioTimelineLabel', 'Kuuntelun eteneminen'));
    audioTimeline.tabIndex = queue.length ? 0 : -1;
  }

  if (audioStatus) {
    let message = '';
    if (!queue.length) {
      message = resolveLabel('audioEmptyMessage', 'Tälle numerolle ei ole kuunneltavaa sisältöä.');
    } else if (state.audio.error) {
      message = resolveLabel('audioStatusError', 'Äänen toisto epäonnistui.');
    } else if (state.audio.isLoading) {
      message = resolveLabel('audioStatusLoading', 'Yhdistetään ääneen…');
    } else if (state.audio.isPlaying) {
      message = resolveLabel('audioStatusPlaying', 'Toistetaan.');
    } else if (state.audio.currentIndex >= 0) {
      message = resolveLabel('audioStatusPaused', 'Tauotettu.');
    } else {
      message = resolveLabel('audioStatusIdle', 'Valmis kuunneltavaksi.');
    }
    audioStatus.hidden = !message;
    audioStatus.textContent = message;
  }

  if (audioResumeOverlay && audioResumeMessage && audioResumeContinue && audioResumeRestart) {
    const showResume = Boolean(state.audio.resumePromptVisible && state.audio.resume);
    audioResumeOverlay.hidden = !showResume;
    audioResumeOverlay.setAttribute('aria-hidden', showResume ? 'false' : 'true');
    audioResumeOverlay.classList.toggle('is-visible', showResume);
    audioResumeContinue.textContent = resolveLabel('audioResumeContinue', 'Jatka kuuntelua');
    audioResumeRestart.textContent = resolveLabel('audioResumeRestart', 'Aloita alusta');
    if (showResume) {
      const resumeEntry = state.audio.resume?.index != null ? queue[state.audio.resume.index] : null;
      const resumeTitle = resumeEntry?.title || resolveLabel('audioResumeFallbackTitle', 'Viimeisin kuunneltu juttu');
      const template = resolveLabel('audioResumePrompt', 'Jatketaanko kohdasta "{title}" vai aloitetaan alusta?');
      audioResumeMessage.textContent = template.replace('{title}', resumeTitle);
    }
  }

  updateMobileMenuButtonVisibility();
}

function formatTime(seconds) {
  const totalSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = Math.max(totalSeconds - minutes * 60, 0);
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function getCurrentAudioEntry() {
  if (state.audio.currentIndex < 0) {
    return null;
  }
  return state.audio.queue[state.audio.currentIndex] || null;
}

function getAudioProgressStore() {
  try {
    const raw = window.localStorage?.getItem(AUDIO_PROGRESS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn('Kuuntelun etenemisen lukeminen epäonnistui:', error);
    return {};
  }
}

function setAudioProgressStore(store) {
  try {
    window.localStorage?.setItem(AUDIO_PROGRESS_STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    console.warn('Kuuntelun etenemisen tallentaminen epäonnistui:', error);
  }
}

function getCurrentIssueAudioKey() {
  const path = state.currentIssuePath ? normalizeArchivePath(state.currentIssuePath) : '';
  return path || 'latest';
}

function saveAudioProgressSnapshot() {
  const entry = getCurrentAudioEntry();
  const audio = state.audio.audioElement;
  if (!entry || !audio) {
    return;
  }
  const time = Number.isFinite(audio.currentTime) ? Math.max(0, Math.round(audio.currentTime)) : 0;
  const payload = {
    articleId: entry.id,
    time
  };
  const store = getAudioProgressStore();
  store[getCurrentIssueAudioKey()] = payload;
  setAudioProgressStore(store);
  state.audio.resume = {
    index: state.audio.currentIndex,
    articleId: entry.id,
    time
  };
}

function clearAudioProgressForCurrentIssue() {
  const store = getAudioProgressStore();
  const key = getCurrentIssueAudioKey();
  if (Object.prototype.hasOwnProperty.call(store, key)) {
    delete store[key];
    setAudioProgressStore(store);
  }
  state.audio.resume = null;
  state.audio.lastSavedTime = 0;
}

function loadAudioProgressForCurrentIssue() {
  const store = getAudioProgressStore();
  const key = getCurrentIssueAudioKey();
  const entry = store[key];
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const articleId = entry.articleId != null ? String(entry.articleId) : null;
  const time = Number.isFinite(entry.time) ? Math.max(0, Number(entry.time)) : 0;
  if (!articleId) {
    return null;
  }
  return { articleId, time };
}

function buildArticleAudioUrl(article) {
  if (!article || article.id == null || !article.hash) {
    return null;
  }
  const base = (state.config?.articleBaseUrl || articleBaseUrl || '').replace(/\/?$/, '/');
  const siteId = state.config?.id;
  if (!siteId) {
    return null;
  }
  return `${base}neodirect/${AUDIO_PRODUCT_ID}/${article.id}?hash=${article.hash}&site=${siteId}&role=1`;
}

function prepareAudioForIssue() {
  stopAudioPlayback();
  const order = Array.isArray(state.articleOrder) ? state.articleOrder : [];
  const queue = [];
  order.forEach(id => {
    const article = state.articleLookup.get(id);
    const src = buildArticleAudioUrl(article);
    if (!article || !src) {
      return;
    }
    const pageIndex = state.articlePageLookup.get(id);
    const pageNumber = Number.isFinite(article.p) ? Number(article.p) : (Number.isInteger(pageIndex) ? pageIndex + 1 : null);
    queue.push({
      id,
      title: article.hl || '',
      pageIndex: Number.isInteger(pageIndex) ? pageIndex : null,
      pageNumber,
      src
    });
  });
  state.audio.queue = queue;
  state.audio.currentIndex = -1;
  state.audio.isPlaying = false;
  state.audio.isLoading = false;
  state.audio.error = null;
  state.audio.pendingSeekTime = null;
  state.audio.resumePromptVisible = false;
  const saved = loadAudioProgressForCurrentIssue();
  if (saved) {
    const resumeIndex = queue.findIndex(item => item.id === saved.articleId);
    if (resumeIndex !== -1) {
      state.audio.resume = {
        index: resumeIndex,
        articleId: saved.articleId,
        time: saved.time
      };
    } else {
      state.audio.resume = null;
    }
  } else {
    state.audio.resume = null;
  }
  if (!queue.length) {
    clearAudioProgressForCurrentIssue();
    hideAudioPlayer();
  }
  updateAudioUI();
}

async function loadIssueData(config, issuePath) {
  const rootPath = `static/${config.id}`;
  let archiveData = Array.isArray(state.archiveItems) && state.archiveItems.length
    ? state.archiveItems
    : null;
  const rawIssueParam = issuePath ? String(issuePath).trim() : '';
  const normalizedTargetPath = rawIssueParam && rawIssueParam.includes('/')
    ? normalizeArchivePath(rawIssueParam)
    : null;
  const sanitizedTargetParam = sanitizeIssueParam(rawIssueParam);

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

  let selectedEntry = null;
  if (rawIssueParam) {
    selectedEntry = archiveData.find(entry => {
      const normalizedEntry = normalizeArchivePath(entry.p);
      if (normalizedTargetPath && normalizedEntry === normalizedTargetPath) {
        return true;
      }
      const sanitizedEntry = sanitizeIssueParam(normalizedEntry);
      return sanitizedEntry && sanitizedTargetParam && sanitizedEntry === sanitizedTargetParam;
    }) || null;
  }
  if (!selectedEntry) {
    selectedEntry = archiveData[0];
  }

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
    pageAds: issueData.pageAds || [],
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

  surface.style.setProperty('--page-count', String(pages.length));

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

    attachAdHotspots(wrapper, pageIndex);

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

  const articleClicksEnabled = areArticleClicksEnabled();

  pageMap.forEach(item => {
    if (item.t !== 0 || !item.c) {
      return;
    }
    const coords = parseMapCoordinates(item.c);
    if (!coords) {
      return;
    }

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const x = (coords.x1 * viewBox.width).toFixed(2);
    const y = (coords.y1 * viewBox.height).toFixed(2);
    const width = (coords.width * viewBox.width).toFixed(2);
    const height = (coords.height * viewBox.height).toFixed(2);

    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', width);
    rect.setAttribute('height', height);
    rect.setAttribute('class', 'maprect');

    if (articleClicksEnabled) {
      rect.setAttribute('role', 'button');
      rect.setAttribute('tabindex', '0');
    } else {
      rect.setAttribute('aria-hidden', 'true');
      rect.style.pointerEvents = 'none';
    }

    const article = state.articleLookup.get(String(item.id));
    if (article) {
      rect.dataset.url = article.url;
      rect.dataset.articleId = String(article.id);
      rect.setAttribute('aria-label', article.hl || 'Artikkeli');
    }

    if (articleClicksEnabled) {
      rect.addEventListener('click', handleRectClick);
      rect.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleRectClick(event);
        }
      });
    }

    svg.appendChild(rect);
  });

  return svg;
}

function attachAdHotspots(container, pageIndex) {
  const adsForPage = Array.isArray(state.pageAds?.[pageIndex]) ? state.pageAds[pageIndex] : [];
  const mapItems = Array.isArray(state.pageMaps?.[pageIndex]) ? state.pageMaps[pageIndex] : [];
  if (!adsForPage.length || !mapItems.length) {
    return;
  }

  const adLookup = new Map();
  adsForPage.forEach(ad => {
    if (!ad || ad.i == null) {
      return;
    }
    adLookup.set(String(ad.i), ad);
  });

  const hotspots = mapItems
    .filter(item => item && item.t === 1 && item.c && item.id != null)
    .map(item => {
      const ad = adLookup.get(String(item.id));
      return createAdHotspot(pageIndex, item, ad);
    })
    .filter(Boolean);

  if (!hotspots.length) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'page-ad-hotspots';
  hotspots.forEach(hotspot => overlay.appendChild(hotspot));
  container.appendChild(overlay);
}

function createAdHotspot(pageIndex, mapItem, ad) {
  if (!mapItem || !ad) {
    return null;
  }
  const coords = parseMapCoordinates(mapItem.c);
  if (!coords) {
    return null;
  }

  const adId = String(ad.i ?? mapItem.id);
  const hotspot = document.createElement('div');
  hotspot.className = 'ad-hotspot';
  hotspot.dataset.adId = adId;
  hotspot.dataset.pageIndex = String(pageIndex);
  hotspot.style.left = `${coords.x1 * 100}%`;
  hotspot.style.top = `${coords.y1 * 100}%`;
  hotspot.style.width = `${coords.width * 100}%`;
  hotspot.style.height = `${coords.height * 100}%`;

  const accessibleLabel = ad.n ? String(ad.n) : getAdActionLabel('hotspot', AD_ACTION_FALLBACKS.hotspot);
  hotspot.setAttribute('role', 'button');
  hotspot.setAttribute('tabindex', '0');
  hotspot.setAttribute('aria-label', accessibleLabel);

  const actions = createAdActionsContainer(adId, ad);
  if (actions) {
    hotspot.appendChild(actions);
  }

  hotspot.addEventListener('pointerenter', () => hotspot.classList.add('is-active'));
  hotspot.addEventListener('pointerleave', () => hotspot.classList.remove('is-active'));
  hotspot.addEventListener('focusin', () => hotspot.classList.add('is-active'));
  hotspot.addEventListener('focusout', event => {
    if (!hotspot.contains(event.relatedTarget)) {
      hotspot.classList.remove('is-active');
    }
  });
  hotspot.addEventListener('click', event => {
    if (event.target.closest('.ad-actions')) {
      return;
    }
    event.preventDefault();
    openAdById(adId);
  });
  hotspot.addEventListener('keydown', event => {
    if (event.target !== hotspot) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openAdById(adId);
    }
  });

  return hotspot;
}

function deactivateAllAdHotspots() {
  document.querySelectorAll('.ad-hotspot.is-active').forEach(element => {
    element.classList.remove('is-active');
  });
}

function updateAdHotspotLabels() {
  const hotspots = document.querySelectorAll('.ad-hotspot');
  hotspots.forEach(hotspot => {
    if (!(hotspot instanceof HTMLElement)) {
      return;
    }
    const adId = hotspot.dataset.adId;
    const ad = adId ? state.adLookup.get(adId) : null;
    const label = ad?.n ? String(ad.n) : getAdActionLabel('hotspot', AD_ACTION_FALLBACKS.hotspot);
    hotspot.setAttribute('aria-label', label);
    const actions = hotspot.querySelectorAll('.ad-action');
    actions.forEach(action => {
      const key = action instanceof HTMLElement ? action.dataset.actionKey : null;
      if (!key) {
        return;
      }
      const actionLabel = getAdActionLabel(key, AD_ACTION_FALLBACKS[key] || '');
      action.setAttribute('aria-label', actionLabel);
      action.title = actionLabel;
    });
  });

  const cards = document.querySelectorAll('.ads-card');
  cards.forEach(card => {
    if (!(card instanceof HTMLElement)) {
      return;
    }
    const adId = card.dataset.adId;
    const ad = adId ? state.adLookup.get(adId) : null;
    const label = ad?.n ? String(ad.n) : getAdWindowTitle();
    card.setAttribute('aria-label', label);
    const actions = card.querySelectorAll('.ad-action');
    actions.forEach(action => {
      const key = action instanceof HTMLElement ? action.dataset.actionKey : null;
      if (!key) {
        return;
      }
      const actionLabel = getAdActionLabel(key, AD_ACTION_FALLBACKS[key] || '');
      action.setAttribute('aria-label', actionLabel);
      action.title = actionLabel;
    });
    const navigationLink = card.querySelector('.ad-details__link--navigate');
    if (navigationLink instanceof HTMLElement) {
      navigationLink.textContent = getAdActionLabel('navigate', AD_ACTION_FALLBACKS.navigate);
      navigationLink.setAttribute('aria-label', getAdActionLabel('navigate', AD_ACTION_FALLBACKS.navigate));
    }
  });
}

function openAdById(adId) {
  if (!adId) {
    return;
  }
  const id = String(adId);
  const ad = state.adLookup.get(id);
  if (!ad) {
    console.warn('Mainosta ei löytynyt:', adId);
    return;
  }

  const readingWindow = state.dom.readingWindow;
  const content = state.dom.readingContent;
  if (!readingWindow || !content) {
    return;
  }

  deactivateAllAdHotspots();

  state.currentAdId = id;
  state.currentArticleId = null;

  const windowTitle = getAdWindowTitle();
  if (state.dom.readingLabel) {
    state.dom.readingLabel.textContent = windowTitle;
  }

  readingWindow.classList.add('reading-window--ad');
  openReadingWindow();
  state.dom.adsPanel?.classList.add('ads-panel--blurred');

  const heading = state.dom.readingTitle;
  if (heading) {
    if (ad.n) {
      heading.textContent = ad.n;
      heading.hidden = false;
      heading.setAttribute('aria-hidden', 'false');
    } else {
      heading.textContent = '';
      heading.hidden = true;
      heading.setAttribute('aria-hidden', 'true');
    }
  }

  content.innerHTML = '';

  const details = createAdDetailsSection(ad);
  if (details) {
    content.appendChild(details);
  }

  const image = createAdImageElement(id, ad);
  if (image) {
    const figure = document.createElement('figure');
    figure.className = 'ad-preview';
    figure.appendChild(image);
    content.appendChild(figure);
  } else {
    const message = document.createElement('p');
    message.textContent = getAdActionLabel('imageUnavailable', AD_ACTION_FALLBACKS.imageUnavailable);
    content.appendChild(message);
  }

  updateReadingNavigation();
}

function handleRectClick(event) {
  if (!areArticleClicksEnabled()) {
    return;
  }
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
  deactivateAllAdHotspots();
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
  applyZoom(surface || null);
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
  if (surface instanceof Element) {
    pendingZoomSurface = surface;
  }
  if (pendingZoomFrame !== null) {
    return;
  }
  pendingZoomFrame = requestAnimationFrame(() => {
    pendingZoomFrame = null;
    const target = pendingZoomSurface && pendingZoomSurface.isConnected
      ? pendingZoomSurface
      : getActiveSurface();
    pendingZoomSurface = null;
    const isZoomed = state.zoom.scale > 1;
    if (target) {
      target.style.transform = `translate(${state.zoom.translateX}px, ${state.zoom.translateY}px) scale(${state.zoom.scale})`;
      target.classList.toggle('is-zoomed', isZoomed);
    }
    document.body.classList.toggle('is-zoomed', isZoomed);
    const zoomMenu = document.querySelector('.zoom-menu');
    if (zoomMenu) {
      zoomMenu.classList.toggle('is-visible', isZoomed);
      zoomMenu.setAttribute('aria-hidden', isZoomed ? 'false' : 'true');
    }
    updateMobileMenuButtonVisibility();
    updateZoomUI();
    updateNavButtons();
  });
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

function beginSwipeTracking(event) {
  swipeState.pointerId = event.pointerId;
  swipeState.startX = event.clientX;
  swipeState.startY = event.clientY;
  swipeState.startTime = event.timeStamp || performance.now();
  swipeState.isTracking = true;
  swipeState.isSwipe = false;
}

function updatePointerTracker(event) {
  pointerTracker.set(event.pointerId, { x: event.clientX, y: event.clientY });
}

function removePointerFromTracker(event) {
  pointerTracker.delete(event.pointerId);
}

function getTrackedPointerEntries() {
  return Array.from(pointerTracker.entries()).slice(0, 2);
}

function beginPinch(surface) {
  const entries = getTrackedPointerEntries();
  if (entries.length < 2) {
    return;
  }
  const [firstEntry, secondEntry] = entries;
  const first = firstEntry[1];
  const second = secondEntry[1];
  const distance = Math.hypot(second.x - first.x, second.y - first.y);
  if (!(distance > 0)) {
    return;
  }
  const targetSurface = surface instanceof Element ? surface : getActiveSurface();
  pinchState.active = true;
  pinchState.surface = targetSurface;
  pinchState.initialDistance = distance;
  pinchState.initialScale = state.zoom.scale;
  panState.active = false;
  panState.pointerId = null;
  panState.surface = targetSurface || null;
  swipeState.isTracking = false;
  swipeState.pointerId = null;
  swipeState.isSwipe = false;
}

function applyPinchGesture() {
  if (!pinchState.active) {
    return;
  }
  const entries = getTrackedPointerEntries();
  if (entries.length < 2 || pinchState.initialDistance <= 0) {
    return;
  }
  const [firstEntry, secondEntry] = entries;
  const first = firstEntry[1];
  const second = secondEntry[1];
  const distance = Math.hypot(second.x - first.x, second.y - first.y);
  if (!(distance > 0)) {
    return;
  }
  const scaleFactor = distance / pinchState.initialDistance;
  const nextScale = pinchState.initialScale * scaleFactor;
  const center = {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2
  };
  setZoom(nextScale, center);
}

function endPinchGesture() {
  if (!pinchState.active) {
    return;
  }
  const surface = pinchState.surface || getActiveSurface();
  pinchState.active = false;
  pinchState.surface = null;
  pinchState.initialDistance = 0;
  pinchState.initialScale = state.zoom.scale;
  if (pointerTracker.size === 1 && surface && state.zoom.scale > 1) {
    const iterator = pointerTracker.entries().next();
    if (!iterator.done) {
      const [pointerId, point] = iterator.value;
      panState.active = true;
      panState.pointerId = pointerId;
      panState.startX = point.x;
      panState.startY = point.y;
      panState.baseX = state.zoom.translateX;
      panState.baseY = state.zoom.translateY;
      panState.surface = surface;
      return;
    }
  }
  panState.active = false;
  panState.pointerId = null;
  panState.surface = surface || null;
}

function startPan(event) {
  const surface = event.currentTarget;
  if (!(surface instanceof Element)) {
    return;
  }
  updatePointerTracker(event);
  const isTouch = event.pointerType === 'touch';

  if (isTouch && pointerTracker.size >= 2) {
    surface.setPointerCapture(event.pointerId);
    beginPinch(surface);
    return;
  }
  if (pinchState.active) {
    surface.setPointerCapture(event.pointerId);
    return;
  }
  if (state.zoom.scale === 1) {
    beginSwipeTracking(event);
    return;
  }
  surface.setPointerCapture(event.pointerId);
  swipeState.isTracking = false;
  swipeState.pointerId = null;
  swipeState.isSwipe = false;
  event.preventDefault();
  panState.active = true;
  panState.pointerId = event.pointerId;
  panState.startX = event.clientX;
  panState.startY = event.clientY;
  panState.baseX = state.zoom.translateX;
  panState.baseY = state.zoom.translateY;
  panState.surface = surface;
}

function handleStagePointerDown(event) {
  if (state.zoom.scale !== 1) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (target.closest('.ad-actions, .nav-button, .zoom-menu')) {
    return;
  }
  beginSwipeTracking(event);
}

function movePan(event) {
  if (pointerTracker.has(event.pointerId)) {
    updatePointerTracker(event);
  }
  if (pinchState.active) {
    if (pointerTracker.size >= 2) {
      event.preventDefault();
      applyPinchGesture();
      return;
    }
    endPinchGesture();
  }
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
  const surface = panState.surface || event.currentTarget;
  if (!(surface instanceof Element)) {
    return;
  }
  const dx = event.clientX - panState.startX;
  const dy = event.clientY - panState.startY;
  const constrained = constrainTranslation(surface, panState.baseX + dx, panState.baseY + dy, state.zoom.scale);
  state.zoom.translateX = constrained.x;
  state.zoom.translateY = constrained.y;
  applyZoom(surface);
}

function endPan(event) {
  if (pointerTracker.has(event.pointerId)) {
    removePointerFromTracker(event);
  }
  if (pinchState.active && pointerTracker.size < 2) {
    endPinchGesture();
  }
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
  const surface = panState.surface || event.currentTarget;
  if (surface instanceof Element && surface.hasPointerCapture?.(event.pointerId)) {
    surface.releasePointerCapture(event.pointerId);
  }
  panState.active = false;
  panState.pointerId = null;
  panState.surface = null;
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
    closeMobileMenu();
    resetZoom();
    closeArchivePanel();
    closeSettingsPanel();
    closeAdsPanel();
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    highlightAllPages();
    updateAllPagesSizing();
  } else {
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }
  updateMobileMenuButtonVisibility();
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
    button.dataset.pageCount = String(pages.length);
    if (pages.length > 1) {
      button.classList.add('all-pages__page--spread');
    }

    const preview = document.createElement('div');
    preview.className = 'all-pages__preview';
    preview.style.setProperty('--page-ratio', String(safeRatio));
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
  closeMobileMenu();
  readingWindow.classList.add('is-open');
  readingWindow.setAttribute('aria-hidden', 'false');
  document.body.classList.add('reading-open');
  if (readingBackdrop) {
    readingBackdrop.classList.add('is-visible');
    readingBackdrop.setAttribute('aria-hidden', 'false');
  }
  updateMobileMenuButtonVisibility();
}

function closeReadingWindow() {
  const { readingWindow, readingBackdrop } = state.dom;
  if (!readingWindow) {
    return;
  }
  readingWindow.classList.remove('is-open');
  readingWindow.setAttribute('aria-hidden', 'true');
  readingWindow.classList.remove('reading-window--ad');
  state.dom.adsPanel?.classList.remove('ads-panel--blurred');
  document.body.classList.remove('reading-open');
  if (readingBackdrop) {
    readingBackdrop.classList.remove('is-visible');
    readingBackdrop.setAttribute('aria-hidden', 'true');
  }
  state.currentArticleId = null;
  state.currentAdId = null;
  deactivateAllAdHotspots();
  updateReadingNavigation();
  if (state.dom.readingTitle) {
    state.dom.readingTitle.textContent = '';
    state.dom.readingTitle.hidden = true;
    state.dom.readingTitle.setAttribute('aria-hidden', 'true');
  }
  updateMobileMenuButtonVisibility();
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

'use strict';

const maxScale = 4;
const minScale = 1;
const scaleStep = 0.5;
const articleBaseUrl = 'https://sandbox-devtest2.anygraaf.net/';

const state = {
  config: null,
  imagePaths: [],
  pageMaps: [],
  pageArticles: [],
  articleLookup: new Map(),
  archiveItems: [],
  currentIssuePath: null,
  slideDefinitions: [],
  slides: [],
  currentSlide: 0,
  activePageIndex: 0,
  orientation: null,
  isCompact: false,
  viewBox: null,
  zoom: {
    scale: 1,
    translateX: 0,
    translateY: 0
  },
  resizeTimer: null,
  listenersAttached: false
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

document.addEventListener('DOMContentLoaded', init);

async function init() {
  state.config = window.epaperConfig;
  if (!state.config) {
    console.error('epaperConfig puuttuu.');
    return;
  }

  document.body.classList.add('menu-collapsed');
  buildNavigation();
  attachGlobalListeners();
  updateFullscreenUI();

  try {
    const issue = await loadIssueData(state.config);
    applyIssue(issue);
  } catch (error) {
    console.error('Näköislehden lataaminen epäonnistui:', error);
  } finally {
    requestAnimationFrame(() => document.body.classList.add('menu-animated'));
  }
}

function applyIssue(issue) {
  if (!issue) {
    return;
  }

  state.imagePaths = Array.isArray(issue.imagePaths) ? issue.imagePaths : [];
  state.pageMaps = Array.isArray(issue.pageMaps) ? issue.pageMaps : [];
  state.pageArticles = Array.isArray(issue.pageArticles) ? issue.pageArticles : [];
  state.articleLookup = new Map(state.pageArticles.map(article => [String(article.id), article]));
  state.viewBox = computeViewBox(issue.res);
  if (Array.isArray(issue.archiveItems) && issue.archiveItems.length) {
    state.archiveItems = issue.archiveItems;
  }
  if (issue.path) {
    state.currentIssuePath = issue.path;
  }

  toggleAllPages(false);
  closeArchivePanel();
  closeReadingWindow();
  buildAllPagesGrid();
  renderSlides();
  updateNavButtons();
  buildArchiveList();
  updateAllPagesSizing();
}

function buildNavigation() {
  const container = document.querySelector('.menu-content');
  if (!container) {
    return;
  }

  container.innerHTML = '';

  const navigationItems = state.config && Array.isArray(state.config.navigation)
    ? state.config.navigation
    : [];
  navigationItems.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('menu-item');
    if (item.className) {
      button.classList.add(item.className);
    }
    if (item.action) {
      button.dataset.action = item.action;
    }
    if (item.label) {
      button.title = item.label;
    }

    if (item.icon && item.icon.path) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('viewBox', (item.icon && item.icon.viewBox) || '0 0 24 24');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', item.icon.path);
      svg.appendChild(path);
      button.appendChild(svg);
    }

    if (item.label) {
      const label = document.createElement('span');
      label.textContent = item.label;
      button.appendChild(label);
    }

    container.appendChild(button);
  });
}

function attachGlobalListeners() {
  if (state.listenersAttached) {
    return;
  }
  state.listenersAttached = true;

  const prevButton = document.querySelector('.nav-prev');
  const nextButton = document.querySelector('.nav-next');
  prevButton?.addEventListener('click', () => gotoSlide(state.currentSlide - 1));
  nextButton?.addEventListener('click', () => gotoSlide(state.currentSlide + 1));

  document.querySelector('.zoom-in')?.addEventListener('click', () => adjustZoom(1));
  document.querySelector('.zoom-out')?.addEventListener('click', () => adjustZoom(-1));
  document.querySelector('.zoom-reset')?.addEventListener('click', resetZoom);

  document.querySelector('[data-action="toggle-menu"]')?.addEventListener('click', toggleMenuCollapsed);

  const fullscreenButton = document.querySelector('[data-action="fullscreen"]');
  const exitFullscreenButton = document.querySelector('[data-action="exit-fullscreen"]');
  fullscreenButton?.addEventListener('click', enterFullscreen);
  exitFullscreenButton?.addEventListener('click', exitFullscreenMode);
  document.addEventListener('fullscreenchange', updateFullscreenUI);

  const archiveButton = document.querySelector('[data-action="archive"]');
  const archivePanel = document.querySelector('.archive-panel');
  const archiveClose = document.querySelector('.archive-panel__close');
  archiveButton?.addEventListener('click', openArchivePanel);
  archiveClose?.addEventListener('click', closeArchivePanel);
  archivePanel?.addEventListener('click', event => {
    if (event.target === archivePanel) {
      closeArchivePanel();
    }
  });

  const allPagesItem = document.querySelector('[data-action="toggle-all-pages"]');
  const allPages = document.querySelector('.all-pages');
  const allPagesClose = document.querySelector('.all-pages__close');
  allPagesItem?.addEventListener('click', () => toggleAllPages(true));
  allPagesClose?.addEventListener('click', () => toggleAllPages(false));
  allPages?.addEventListener('click', event => {
    if (event.target === allPages) {
      toggleAllPages(false);
    }
  });

  const readingClose = document.querySelector('.close-article');
  readingClose?.addEventListener('click', closeReadingWindow);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (document.body.classList.contains('is-zoomed')) {
        resetZoom();
        return;
      }
      if (document.querySelector('.all-pages')?.classList.contains('is-open')) {
        toggleAllPages(false);
        return;
      }
      if (document.querySelector('.archive-panel')?.classList.contains('is-open')) {
        closeArchivePanel();
        return;
      }
      if (document.querySelector('.reading-window')?.classList.contains('is-open')) {
        closeReadingWindow();
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
  });

  window.addEventListener('resize', handleResize);
}

function toggleMenuCollapsed() {
  document.body.classList.toggle('menu-collapsed');
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
  const fullscreenButton = document.querySelector('[data-action="fullscreen"]');
  const exitFullscreenButton = document.querySelector('[data-action="exit-fullscreen"]');
  const isFullscreen = Boolean(document.fullscreenElement);
  document.body.classList.toggle('is-fullscreen', isFullscreen);
  if (fullscreenButton) {
    fullscreenButton.hidden = isFullscreen;
    fullscreenButton.setAttribute('aria-hidden', isFullscreen ? 'true' : 'false');
  }
  if (exitFullscreenButton) {
    exitFullscreenButton.hidden = !isFullscreen;
    exitFullscreenButton.setAttribute('aria-hidden', !isFullscreen ? 'true' : 'false');
  }
}

function openArchivePanel() {
  const panel = document.querySelector('.archive-panel');
  if (!panel) {
    return;
  }
  toggleAllPages(false);
  closeReadingWindow();
  buildArchiveList();
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
}

function closeArchivePanel() {
  const panel = document.querySelector('.archive-panel');
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

  const selectedEntry = issuePath
    ? archiveData.find(entry => entry.p === issuePath)
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
    path: selectedEntry.p,
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
  const url = target.dataset.url;
  if (url) {
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
  const { preserveZoom = false } = options;
  if (state.currentSlide != null && state.slides[state.currentSlide]) {
    state.slides[state.currentSlide].element.classList.remove('is-active');
  }

  state.currentSlide = index;
  const current = state.slides[index];
  if (!current) {
    return;
  }
  current.element.classList.add('is-active');
  state.activePageIndex = current.pages[0];
  closeReadingWindow();

  if (!preserveZoom) {
    resetZoom();
  }

  highlightAllPages();
  updateNavButtons();
}

function highlightAllPages() {
  if (!state.slideDefinitions.length) {
    return;
  }
  const buttons = document.querySelectorAll('.all-pages__page');
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
  const prevButton = document.querySelector('.nav-prev');
  const nextButton = document.querySelector('.nav-next');
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
  const overlay = document.querySelector('.all-pages');
  if (!overlay) {
    return;
  }
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !overlay.classList.contains('is-open');
  if (shouldOpen) {
    resetZoom();
    closeArchivePanel();
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
  const grid = document.querySelector('.all-pages__grid');
  if (!grid) {
    return;
  }
  grid.innerHTML = '';
  const spreads = buildSpreadDefinitions();
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
    pages.forEach(pageIndex => {
      const img = document.createElement('img');
      img.src = state.imagePaths[pageIndex];
      img.alt = `Sivu ${pageIndex + 1}`;
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
  const list = document.querySelector('.archive-panel__list');
  if (!list) {
    return;
  }
  list.innerHTML = '';
  if (!Array.isArray(state.archiveItems) || state.archiveItems.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'archive-panel__empty';
    empty.textContent = 'Arkistossa ei ole numeroita.';
    list.appendChild(empty);
    return;
  }

  const currentPath = state.currentIssuePath;
  state.archiveItems.forEach(entry => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'archive-panel__item';
    button.dataset.path = entry.p;
    if (entry.p === currentPath) {
      button.classList.add('is-active');
    }

    const label = document.createElement('span');
    label.textContent = entry.d || entry.p;
    button.appendChild(label);

    if (entry.p) {
      const meta = document.createElement('small');
      meta.textContent = entry.p.replace(/\/$/, '');
      button.appendChild(meta);
    }

    button.addEventListener('click', () => handleArchiveSelection(entry.p));
    item.appendChild(button);
    list.appendChild(item);
  });
}

function handleArchiveSelection(path) {
  if (!path) {
    return;
  }
  closeArchivePanel();
  if (path === state.currentIssuePath) {
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
  const grid = document.querySelector('.all-pages__grid');
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
    const pageCount = Number.parseInt(button.dataset.pageCount || '1', 10) || 1;
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
  const readingWindow = document.querySelector('.reading-window');
  const content = document.querySelector('#article-content');
  if (!readingWindow || !content) {
    return;
  }

  readingWindow.classList.add('is-open');
  readingWindow.setAttribute('aria-hidden', 'false');
  readingWindow.scrollTop = 0;
  content.innerHTML = '<p>Ladataan sisältöä…</p>';

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
    content.innerHTML = '<p>Artikkelin lataaminen epäonnistui.</p>';
  }
}

function closeReadingWindow() {
  const readingWindow = document.querySelector('.reading-window');
  if (!readingWindow) {
    return;
  }
  readingWindow.classList.remove('is-open');
  readingWindow.setAttribute('aria-hidden', 'true');
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

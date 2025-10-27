'use strict';

const maxScale = 4;
const minScale = 1;
const scaleStep = 0.5;

const state = {
  config: null,
  imagePaths: [],
  pageMaps: [],
  pageArticles: [],
  articleLookup: new Map(),
  slideDefinitions: [],
  slides: [],
  currentSlide: 0,
  activePageIndex: 0,
  orientation: null,
  viewBox: null,
  zoom: {
    scale: 1,
    translateX: 0,
    translateY: 0
  },
  resizeTimer: null
};

const panState = {
  active: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  baseX: 0,
  baseY: 0
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  state.config = window.epaperConfig;
  if (!state.config) {
    console.error('epaperConfig puuttuu.');
    return;
  }

  buildNavigation();

  try {
    const issue = await loadLatestIssuePages(state.config);
    state.imagePaths = issue.imagePaths;
    state.pageMaps = issue.pageMaps;
    state.pageArticles = issue.pageArticles;
    state.articleLookup = new Map(issue.pageArticles.map(article => [String(article.id), article]));
    state.viewBox = computeViewBox(issue.res);
    buildAllPagesGrid();
    renderSlides();
    attachGlobalListeners();
    updateNavButtons();
  } catch (error) {
    console.error('Näköislehden lataaminen epäonnistui:', error);
  }
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
      const label = document.createElement('span');
      label.textContent = item.label;
      button.appendChild(label);
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

    container.appendChild(button);
  });
}

function attachGlobalListeners() {
  const prevButton = document.querySelector('.nav-prev');
  const nextButton = document.querySelector('.nav-next');
  prevButton?.addEventListener('click', () => gotoSlide(state.currentSlide - 1));
  nextButton?.addEventListener('click', () => gotoSlide(state.currentSlide + 1));

  document.querySelector('.zoom-in')?.addEventListener('click', () => adjustZoom(1));
  document.querySelector('.zoom-out')?.addEventListener('click', () => adjustZoom(-1));
  document.querySelector('.zoom-reset')?.addEventListener('click', resetZoom);

  document.querySelector('[data-action="toggle-menu"]')?.addEventListener('click', () => {
    document.body.classList.toggle('menu-collapsed');
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

function handleResize() {
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    const newOrientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
    if (newOrientation !== state.orientation) {
      renderSlides();
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
  }, 180);
}

async function loadLatestIssuePages(config) {
  const rootPath = `static/${config.id}`;
  const archiveUrl = `${rootPath}/${config.paper}_arch.htm`;
  const archiveResponse = await fetch(archiveUrl);
  if (!archiveResponse.ok) {
    throw new Error(`Arkistotiedoston lataus epäonnistui: ${archiveResponse.status}`);
  }
  const archiveData = await archiveResponse.json();
  if (!Array.isArray(archiveData) || archiveData.length === 0) {
    throw new Error('Arkistodata on tyhjä.');
  }

  const latestPath = archiveData[0].p;
  const issueUrl = `${rootPath}/${latestPath}${config.paper}_cont.htm`;
  const issueResponse = await fetch(issueUrl);
  if (!issueResponse.ok) {
    throw new Error(`Lehden datan lataus epäonnistui: ${issueResponse.status}`);
  }
  const issueData = await issueResponse.json();
  if (!issueData.pages) {
    throw new Error('Lehden sivumäärää ei löytynyt.');
  }

  const imagePaths = Array.from({ length: issueData.pages }, (_, index) => `${rootPath}/${latestPath}p${index + 1}.webp`);

  return {
    imagePaths,
    pageMaps: issueData.pageMaps || [],
    pageArticles: issueData.pageArticles || [],
    res: issueData.res
  };
}

function renderSlides() {
  if (!Array.isArray(state.imagePaths) || state.imagePaths.length === 0) {
    console.warn('Ei sivuja näytettäväksi.');
    return;
  }

  const orientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
  state.orientation = orientation;

  const definitions = buildSlideDefinitions(orientation);
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

function buildSlideDefinitions(orientation) {
  if (orientation === 'portrait') {
    return state.imagePaths.map((_, index) => [index]);
  }

  const slides = [];
  for (let index = 0; index < state.imagePaths.length; index += 1) {
    if (index === 0 || index === state.imagePaths.length - 1) {
      slides.push([index]);
    } else {
      slides.push([index, index + 1]);
      index += 1;
    }
  }
  return slides;
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
    const pageIndex = Number(button.dataset.pageIndex);
    const isActive = state.slideDefinitions[state.currentSlide]?.includes(pageIndex);
    button.classList.toggle('is-active', Boolean(isActive));
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
    return;
  }
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
  if (!panState.active || event.pointerId !== panState.pointerId) {
    return;
  }
  const surface = event.currentTarget;
  surface.releasePointerCapture(event.pointerId);
  panState.active = false;
  panState.pointerId = null;
}

function toggleAllPages(forceOpen) {
  const overlay = document.querySelector('.all-pages');
  if (!overlay) {
    return;
  }
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !overlay.classList.contains('is-open');
  if (shouldOpen) {
    resetZoom();
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    highlightAllPages();
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
  state.imagePaths.forEach((src, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'all-pages__page';
    button.dataset.pageIndex = String(index);

    const img = document.createElement('img');
    img.src = src;
    img.alt = `Sivu ${index + 1}`;
    button.appendChild(img);

    const label = document.createElement('span');
    label.textContent = String(index + 1);
    button.appendChild(label);

    button.addEventListener('click', () => {
      const slideIndex = state.slideDefinitions.findIndex(def => def.includes(index));
      toggleAllPages(false);
      if (slideIndex !== -1) {
        updateActiveSlide(slideIndex);
      }
    });

    grid.appendChild(button);
  });
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
    const response = await fetch(url);
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
      if (!src || !src.trim()) {
        const dataSrc = image.getAttribute('data-aghref');
        if (dataSrc) {
          image.src = dataSrc;
        }
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

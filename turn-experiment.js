(function () {
  'use strict';

  const state = {
    pageCount: 0,
    pageWidth: 860,
    pageHeight: 1140,
    issueLabel: '',
    basePath: '',
    issuePath: ''
  };

  const selectors = {
    viewer: '.turn-viewer',
    status: '[data-status]',
    indicator: '[data-indicator]',
    wrapper: '.turn-wrapper',
    flipbook: '#flipbook',
    controls: '.turn-controls'
  };

  function getElement(selector) {
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error(`Elementtiä ei löytynyt valitsimella ${selector}`);
    }
    return element;
  }

  function updateStatus(message, { isError = false, tone = 'info' } = {}) {
    const status = document.querySelector(selectors.status);
    if (!status) {
      return;
    }
    status.textContent = message;
    status.dataset.state = isError ? 'error' : tone;
  }

  function revealViewer() {
    const viewer = document.querySelector(selectors.viewer);
    if (viewer) {
      viewer.hidden = false;
    }
    const controls = document.querySelector(selectors.controls);
    if (controls) {
      controls.setAttribute('aria-hidden', 'false');
    }
  }

  function updateIndicator(page) {
    const indicator = document.querySelector(selectors.indicator);
    if (!indicator) {
      return;
    }
    const total = state.pageCount || 0;
    const current = Math.min(Math.max(1, page || 1), total || 1);
    indicator.textContent = `Sivu ${current} / ${total}`;
  }

  function computeScale() {
    const width = state.pageWidth;
    const height = state.pageHeight;
    if (!width || !height) {
      return 1;
    }
    const maxWidth = window.innerWidth * 0.85;
    const maxHeight = window.innerHeight * 0.8;
    const scale = Math.min(maxWidth / width, maxHeight / height, 1);
    return scale > 0 ? scale : 1;
  }

  function applyScale() {
    const wrapper = document.querySelector(selectors.wrapper);
    if (!wrapper) {
      return;
    }
    const scale = computeScale();
    wrapper.style.transform = `scale(${scale})`;
  }

  function setPageDimensions(width, height) {
    state.pageWidth = width || state.pageWidth;
    state.pageHeight = height || state.pageHeight;
    document.documentElement.style.setProperty('--page-width', `${state.pageWidth}px`);
    document.documentElement.style.setProperty('--page-height', `${state.pageHeight}px`);
    applyScale();
  }

  function bindControls($flipbook) {
    const prevButton = document.querySelector('[data-action="prev"]');
    const nextButton = document.querySelector('[data-action="next"]');
    if (prevButton) {
      prevButton.addEventListener('click', () => {
        $flipbook.turn('previous');
      });
    }
    if (nextButton) {
      nextButton.addEventListener('click', () => {
        $flipbook.turn('next');
      });
    }
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        $flipbook.turn('previous');
      } else if (event.key === 'ArrowRight') {
        $flipbook.turn('next');
      }
    });
  }

  async function loadIssueData(config) {
    if (!config || !config.id || !config.paper) {
      throw new Error('Konfiguraatiosta puuttuu lehden tunniste.');
    }
    const basePath = `static/${config.id}/${config.paper}`;
    const archiveUrl = `${basePath}/${config.paper}_arch.htm`;
    const archiveResponse = await fetch(archiveUrl);
    if (!archiveResponse.ok) {
      throw new Error(`Arkistotietojen haku epäonnistui (${archiveResponse.status}).`);
    }
    const archive = await archiveResponse.json();
    if (!Array.isArray(archive) || !archive.length) {
      throw new Error('Arkisto on tyhjä.');
    }
    const latest = archive[0];
    if (!latest || !latest.p) {
      throw new Error('Arkistosta puuttuu polku uusimpaan lehteen.');
    }
    const issuePath = String(latest.p);
    const issueUrl = `${basePath}/${issuePath}${config.paper}_cont.htm`;
    const issueResponse = await fetch(issueUrl);
    if (!issueResponse.ok) {
      throw new Error(`Lehden metatietojen haku epäonnistui (${issueResponse.status}).`);
    }
    const issueData = await issueResponse.json();
    if (!issueData || !Number.isFinite(issueData.pages)) {
      throw new Error('Lehden sivumäärää ei voitu lukea.');
    }
    return {
      basePath,
      issuePath,
      issueLabel: latest.d || '',
      pages: issueData.pages,
      resolution: issueData.res || {}
    };
  }

  async function loadPages(config) {
    const { basePath, issuePath, issueLabel, pages, resolution } = await loadIssueData(config);
    state.pageCount = pages;
    state.basePath = basePath;
    state.issuePath = issuePath;
    state.issueLabel = issueLabel;
    if (resolution && Number.isFinite(resolution.pagew) && Number.isFinite(resolution.pageh)) {
      setPageDimensions(resolution.pagew, resolution.pageh);
    }
    const flipbook = getElement(selectors.flipbook);
    flipbook.innerHTML = '';
    const fragments = document.createDocumentFragment();
    const loadPromises = [];
    for (let index = 1; index <= pages; index += 1) {
      const page = document.createElement('div');
      page.className = 'page';
      const image = new Image();
      const src = `${basePath}/${issuePath}p${index}.webp`;
      image.alt = `Sivu ${index}`;
      image.loading = 'lazy';
      image.src = src;
      page.appendChild(image);
      fragments.appendChild(page);
      loadPromises.push(new Promise((resolve, reject) => {
        image.addEventListener('load', () => resolve({ width: image.naturalWidth, height: image.naturalHeight }), { once: true });
        image.addEventListener('error', () => reject(new Error(`Sivun ${index} kuvaa ei voitu ladata (${src}).`)), { once: true });
      }));
    }
    flipbook.appendChild(fragments);
    await Promise.all(loadPromises);
    return flipbook;
  }

  function initializeTurn($flipbook) {
    $flipbook.turn({
      autoCenter: true,
      gradients: true,
      elevation: 60,
      height: state.pageHeight,
      width: state.pageWidth
    });
    updateIndicator($flipbook.turn('page'));
    $flipbook.on('turning', (_, page) => {
      updateIndicator(page);
    });
    bindControls($flipbook);
    window.addEventListener('resize', () => {
      applyScale();
    });
    applyScale();
  }

  async function init() {
    try {
      const config = window.epaperConfig;
      if (!config) {
        throw new Error('Sovelluksen konfiguraatiota ei löytynyt.');
      }
      updateStatus('Ladataan flipbook-näkymää…');
      const flipbookElement = await loadPages(config);
      const $flipbook = window.jQuery(flipbookElement);
      initializeTurn($flipbook);
      revealViewer();
      if (state.issueLabel) {
        updateStatus(`Näytetään numero: ${state.issueLabel}`, { tone: 'success' });
      } else {
        updateStatus('Flipbook-näkymä ladattu.', { tone: 'success' });
      }
    } catch (error) {
      console.error(error);
      updateStatus(error.message || 'Flipbookin avaaminen epäonnistui.', { isError: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

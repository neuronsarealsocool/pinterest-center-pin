// ==UserScript==
// @name         Pinterest - Center Open Pin
// @namespace    local.pinterest.center-pin
// @version      2.6.0
// @description  Center the open Pin and its details in the browser window on desktop.
// @match        https://*.pinterest.com/*
// @match        https://*.pinterest.com.au/*
// @match        https://*.pinterest.co.uk/*
// @match        https://*.pinterest.ca/*
// @match        https://*.pinterest.nz/*
// @match        https://*.pinterest.de/*
// @match        https://*.pinterest.fr/*
// @match        https://*.pinterest.it/*
// @match        https://*.pinterest.es/*
// @match        https://*.pinterest.pt/*
// @match        https://*.pinterest.jp/*
// @match        https://*.pinterest.co.kr/*
// @match        https://*.pinterest.com.mx/*
// @match        https://*.pinterest.at/*
// @match        https://*.pinterest.ch/*
// @match        https://*.pinterest.se/*
// @match        https://*.pinterest.dk/*
// @match        https://*.pinterest.nl/*
// @match        https://*.pinterest.ie/*
// @match        https://*.pinterest.cl/*
// @match        https://*.pinterest.ph/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const GAP = 16;
  const MAX_WIDTH = 1100;
  const MIN_DESKTOP_WIDTH = 768;
  const TARGET = 'data-tm-centered-pin';
  const ANCESTOR = 'data-tm-centered-pin-ancestor';
  const SELECTORS = [
    '[data-test-id="closeup-container"]',
    '[data-test-id="closeup-body"]',
  ];
  let enabled = GM_getValue('centerOpenPin', true);
  let active = null;
  let naturalWidth = 0;
  let ancestors = [];
  let pending = 0;
  let lastPath = location.pathname;
  let sidePanels = [];
  let sideSignature = '';
  let savedPins = new Map();
  let scannedPath = '';
  const shiftedPins = new Set();
  const configuredVideos = new WeakMap();
  let closeButton = null;
  let closedPin = null;
  let closedPath = '';

  const style = document.createElement('style');
  style.textContent = `
    /* Masonry items can establish a containing block for fixed children.
       Only the open Pin's ancestor chain is released, while it is open. */
    [${ANCESTOR}] {
      transform: none !important;
      translate: none !important;
      rotate: none !important;
      scale: none !important;
      perspective: none !important;
      filter: none !important;
      backdrop-filter: none !important;
      contain: none !important;
      container-type: normal !important;
      content-visibility: visible !important;
      will-change: auto !important;
      overflow: visible !important;
      clip-path: none !important;
    }
    [${TARGET}] {
      position: fixed !important;
      inset: auto !important;
      left: var(--tm-pin-center-x) !important;
      top: var(--tm-pin-center-y) !important;
      transform: none !important;
      translate: -50% -50% !important;
      rotate: none !important;
      scale: none !important;
      margin: 0 !important;
      box-sizing: border-box !important;
      width: var(--tm-pin-width) !important;
      min-width: 0 !important;
      max-width: calc(100vw - ${GAP * 2}px) !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: var(--tm-pin-max-height) !important;
      overflow: auto !important;
      overscroll-behavior: contain;
      z-index: 1 !important;
    }
    .tm-pin-side {
      position: fixed !important;
      top: var(--tm-side-top) !important;
      bottom: 16px !important;
      width: var(--tm-side-width) !important;
      overflow-y: auto !important;
      z-index: 0 !important;
      scrollbar-width: thin;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(115px, 1fr));
      column-gap: 8px;
      align-content: start;
    }
    .tm-pin-side-left { left: 80px !important; }
    .tm-pin-side-right { right: 8px !important; }
    .tm-pin-side a { display: inline-block; width: 100%; margin-bottom: 8px; break-inside: avoid; }
    .tm-pin-side img { display: block; width: 100%; max-height: 260px; object-fit: cover; height: auto; border-radius: 12px; }
    [data-tm-shifted-pin] { translate: var(--tm-shift-x) 0 !important; }
    [data-tm-pin-dismissed] { visibility: hidden !important; pointer-events: none !important; }
    .tm-pin-close {
      position: fixed; z-index: 100; width: 36px; height: 36px;
      border: 0; border-radius: 50%; background: #fff; color: #111;
      box-shadow: 0 1px 6px #0005; font: 24px/36px Arial, sans-serif;
      cursor: pointer; text-align: center; padding: 0;
    }
    .tm-pin-close:focus-visible { outline: 3px solid #0074e8; outline-offset: 2px; }
  `;
  (document.head || document.documentElement).append(style);

  function clear() {
    if (closeButton) closeButton.remove();
    closeButton = null;
    for (const item of shiftedPins) {
      item.removeAttribute('data-tm-shifted-pin');
      item.style.removeProperty('--tm-shift-x');
    }
    shiftedPins.clear();
    for (const panel of sidePanels) panel.remove();
    sidePanels = [];
    sideSignature = '';
    savedPins.clear();
    if (active) {
      active.removeAttribute(TARGET);
      for (const property of ['--tm-pin-width', '--tm-pin-center-x', '--tm-pin-center-y', '--tm-pin-max-height']) {
        active.style.removeProperty(property);
      }
      resizeObserver.unobserve(active);
    }
    for (const ancestor of ancestors) ancestor.removeAttribute(ANCESTOR);
    ancestors = [];
    active = null;
  }

  function findPin() {
    const body = document.querySelector('[data-test-id="closeup-body"]');
    const item = body && body.closest('[role="listitem"]');
    if (item && item.getBoundingClientRect().width > 0) return item;
    // Prefer the full card over its nested body; never target feed thumbnails.
    for (const selector of SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 &&
            !element.closest('[aria-hidden="true"], [hidden]') &&
            getComputedStyle(element).visibility !== 'hidden') return element;
      }
    }
    return null;
  }

  function setVariable(name, value) {
    if (active.style.getPropertyValue(name) !== value) active.style.setProperty(name, value);
  }

  function configureOpenVideo() {
    if (!active) return;
    const video = Array.from(active.querySelectorAll('video')).find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !element.closest('[aria-hidden="true"], [hidden]');
    });
    if (!video) return;
    const pinPath = location.pathname;
    const unmute = () => {
      if (active && active.contains(video) && location.pathname === pinPath) {
        video.loop = true;
        if (video.muted) video.muted = false;
        if (video.volume === 0) video.volume = 1;
      }
    };
    if (configuredVideos.get(video) === pinPath) return;
    configuredVideos.set(video, pinPath);
    video.autoplay = true;
    video.loop = true;
    video.defaultMuted = false;
    unmute();
    video.addEventListener('play', unmute);
    video.addEventListener('volumechange', unmute);
    // Pinterest can attach the source and pause its player after the first
    // play attempt. Retry during startup as the media becomes playable.
    let tries = 0;
    let playingChecks = 0;
    const timer = window.setInterval(() => {
      if (!active || !active.contains(video) || location.pathname !== pinPath || tries++ >= 20) {
        window.clearInterval(timer);
        return;
      }
      unmute();
      if (video.paused || video.ended) {
        playingChecks = 0;
        video.play().catch(() => {});
      } else if (++playingChecks >= 4) {
        window.clearInterval(timer);
      }
    }, 500);
    video.play().catch(() => {});
  }

  function repositionRecommendations(viewportWidth, pinWidth, offset) {
    const leftEdge = (viewportWidth - pinWidth) / 2 + offset;
    const rightEdge = leftEdge + pinWidth;
    const cards = Array.from(document.querySelectorAll('[role="listitem"]')).filter(item =>
      item !== active && !item.contains(active) && !active.contains(item) &&
      item.querySelector('a[href*="/pin/"]'));
    const geometry = cards.map(item => {
      const previous = parseFloat(item.style.getPropertyValue('--tm-shift-x')) || 0;
      const rect = item.getBoundingClientRect();
      const originalLeft = rect.left - previous;
      return { item, previous, rect, originalLeft };
    }).filter(card => card.rect.width > 0 && card.rect.height > 0);
    // Reserve space for cards Pinterest already placed on the left, then
    // place shifted cards only where they will not overlap another card.
    const occupied = geometry.filter(card => card.originalLeft < leftEdge)
      .map(card => ({ left: card.originalLeft, right: card.originalLeft + card.rect.width,
        top: card.rect.top, bottom: card.rect.bottom }));
    for (const { item, previous, rect, originalLeft } of geometry) {
      const destination = originalLeft - pinWidth - 12;
      const candidate = { left: destination, right: destination + rect.width,
        top: rect.top, bottom: rect.bottom };
      const overlaps = occupied.some(other => candidate.left < other.right + 4 &&
        candidate.right > other.left - 4 && candidate.top < other.bottom + 4 &&
        candidate.bottom > other.top - 4);
      const shift = originalLeft < rightEdge && originalLeft >= leftEdge && destination >= 76 && !overlaps
        ? -pinWidth - 12 : 0;
      if (shift) {
        occupied.push(candidate);
        if (previous !== shift) item.style.setProperty('--tm-shift-x', `${shift}px`);
        if (!item.hasAttribute('data-tm-shifted-pin')) item.setAttribute('data-tm-shifted-pin', '');
        shiftedPins.add(item);
      } else if (shiftedPins.has(item)) {
        item.removeAttribute('data-tm-shifted-pin');
        item.style.removeProperty('--tm-shift-x');
        shiftedPins.delete(item);
      }
    }
    for (const item of shiftedPins) if (!item.isConnected) shiftedPins.delete(item);
  }

  function updateSides(top, viewportWidth, pinWidth) {
    const leftWidth = Math.floor((viewportWidth - pinWidth) / 2 - 96);
    const rightWidth = Math.floor((viewportWidth - pinWidth) / 2 - 24);
    if (Math.min(leftWidth, rightWidth) < 110) {
      for (const panel of sidePanels) panel.remove();
      sidePanels = [];
      sideSignature = '';
      return;
    }
    if (!sidePanels.length) {
      sidePanels = ['left', 'right'].map(side => {
        const panel = document.createElement('aside');
        panel.className = `tm-pin-side tm-pin-side-${side}`;
        panel.setAttribute('aria-label', `Related Pins on the ${side}`);
        document.body.append(panel);
        return panel;
      });
    }
    sidePanels.forEach((panel, index) => {
      panel.style.setProperty('--tm-side-top', `${top}px`);
      panel.style.setProperty('--tm-side-width', `${index ? rightWidth : leftWidth}px`);
    });
    const seen = new Set();
    const pins = [];
    for (const link of document.querySelectorAll('a[href*="/pin/"]')) {
      if (link.closest('.tm-pin-side')) continue;
      const image = link.querySelector('img');
      const href = link.href;
      if (image && image.loading === 'lazy') image.loading = 'eager';
      const src = image && (image.currentSrc || image.src || image.getAttribute('data-src') || (image.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0]);
      if (!src || !/^https?:/.test(src) || !/\/pin\/[^/]+/.test(href) ||
          new URL(href).pathname === location.pathname || seen.has(href)) continue;
      seen.add(href);
      pins.push({ href, src, alt: image.alt || 'Open related Pin' });
      if (pins.length >= 40) break;
    }
    for (const pin of pins) savedPins.set(pin.href, pin);
    const collected = Array.from(savedPins.values()).slice(0, 60);
    const signature = JSON.stringify(collected);
    if (signature === sideSignature) return;
    sideSignature = signature;
    const fragments = [document.createDocumentFragment(), document.createDocumentFragment()];
    collected.forEach((pin, index) => {
      const link = document.createElement('a');
      const image = document.createElement('img');
      link.href = pin.href;
      image.src = pin.src;
      image.alt = pin.alt;
      image.loading = 'lazy';
      link.append(image);
      fragments[index % 2].append(link);
    });
    sidePanels.forEach((panel, index) => panel.replaceChildren(fragments[index]));
  }

  function update() {
    pending = 0;
    if (closedPin && location.pathname !== closedPath) {
      closedPin.removeAttribute('data-tm-pin-dismissed');
      closedPin = null;
      closedPath = '';
    }
    if (closedPin && location.pathname === closedPath) return;
    if (!enabled || !/^\/pin\/[^/]+\/?$/.test(location.pathname) ||
        document.documentElement.clientWidth < MIN_DESKTOP_WIDTH) {
      clear();
      return;
    }
    const pin = findPin();
    if (!pin) {
      clear();
      return;
    }
    if (pin !== active) {
      clear();
      naturalWidth = Math.min(MAX_WIDTH, pin.getBoundingClientRect().width);
      active = pin;
      // Keep the same DOM nodes so Pinterest's Save, comments, and video
      // event handlers remain attached. No image cloning or reparenting.
      for (let parent = pin.parentElement; parent; parent = parent.parentElement) {
        parent.setAttribute(ANCESTOR, '');
        ancestors.push(parent);
      }
      active.setAttribute(TARGET, '');
      resizeObserver.observe(active);
      closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'tm-pin-close';
      closeButton.textContent = '×';
      closeButton.setAttribute('aria-label', 'Close open Pin');
      closeButton.title = 'Close open Pin';
      closeButton.addEventListener('click', () => {
        const dismissed = active;
        if (!dismissed) return;
        closedPath = location.pathname;
        closedPin = dismissed;
        clear();
        dismissed.setAttribute('data-tm-pin-dismissed', '');
      });
      document.body.append(closeButton);
    }

    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    let top = GAP;
    // Leave a horizontal Pinterest header accessible, when present.
    for (const header of document.querySelectorAll('#HeaderContent, [data-test-id="header"]')) {
      const rect = header.getBoundingClientRect();
      if (rect.width > viewportWidth / 2 && rect.height > 0 &&
          rect.bottom > 0 && rect.bottom < viewportHeight / 3) {
        top = Math.max(top, rect.bottom + GAP);
      }
    }
    const height = Math.max(1, viewportHeight - top - GAP);
    const pinWidth = Math.min(naturalWidth, viewportWidth - GAP * 2);
    const offset = Math.min(160, Math.max(0, (viewportWidth - pinWidth) / 2 - GAP));
    setVariable('--tm-pin-width', `${pinWidth}px`);
    setVariable('--tm-pin-center-x', `${viewportWidth / 2 + offset}px`);
    setVariable('--tm-pin-center-y', `${top + height / 2}px`);
    setVariable('--tm-pin-max-height', `${height}px`);
    if (closeButton) {
      // Sit just outside the card when there is room, preserving Save and menu.
      const rightEdge = viewportWidth / 2 + offset + pinWidth / 2;
      closeButton.style.left = `${Math.min(viewportWidth - 44, rightEdge + 8)}px`;
      closeButton.style.top = `${top + 8}px`;
    }
    // Pinterest renders its own recommendation grid around the closeup.
    repositionRecommendations(viewportWidth, pinWidth, offset);
    configureOpenVideo();
    // Pinterest initially renders only the first few recommendations. Briefly
    // scroll its own recommendation container to let it load additional Pins.
    if (false && scannedPath !== location.pathname && sidePanels.length) {
      scannedPath = location.pathname;
      const container = active;
      const originalTop = container.scrollTop;
      let steps = 0;
      const scan = () => {
        if (container !== active || steps++ >= 18 || savedPins.size >= 48) {
          if (container === active) container.scrollTop = originalTop;
          schedule();
          return;
        }
        container.scrollTop += Math.max(400, container.clientHeight * 0.8);
        schedule();
        window.setTimeout(scan, 900);
      };
      window.setTimeout(scan, 1000);
    }
  }

  function schedule() {
    if (!pending) pending = window.setTimeout(update, 100);
  }

  const resizeObserver = new ResizeObserver(schedule);
  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-test-id', 'hidden', 'aria-hidden', 'src', 'srcset'],
  });
  document.addEventListener('load', schedule, true);
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('popstate', schedule);
  // URL polling also catches Pinterest pushState navigation in Tampermonkey's
  // isolated world, without replacing Pinterest's history functions.
  window.setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      schedule();
    }
  }, 500);

  GM_registerMenuCommand('Toggle centered Pins', () => {
    enabled = !enabled;
    GM_setValue('centerOpenPin', enabled);
    update();
  });
  update();
})();

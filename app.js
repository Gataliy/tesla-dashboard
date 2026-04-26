
/* ==========================================================
   MINI KALMAN FILTER FOR GPS SPEED
   - сглаживает скорость GPS
   - уменьшает ложные переключения Стоянка/Движение
   ========================================================== */
(function () {
  class MiniKalmanFilter {
    constructor({ R = 0.01, Q = 3 } = {}) {
      this.R = R;
      this.Q = Q;
      this.A = 1;
      this.C = 1;
      this.cov = NaN;
      this.x = NaN;
    }

    filter(value) {
      const z = Number(value || 0);

      if (Number.isNaN(this.x)) {
        this.x = z;
        this.cov = 1;
      } else {
        const predX = this.A * this.x;
        const predCov = this.A * this.cov * this.A + this.R;
        const K = predCov * this.C / (this.C * predCov * this.C + this.Q);

        this.x = predX + K * (z - this.C * predX);
        this.cov = predCov - K * this.C * predCov;
      }

      return this.x;
    }

    reset() {
      this.cov = NaN;
      this.x = NaN;
    }
  }

  const speedFilter = new MiniKalmanFilter({ R: 0.01, Q: 3 });
  let lastMotion = "Стоянка";

  function getMotionBySpeed(speedMps) {
    const filteredSpeed = speedFilter.filter(speedMps || 0);
    const kmh = filteredSpeed * 3.6;

    if (kmh > 8) lastMotion = "Движение";
    else if (kmh < 3) lastMotion = "Стоянка";

    return { motion: lastMotion, kmh, filteredSpeed };
  }

  window.TomskKalmanGPS = {
    getMotionBySpeed,
    reset: () => {
      speedFilter.reset();
      lastMotion = "Стоянка";
    }
  };
})();



/* ==========================================================
   BIGDATACLOUD CITY RESOLVER
   GPS -> BigDataCloud -> city
   Open-Meteo remains for weather
   ========================================================== */
(function () {
  const BDC_CACHE_KEY = "tomsk_bigdatacloud_city_cache_v1";
  const BDC_CACHE_TTL = 1000 * 60 * 60; // 1 hour

  function readCache(lat, lon) {
    try {
      const raw = localStorage.getItem(BDC_CACHE_KEY);
      if (!raw) return null;

      const data = JSON.parse(raw);
      if (Date.now() - data.savedAt > BDC_CACHE_TTL) return null;

      const dLat = Math.abs((data.lat || 0) - lat);
      const dLon = Math.abs((data.lon || 0) - lon);
      if (dLat > 0.25 || dLon > 0.25) return null;

      return data.city || null;
    } catch {
      return null;
    }
  }

  function saveCache(lat, lon, city) {
    try {
      localStorage.setItem(BDC_CACHE_KEY, JSON.stringify({
        savedAt: Date.now(),
        lat,
        lon,
        city
      }));
    } catch {}
  }

  async function getCity(lat, lon) {
    const cached = readCache(lat, lon);
    if (cached) return cached;

    try {
      const url =
        "https://api.bigdatacloud.net/data/reverse-geocode-client" +
        "?latitude=" + encodeURIComponent(lat) +
        "&longitude=" + encodeURIComponent(lon) +
        "&localityLanguage=ru";

      const res = await fetch(url);
      const data = await res.json();

      const city =
        data.city ||
        data.locality ||
        data.principalSubdivision ||
        data.countryName ||
        null;

      if (city) {
        saveCache(lat, lon, city);
        return city;
      }
    } catch (e) {
      console.log("BigDataCloud error:", e);
    }

    return null;
  }

  function setCityUI(city) {
    if (!city) return;
    const value = String(city).toUpperCase();

    ["weatherCity", "cityName", "locationName", "weatherLocation"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    });

    document.querySelectorAll(".weather-city").forEach((el) => {
      el.textContent = value;
    });
  }

  window.TomskBigDataCloud = {
    getCity,
    setCityUI,
    clear: () => localStorage.removeItem(BDC_CACHE_KEY)
  };
})();



/* ==========================================================
   TESLA GPS MODE
   - GPS не запрашивается постоянно
   - быстрый старт через кэш
   - точный GPS включается только по запросу / в шторке
   - защита от повторных запросов
   ========================================================== */

(function () {
  const GPS_CACHE_KEY = "tomsk_tesla_gps_cache_v2";
  const GPS_CACHE_TTL = 1000 * 60 * 15; // 15 минут
  const GPS_MIN_REQUEST_INTERVAL = 1000 * 60 * 2; // не чаще 1 раза в 2 минуты
  const DEFAULT_COORDS = { lat: 56.4846, lon: 84.9486, source: "default" }; // Томск

  let gpsBusy = false;
  let lastGpsRequestAt = 0;
  let lastCoords = readGpsCache() || DEFAULT_COORDS;

  function readGpsCache() {
    try {
      const raw = localStorage.getItem(GPS_CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.lat || !data.lon) return null;
      if (Date.now() - data.savedAt > GPS_CACHE_TTL) return null;
      return data;
    } catch {
      return null;
    }
  }

  function saveGpsCache(coords) {
    try {
      const payload = {
        lat: coords.lat,
        lon: coords.lon,
        source: coords.source || "gps",
        savedAt: Date.now()
      };
      localStorage.setItem(GPS_CACHE_KEY, JSON.stringify(payload));
      lastCoords = payload;
    } catch {}
  }

  function canAskGps(force) {
    if (force) return true;
    return Date.now() - lastGpsRequestAt > GPS_MIN_REQUEST_INTERVAL;
  }

  function getGpsOnce(options = {}) {
    const force = !!options.force;
    const highAccuracy = !!options.highAccuracy;

    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }

      if (gpsBusy || !canAskGps(force)) {
        resolve(lastCoords || readGpsCache() || DEFAULT_COORDS);
        return;
      }

      gpsBusy = true;
      lastGpsRequestAt = Date.now();

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          gpsBusy = false;
          const coords = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            source: highAccuracy ? "gps_precise" : "gps"
          };
          saveGpsCache(coords);
          window.dispatchEvent(new CustomEvent("tesla:gps-update", { detail: coords }));
          resolve(coords);
        },
        () => {
          gpsBusy = false;
          resolve(readGpsCache() || DEFAULT_COORDS);
        },
        {
          enableHighAccuracy: highAccuracy,
          timeout: highAccuracy ? 12000 : 7000,
          maximumAge: highAccuracy ? 30000 : 1000 * 60 * 10
        }
      );
    });
  }

  async function getDashboardCoords() {
    const cached = readGpsCache();
    if (cached) return cached;

    const quick = await getGpsOnce({ highAccuracy: false });
    return quick || DEFAULT_COORDS;
  }

  async function requestPreciseGpsForAttention() {
    return await getGpsOnce({ force: true, highAccuracy: true });
  }

  function clearGpsCache() {
    try {
      localStorage.removeItem(GPS_CACHE_KEY);
    } catch {}
    lastCoords = DEFAULT_COORDS;
  }

  window.TomskTeslaGPS = {
    getDashboardCoords,
    getGpsOnce,
    requestPreciseGpsForAttention,
    clearGpsCache,
    getLastCoords: () => lastCoords || readGpsCache() || DEFAULT_COORDS
  };

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!target) return;

    const button = target.closest ? target.closest("[data-panel], .attention-btn, #attentionBtn") : null;
    const opensAttention =
      button &&
      (
        button.dataset?.panel === "attentionPanel" ||
        button.dataset?.panel === "attention" ||
        String(button.textContent || "").includes("Внимание") ||
        button.id === "attentionBtn"
      );

    if (opensAttention) {
      requestPreciseGpsForAttention();
    }
  });
})();


/**********************************************
 * My Black Window - Dashboard
 * Версия 3.2 (улучшенное разнообразие автообоев)
 **********************************************/
// Токен безопасности (должен быть получен из Android)
const TOKEN = window.ANDROID_TOKEN || "SECURE_TOKEN_2025";
// Глобальный объект приложения
const App = (function () {
    "use strict";
    // ---------- Конфигурация ----------
    const DEBUG = false;
    const log = (...args) => DEBUG && console.log("[App]", ...args);
    const warn = (...args) => console.warn("[App]", ...args);
    const error = (...args) => console.error("[App]", ...args);
    const safeParseJson = (value, fallback = null) => {
        if (typeof value !== 'string')
            return value !== null && value !== void 0 ? value : fallback;
        try {
            return JSON.parse(value);
        }
        catch (e) {
            warn('JSON parse failed:', e, value);
            return fallback;
        }
    };
    const escapeHtml = (value) => String(value !== null && value !== void 0 ? value : '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const resolveBackgroundTarget = (el) => {
        if (el === document.body) {
            return document.getElementById('dashboard_bg') || document.body;
        }
        return el;
    };
    const setSafeBackgroundImage = (el, src) => {
        const target = resolveBackgroundTarget(el);
        if (!target)
            return;
        const nextBackground = src ? `url(${JSON.stringify(String(src))})` : 'none';
        const currentBackground = target.style.backgroundImage || getComputedStyle(target).backgroundImage || 'none';
        if (currentBackground === nextBackground) {
            target.style.backgroundImage = nextBackground;
            return;
        }
        if (target.dataset.bgFadeBusy === 'true') {
            target.querySelectorAll('.bg-fade-overlay').forEach(node => node.remove());
            target.dataset.bgFadeBusy = 'false';
        }
        const overlay = document.createElement('div');
        overlay.className = 'bg-fade-overlay';
        overlay.style.backgroundImage = nextBackground;
        target.appendChild(overlay);
        target.dataset.bgFadeBusy = 'true';
        requestAnimationFrame(() => {
            overlay.classList.add('is-visible');
        });
        window.setTimeout(() => {
            target.style.backgroundImage = nextBackground;
            overlay.remove();
            target.dataset.bgFadeBusy = 'false';
        }, 90);
    };
    const setImageSource = (img, src, fallback = '') => {
        if (!img)
            return;
        img.onerror = null;
        if (fallback) {
            img.onerror = () => {
                img.onerror = null;
                if (img.src !== fallback)
                    img.src = fallback;
            };
        }
        img.src = src || fallback;
    };
    const createInfoMessage = (text) => {
        const div = document.createElement('div');
        div.style.gridColumn = '1 / -1';
        div.style.padding = '20px';
        div.style.textAlign = 'center';
        div.textContent = text;
        return div;
    };
    const ensureFixedLayoutLayers = () => {
        const body = document.body;
        if (!body)
            return;
        let bg = document.getElementById('dashboard_bg');
        if (!bg) {
            bg = document.createElement('div');
            bg.id = 'dashboard_bg';
            body.insertBefore(bg, body.firstChild);
        }
        let root = document.getElementById('dashboard_root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'dashboard_root';
            const children = Array.from(body.childNodes);
            for (const node of children) {
                if (node === bg || node === root)
                    continue;
                if (node.nodeType === 1 && node.tagName === 'SCRIPT')
                    continue;
                root.appendChild(node);
            }
            body.insertBefore(root, bg.nextSibling);
        }
        body.classList.add('fixed-layout-ready');
    };
    ensureFixedLayoutLayers();
    // ---------- Хелперы ----------
    const storage = {
        save(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            }
            catch (e) {
                error("Storage save error:", e);
            }
        },
        load(key) {
            try {
                const v = localStorage.getItem(key);
                return v ? safeParseJson(v, null) : null;
            }
            catch (e) {
                error("Storage load error:", e);
                return null;
            }
        }
    };
    // Безопасный вызов Android API
    const android = {
        call(method, ...args) {
            if (window.androidApi && typeof window.androidApi[method] === 'function') {
                try {
                    return window.androidApi[method](...args);
                }
                catch (e) {
                    error(`Android API error [${method}]:`, e);
                }
            }
            else {
                warn(`Android API method not available: ${method}`);
            }
            return null;
        },
        runEnum(cmd) {
            log("Sending command:", cmd);
            this.call('runEnum', TOKEN, cmd);
        },
        getRunEnum() {
            const result = this.call('getRunEnum', TOKEN);
            log("getRunEnum raw result:", result);
            return result || '[]';
        },
        getRunEnumPic(cmd) { return this.call('getRunEnumPic', TOKEN, cmd); },
        getUserApps() { return this.call('getUserApps', TOKEN) || '[]'; },
        runApp(pkg) { this.call('runApp', TOKEN, pkg); },
        seekTo(positionMs) {
            const pos = Math.max(0, Math.floor(Number(positionMs) || 0));
            const direct = this.call('seekTo', TOKEN, pos);
            if (direct !== null && direct !== undefined)
                return direct;
            return this.call('setPlaybackPosition', TOKEN, pos);
        },
        requestClimateState() { this.call('requestClimateState', TOKEN); },
        requestClimateStateForCommand(cmd) { this.call('requestClimateStateForCommand', TOKEN, cmd); },
        onJsReady() { this.call('onJsReady', TOKEN); },
        onClose() { this.call('onClose', TOKEN); },
        onSettings() { this.call('onSettings', TOKEN); }
    };
    // ---------- Уведомления (toast) ----------
    function showToast(message, duration = 3000) {
        const existingToast = document.querySelector('.toast-message');
        if (existingToast)
            existingToast.remove();
        const toast = document.createElement('div');
        toast.className = 'toast-message';
        toast.textContent = message;
        toast.style.cssText = `
      position: fixed;
      top: 5rem;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 0.8rem 1.5rem;
      border-radius: 2rem;
      font-size: 1rem;
      backdrop-filter: blur(5px);
      z-index: 10000;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: fadeInOutTop ${duration}ms ease-in-out;
      pointer-events: none;
    `;
        if (!document.getElementById('toast-styles')) {
            const style = document.createElement('style');
            style.id = 'toast-styles';
            style.textContent = `
        @keyframes fadeInOutTop {
          0% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
          10% { opacity: 1; transform: translateX(-50%) translateY(0); }
          90% { opacity: 1; transform: translateX(-50%) translateY(0); }
          100% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
        }
      `;
            document.head.appendChild(style);
        }
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    }
    // Универсальная функция длинного нажатия с ripple
    function makeLongPressable(element, callback, options = {}) {
        const { delay = 700, ripple = true } = options;
        let pressTimer;
        let longPressTriggered = false;
        const addRipple = (e) => {
            if (!ripple)
                return;
            const rect = element.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const x = (e.clientX || (e.touches ? e.touches[0].clientX : rect.left + rect.width / 2)) - rect.left;
            const y = (e.clientY || (e.touches ? e.touches[0].clientY : rect.top + rect.height / 2)) - rect.top;
            const rippleEl = document.createElement('span');
            rippleEl.classList.add('ripple');
            rippleEl.style.width = rippleEl.style.height = size + 'px';
            rippleEl.style.left = x - size / 2 + 'px';
            rippleEl.style.top = y - size / 2 + 'px';
            element.style.position = 'relative';
            element.appendChild(rippleEl);
            setTimeout(() => rippleEl.remove(), 500);
        };
        const start = (e) => {
            longPressTriggered = false;
            clearTimeout(pressTimer);
            pressTimer = setTimeout(() => {
                longPressTriggered = true;
                addRipple(e);
                callback(element, e);
            }, delay);
        };
        const cancel = () => {
            clearTimeout(pressTimer);
        };
        const end = (e) => {
            clearTimeout(pressTimer);
            if (longPressTriggered) {
                e === null || e === void 0 ? void 0 : e.preventDefault();
                longPressTriggered = false;
            }
        };
        element.addEventListener('touchstart', start, { passive: true });
        element.addEventListener('touchend', end);
        element.addEventListener('touchcancel', cancel);
        element.addEventListener('mousedown', start);
        element.addEventListener('mouseup', end);
        element.addEventListener('mouseleave', cancel);
    }
    function attachOemTouchFeedback(selector) {
        var _a;
        const elements = typeof selector === 'string' ? document.querySelectorAll(selector) : selector;
        (_a = elements === null || elements === void 0 ? void 0 : elements.forEach) === null || _a === void 0 ? void 0 : _a.call(elements, (element) => {
            if (!element || element.dataset.oemTouchBound === '1')
                return;
            element.dataset.oemTouchBound = '1';
            let releaseTimer = null;
            let pointerActive = false;
            const clearRelease = () => {
                if (releaseTimer) {
                    clearTimeout(releaseTimer);
                    releaseTimer = null;
                }
            };
            const ensureRipple = (event) => {
                var _a, _b, _c, _d;
                let ripple = element.querySelector('.touch-ripple');
                if (!ripple) {
                    ripple = document.createElement('span');
                    ripple.className = 'touch-ripple';
                    element.appendChild(ripple);
                }
                const rect = element.getBoundingClientRect();
                const point = ((_a = event === null || event === void 0 ? void 0 : event.touches) === null || _a === void 0 ? void 0 : _a[0]) || event;
                const x = (_b = point === null || point === void 0 ? void 0 : point.clientX) !== null && _b !== void 0 ? _b : (rect.left + rect.width / 2);
                const y = (_c = point === null || point === void 0 ? void 0 : point.clientY) !== null && _c !== void 0 ? _c : (rect.top + rect.height / 2);
                ripple.style.left = `${x - rect.left}px`;
                ripple.style.top = `${y - rect.top}px`;
                (_d = ripple.getAnimations) === null || _d === void 0 ? void 0 : _d.call(ripple).forEach(anim => anim.cancel());
                ripple.style.animation = 'none';
                ripple.offsetHeight;
            };
            const press = (event) => {
                pointerActive = true;
                clearRelease();
                element.classList.remove('is-releasing');
                ensureRipple(event);
                element.classList.add('is-pressed');
            };
            const release = () => {
                if (!pointerActive && !element.classList.contains('is-pressed'))
                    return;
                pointerActive = false;
                element.classList.remove('is-pressed');
                element.classList.add('is-releasing');
                clearRelease();
                const releaseDuration = element.matches('.climate_slot, .climate-off-all') ? 110 : 240;
                releaseTimer = setTimeout(() => {
                    element.classList.remove('is-releasing');
                }, releaseDuration);
            };
            element.addEventListener('pointerdown', press, { passive: true });
            element.addEventListener('pointerup', release, { passive: true });
            element.addEventListener('pointercancel', release, { passive: true });
            element.addEventListener('pointerleave', release, { passive: true });
            element.addEventListener('blur', release, true);
        });
    }
    // Показать/скрыть глобальный лоадер
    const loader = {
        show() { var _a; (_a = document.getElementById('global-loader')) === null || _a === void 0 ? void 0 : _a.classList.remove('hidden'); },
        hide() { var _a; (_a = document.getElementById('global-loader')) === null || _a === void 0 ? void 0 : _a.classList.add('hidden'); }
    };
    // ---------- Модули ----------
    const modules = {};
    // --- Обои (версия 3.2 с улучшенным разнообразием) ---
    modules.wallpaper = (function () {
        const staticWallpapers = Array.from(document.querySelectorAll('.wallpaper-item')).map(item => item.dataset.src);
        let customWallpaperIndex = 0;
        let autoScheduleTimer = null;
        const SMART_WALLPAPER_GROUPS = {
        };
        // Настройки кеша
        const CACHE_KEY = 'wallpaper_cache';
        const CACHE_INDEX_KEY = 'wallpaper_cache_index'; // для последовательного выбора
        const MAX_CACHE_SIZE = 16;
        const RECENT_WALLPAPERS_KEY = 'wallpaper_recent_history';
        const MAX_RECENT_WALLPAPERS = 8;
        // Источники с параметрами уникальности
        const IMAGE_SOURCES = [
            {
                name: 'Picsum',
                url: (w, h) => `https://picsum.photos/${w}/${h}?random&t=${Date.now()}`
            },
            {
                name: 'LoremFlickr',
                url: (w, h) => `https://loremflickr.com/${w}/${h}/landscape?random&lock=${Date.now()}`
            },
            {
                name: 'PlaceKitten',
                url: (w, h) => `https://placekitten.com/${w}/${h}?image=${Math.floor(Math.random() * 100)}`
            },
            {
                name: 'JCARTools',
                url: (w, h) => `https://jcartools.ru/run/picsum_proxy.php?${w}/${h}&t=${Date.now()}`
            }
        ];
        // Переменная для предзагрузки
        let preloadImage = null;
        let preloadAbortController = null;
        let wallpaperBusy = false;
        let lastSourceName = null;
        function getRandomSource(excludeNames = []) {
            const excluded = new Set(excludeNames.filter(Boolean));
            let candidates = IMAGE_SOURCES.filter(source => !excluded.has(source.name));
            if (!candidates.length)
                candidates = IMAGE_SOURCES.slice();
            const source = candidates[Math.floor(Math.random() * candidates.length)];
            lastSourceName = source.name;
            return source;
        }
        async function fetchImage(url, timeoutMs = 8000) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
                clearTimeout(timeout);
                if (!res.ok)
                    throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                if (blob.size < 10000)
                    throw new Error('Image too small');
                const base64 = await new Promise(r => {
                    const fr = new FileReader();
                    fr.onloadend = () => r(fr.result);
                    fr.readAsDataURL(blob);
                });
                return base64;
            }
            finally {
                clearTimeout(timeout);
            }
        }
        // Управление кешем
        function getCache() {
            return storage.load(CACHE_KEY) || [];
        }
        function saveCache(cache) {
            // Убираем дубликаты (на всякий случай)
            const uniqueCache = [...new Set(cache)];
            if (uniqueCache.length > MAX_CACHE_SIZE) {
                uniqueCache.length = MAX_CACHE_SIZE;
            }
            storage.save(CACHE_KEY, uniqueCache);
        }
        function addToCache(base64) {
            const cache = getCache();
            // Удаляем существующий экземпляр
            const newCache = cache.filter(item => item !== base64);
            newCache.unshift(base64);
            saveCache(newCache);
        }

        function getRecentWallpapers() {
            return storage.load(RECENT_WALLPAPERS_KEY) || [];
        }
        function rememberWallpaper(base64) {
            if (!base64)
                return;
            const recent = getRecentWallpapers().filter(item => item !== base64);
            recent.unshift(base64);
            if (recent.length > MAX_RECENT_WALLPAPERS) {
                recent.length = MAX_RECENT_WALLPAPERS;
            }
            storage.save(RECENT_WALLPAPERS_KEY, recent);
        }
        function isRecentWallpaper(base64) {
            return !!base64 && getRecentWallpapers().includes(base64);
        }
        // Последовательный выбор из кеша
        function getNextFromCache() {
            const cache = getCache();
            if (cache.length === 0)
                return null;
            let index = storage.load(CACHE_INDEX_KEY) || 0;
            // Убедимся, что индекс в пределах
            if (index >= cache.length)
                index = 0;
            const image = cache[index];
            // Увеличиваем индекс для следующего раза
            const nextIndex = (index + 1) % cache.length;
            storage.save(CACHE_INDEX_KEY, nextIndex);
            return image;
        }
        // Сброс индекса при изменении кеша
        function resetCacheIndex() {
            storage.save(CACHE_INDEX_KEY, 0);
        }
        // Предзагрузка следующего изображения (использует случайный источник)
        async function preloadNextWallpaper() {
            if (preloadAbortController) {
                preloadAbortController.abort();
            }
            preloadAbortController = new AbortController();
            const w = window.innerWidth, h = window.innerHeight;
            const source = getRandomSource();
            const url = source.url(w, h);
            log(`Preloading wallpaper from ${source.name}: ${url}`);
            try {
                const base64 = await fetchImage(url, 10000);
                preloadImage = base64;
                log('Preload successful, cached in memory');
                addToCache(base64);
                resetCacheIndex(); // сбрасываем индекс, т.к. кеш обновился
            }
            catch (e) {
                warn('Preload failed:', e);
                preloadImage = null;
            }
            finally {
                preloadAbortController = null;
            }
        }
        function clearAutoSchedule() {
            if (autoScheduleTimer) {
                clearTimeout(autoScheduleTimer);
                autoScheduleTimer = null;
            }
        }
        function getTimeWallpaperBucket(date = new Date()) {
            const hour = date.getHours();
            if (hour >= 5 && hour < 9)
                return 'dawn';
            if (hour >= 9 && hour < 17)
                return 'day';
            if (hour >= 17 && hour < 22)
                return 'evening';
            return 'night';
        }
        function getBucketChangeDate(date = new Date()) {
            const hour = date.getHours();
            const next = new Date(date);
            next.setSeconds(0, 0);
            if (hour < 5)
                next.setHours(5, 0, 0, 0);
            else if (hour < 9)
                next.setHours(9, 0, 0, 0);
            else if (hour < 17)
                next.setHours(17, 0, 0, 0);
            else if (hour < 22)
                next.setHours(22, 0, 0, 0);
            else {
                next.setDate(next.getDate() + 1);
                next.setHours(5, 0, 0, 0);
            }
            return next;
        }
        function scheduleSmartAutoUpdate() {
            clearAutoSchedule();
            if (storage.load('wallpaperMode') !== 'auto')
                return;
            const now = new Date();
            const nextChange = getBucketChangeDate(now);
            const delay = Math.max(nextChange.getTime() - now.getTime(), 60000);
            autoScheduleTimer = setTimeout(() => {
                applySmartAutoByTime(false);
            }, delay);
        }
        function applySmartAutoByTime(showToastMessage = false) {
            const bucket = getTimeWallpaperBucket();
            const wallpapers = SMART_WALLPAPER_GROUPS[bucket].filter(src => staticWallpapers.includes(src));
            if (!wallpapers.length) {
                scheduleSmartAutoUpdate();
                return false;
            }
            const current = storage.load('wallpaperSmartCurrent');
            let index = storage.load(`wallpaperSmartIndex_${bucket}`) || 0;
            let src = wallpapers[index % wallpapers.length];
            if (wallpapers.length > 1 && current === src) {
                index = (index + 1) % wallpapers.length;
                src = wallpapers[index % wallpapers.length];
            }
            setSafeBackgroundImage(document.body, src);
            document.body.classList.remove('off-mode');
            storage.save('wallpaperMode', 'auto');
            storage.save('wallpaperSmartCurrent', src);
            storage.save('wallpaperSmartBucket', bucket);
            storage.save(`wallpaperSmartIndex_${bucket}`, (index + 1) % wallpapers.length);
            storage.save('wallpaperImage', src);
            scheduleSmartAutoUpdate();
            if (showToastMessage) {
                const labels = { dawn: 'утренний', day: 'дневной', evening: 'вечерний', night: 'ночной' };
                showToast(`Смарт-обои: ${labels[bucket]} режим`, 1800);
            }
            return true;
        }
        function applyWallpaper(base64, mode = 'internet') {
            setSafeBackgroundImage(document.body, base64);
            document.body.classList.remove('off-mode');
            storage.save('wallpaperMode', mode);
            storage.save('wallpaperImage', base64);
            rememberWallpaper(base64);
        }
        async function setAuto(showLoader = true) {
            clearAutoSchedule();
            if (applySmartAutoByTime(showLoader)) {
                return;
            }
            const w = window.innerWidth, h = window.innerHeight;
            // 1. Предзагруженное изображение
            if (preloadImage) {
                log('Using preloaded image');
                applyWallpaper(preloadImage, 'auto');
                addToCache(preloadImage);
                preloadImage = null;
                preloadNextWallpaper();
                return;
            }
            // 2. Последовательный выбор из кеша
            const cached = getNextFromCache();
            if (cached) {
                log('Using cached image (sequential)');
                applyWallpaper(cached, 'auto');
                preloadNextWallpaper();
                return;
            }
            // 3. Загрузка с сервера
            if (showLoader)
                loader.show();
            try {
                const source = getRandomSource();
                const url = source.url(w, h);
                log(`Fetching wallpaper from ${source.name}: ${url}`);
                const base64 = await fetchImage(url);
                applyWallpaper(base64, 'auto');
                addToCache(base64);
                resetCacheIndex();
                preloadNextWallpaper();
            }
            catch (e) {
                warn('All attempts to load wallpaper failed:', e);
                if (showLoader)
                    showToast('Не удалось загрузить обои', 3000);
                // Пробуем резервный источник
                try {
                    const fallbackSource = IMAGE_SOURCES.find(s => s.name === 'Picsum');
                    const url = fallbackSource.url(w, h);
                    const base64 = await fetchImage(url);
                    applyWallpaper(base64, 'auto');
                    addToCache(base64);
                    resetCacheIndex();
                }
                catch (e2) {
                    setCustomByIndex(0);
                }
            }
            finally {
                if (showLoader)
                    loader.hide();
            }
        }
        function setOff() {
            clearAutoSchedule();
            closeNightOverlays();
            const currentMode = storage.load('wallpaperMode');
            if (currentMode && currentMode !== 'off') {
                storage.save('wallpaperPrevMode', currentMode);
            }
            storage.save('nightModeActive', true);
            setSafeBackgroundImage(document.body, null);
            const bgLayer = document.getElementById('dashboard_bg') || document.body;
            bgLayer.style.backgroundColor = "#0F0D13";
            document.body.classList.add('off-mode');
            const timeWidget = document.querySelector('.widget_time');
            if (timeWidget) {
                timeWidget.classList.add('glowing');
                setTimeout(() => timeWidget.classList.remove('glowing'), 900);
            }
        }
        function updateWallpaperSelection(activeSrc) {
            document.querySelectorAll('.wallpaper-item').forEach(item => {
                item.classList.toggle('is-active', item.dataset.src === activeSrc);
            });
        }
        function setCustomByIndex(index) {
            clearAutoSchedule();
            if (!staticWallpapers.length)
                return;
            const src = staticWallpapers[index % staticWallpapers.length];
            setSafeBackgroundImage(document.body, src);
            document.body.classList.remove('off-mode');
            storage.save('wallpaperMode', 'custom');
            storage.save('wallpaperCustom', src);
            storage.save('customWallpaperIndex', index);
            customWallpaperIndex = index;
            updateWallpaperSelection(src);
        }
        function nextCustom() {
            if (storage.load('wallpaperMode') !== 'custom')
                return;
            let idx = storage.load('customWallpaperIndex') || 0;
            idx = (idx + 1) % staticWallpapers.length;
            setCustomByIndex(idx);
        }

        async function fetchFreshWallpaperForTap() {
            const w = window.innerWidth;
            const h = window.innerHeight;
            const currentImage = storage.load('wallpaperImage');
            const excludedSources = [lastSourceName];
            let lastError = null;
            for (let attempt = 0; attempt < IMAGE_SOURCES.length + 2; attempt++) {
                const source = getRandomSource(excludedSources);
                excludedSources.push(source.name);
                const url = source.url(w, h);
                log(`Fetching fresh tap wallpaper from ${source.name}: ${url}`);
                try {
                    const base64 = await fetchImage(url, 10000);
                    if (!base64)
                        continue;
                    if (base64 === currentImage || isRecentWallpaper(base64)) {
                        log(`Skipping repeated wallpaper from ${source.name}`);
                        continue;
                    }
                    addToCache(base64);
                    return base64;
                }
                catch (e) {
                    lastError = e;
                }
            }
            throw lastError || new Error('No fresh wallpaper available');
        }
        async function cycleTapWallpaper() {
            if (wallpaperBusy)
                return false;
            wallpaperBusy = true;
            try {
                let applied = false;
                if (preloadImage && !isRecentWallpaper(preloadImage)) {
                    log('Using preloaded internet wallpaper for tap');
                    applyWallpaper(preloadImage, 'internet');
                    addToCache(preloadImage);
                    preloadImage = null;
                    applied = true;
                }
                else {
                    const currentImage = storage.load('wallpaperImage');
                    const cache = getCache();
                    const cached = cache.find(item => item && item !== currentImage && !isRecentWallpaper(item)) || getNextFromCache();
                    if (cached) {
                        log('Using cached internet wallpaper for tap');
                        applyWallpaper(cached, 'internet');
                        applied = true;
                    }
                }
                preloadNextWallpaper();
                if (applied) {
                    return true;
                }
                try {
                    const freshWallpaper = await fetchFreshWallpaperForTap();
                    applyWallpaper(freshWallpaper, 'internet');
                    preloadImage = null;
                    resetCacheIndex();
                    preloadNextWallpaper();
                    return true;
                }
                catch (freshError) {
                    warn('Fresh tap wallpaper fetch failed:', freshError);
                }
                return false;
            }
            catch (e) {
                warn('Tap wallpaper change failed:', e);
                return false;
            }
            finally {
                window.setTimeout(() => {
                    wallpaperBusy = false;
                }, 80);
            }
        }
        function restore() {
            const mode = storage.load('wallpaperMode');
            log("Restoring wallpaper, mode:", mode);
            if (mode === 'custom') {
                const bg = storage.load('wallpaperCustom'), idx = storage.load('customWallpaperIndex');
                if (bg) {
                    setSafeBackgroundImage(document.body, bg);
                    document.body.classList.remove('off-mode');
                    const bgLayer = document.getElementById('dashboard_bg');
                    if (bgLayer)
                        bgLayer.style.backgroundColor = '#0F0D13';
                    updateWallpaperSelection(bg);
                }
                if (idx !== undefined)
                    customWallpaperIndex = idx;
            }
            else if (mode === 'auto') {
                const savedImage = storage.load('wallpaperImage');
                if (savedImage) {
                    setSafeBackgroundImage(document.body, savedImage);
                    document.body.classList.remove('off-mode');
                    scheduleSmartAutoUpdate();
                    preloadNextWallpaper();
                }
                else {
                    setAuto(false);
                }
            }
            else if (mode === 'internet') {
                const savedImage = storage.load('wallpaperImage');
                if (savedImage) {
                    setSafeBackgroundImage(document.body, savedImage);
                    document.body.classList.remove('off-mode');
                    preloadNextWallpaper();
                }
                else {
                    cycleTapWallpaper();
                }
            }
            else if (mode === 'off') {
                setOff();
            }
            else {
                setTimeout(() => setCustomByIndex(0), 100);
            }
        }
        function toggle() {
            var _a, _b;
            const mode = storage.load('wallpaperMode');
            const prevMode = storage.load('wallpaperPrevMode');
            const restoreMode = prevMode && prevMode !== 'off' ? prevMode : mode;
            if (document.body.classList.contains('off-mode')) {
                const savedImage = storage.load('wallpaperImage');
                const bgLayer = document.getElementById('dashboard_bg') || document.body;
                bgLayer.style.backgroundColor = '#0F0D13';
                document.body.classList.remove('off-mode');
                storage.save('nightModeActive', false);
                if (restoreMode === 'custom') {
                    const customIdx = (_a = storage.load('customWallpaperIndex')) !== null && _a !== void 0 ? _a : 0;
                    setCustomByIndex(customIdx);
                }
                else if (restoreMode === 'auto') {
                    if (!applySmartAutoByTime(false)) {
                        setAuto(false);
                    }
                }
                else if (restoreMode === 'internet') {
                    if (savedImage) {
                        setSafeBackgroundImage(document.body, savedImage);
                        document.body.classList.remove('off-mode');
                        preloadNextWallpaper();
                    }
                    else {
                        cycleTapWallpaper();
                    }
                    storage.save('wallpaperMode', 'internet');
                }
                else {
                    setCustomByIndex((_b = storage.load('customWallpaperIndex')) !== null && _b !== void 0 ? _b : 0);
                }
            }
            else {
                setOff();
            }
        }
        function prewarmSidebar() {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar || sidebar.dataset.prewarmed === 'true')
                return;
            sidebar.dataset.prewarmed = 'true';
            const items = Array.from(sidebar.querySelectorAll('.wallpaper-item img'));
            items.forEach((img) => {
                if (!img)
                    return;
                img.decoding = 'async';
                img.loading = 'eager';
                if (typeof img.decode === 'function') {
                    img.decode().catch(() => { });
                }
            });
            requestAnimationFrame(() => {
                void sidebar.offsetWidth;
            });
        }
        function openSidebarFast() {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar || sidebar.classList.contains('open'))
                return;
            prewarmSidebar();
            sidebar.classList.add('open');
        }
        function closeSidebarFast() {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar)
                return;
            sidebar.classList.remove('open');
        }
        function initAutoMode() {
            if (storage.load('wallpaperMode') === 'auto') {
                scheduleSmartAutoUpdate();
                preloadNextWallpaper();
            }
            prewarmSidebar();
        }
        function closeNightOverlays() {
            var _a;
            (_a = document.getElementById('sidebar')) === null || _a === void 0 ? void 0 : _a.classList.remove('open');
            document.querySelectorAll('.picker-drawer.open').forEach((drawer) => drawer.classList.remove('open'));
        }
        return {
            setOff,
            setAuto,
            setCustomByIndex,
            nextCustom,
            cycleTapWallpaper,
            restore,
            toggle,
            initAutoMode,
            applySmartAutoByTime,
            prewarmSidebar,
            openSidebarFast,
            closeSidebarFast
        };
    })();
    // --- Часы ---
    modules.clock = (function () {
        const timeWidget = document.querySelector('.widget_time');
        const flipClock = document.getElementById('flipClock');
        const dateDisplay = document.getElementById('dateDisplay');
        const monthFormatter = new Intl.DateTimeFormat('ru-RU', { month: 'long' });
        const weekdayFormatter = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' });
        let timerId = null;

        function updateTime() {
            const now = new Date();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');

            if (flipClock) {
                flipClock.textContent = `${hours}:${minutes}`;
            }

            if (dateDisplay) {
                const weekdayRaw = weekdayFormatter.format(now);
                const weekday = weekdayRaw.charAt(0).toUpperCase() + weekdayRaw.slice(1);
                dateDisplay.textContent = `${weekday}, ${now.getDate()} ${monthFormatter.format(now)}`;
            }
        }

        function scheduleNextTick() {
            updateTime();
            const now = new Date();
            const delay = ((60 - now.getSeconds()) * 1000) - now.getMilliseconds();
            timerId = setTimeout(scheduleNextTick, Math.max(delay, 1000));
        }

        function toggleNightMode() {
            var _a, _b;
            (_b = (_a = modules.wallpaper) === null || _a === void 0 ? void 0 : _a.toggle) === null || _b === void 0 ? void 0 : _b.call(_a);
        }

        function bindActions() {
            if (!timeWidget || timeWidget.dataset.nightModeBound === 'true')
                return;
            timeWidget.dataset.nightModeBound = 'true';
            timeWidget.setAttribute('role', 'button');
            timeWidget.setAttribute('tabindex', '0');
            timeWidget.setAttribute('aria-label', 'Переключить night mode');
            timeWidget.addEventListener('click', toggleNightMode);
            timeWidget.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleNightMode();
                }
            });
        }

        function start() {
            stop();
            bindActions();
            scheduleNextTick();
        }

        function stop() {
            if (timerId) {
                clearTimeout(timerId);
                timerId = null;
            }
        }

        return { start, stop, updateTime, toggleNightMode };
    })();
    // --- Редактирование надписи ---
    modules.brandEditor = { init() { } };
    // --- Плеер ---
    modules.player = (function () {
        const playerEl = document.querySelector(".widget_player");
        const coverEl = document.querySelector(".widget_player__image");
        const titleEl = document.querySelector(".widget_player__title");
        const titleTextEl = document.querySelector(".widget_player__title_text") || titleEl;
        const artistEl = document.querySelector(".widget_player__artist");
        const sourceEl = document.querySelector(".widget_player__source");
        const imgEl = document.querySelector(".widget_player__image img");
        const progressEl = document.querySelector(".widget_player__track_progress");
        const trackLineEl = document.querySelector(".widget_player__track_line");
        const trackDotEl = document.querySelector(".widget_player__track_dot");
        const timeSpans = [];
        const toggleBtn = document.getElementById("player__toggle");
        const playBtn = null;
        const pauseBtn = null;
        const playIconEl = document.getElementById("playIcon");
        const pauseIconEl = document.getElementById("pauseIcon");
        let mediaSessionTimer = null;
        let progressTimer = null;
        let currentTrackPackage = "";
        let coverAnimTimer = null;
        let isScrubbing = false;
        let scrubCommitTimer = null;
        let swipeState = null;
        let lastExternalUpdateTs = 0;
        let lastAppliedTitle = "";
        let playbackState = {
            position: 0,
            duration: 0,
            isPlaying: false,
            updatedAt: 0
        };
        function setPlaybackControls(isPlaying) {
            if (playBtn && pauseBtn) {
                playBtn.style.display = isPlaying ? "none" : "flex";
                pauseBtn.style.display = isPlaying ? "flex" : "none";
            }
            if (playIconEl && pauseIconEl) {
                playIconEl.style.display = isPlaying ? "none" : "block";
                pauseIconEl.style.display = isPlaying ? "block" : "none";
            }
            if (toggleBtn) {
                toggleBtn.setAttribute("aria-label", isPlaying ? "Пауза" : "Воспроизвести");
                toggleBtn.classList.toggle("is-playing", !!isPlaying);
            }
        }
        function tokenizePath(path) {
            return String(path)
                .replace(/\[(\d+)\]/g, '.$1')
                .split('.')
                .filter(Boolean);
        }
        function getNestedValue(obj, path) {
            if (!obj || typeof obj !== "object")
                return undefined;
            return tokenizePath(path).reduce((acc, key) => {
                if (acc === undefined || acc === null)
                    return undefined;
                return acc[key];
            }, obj);
        }
        function firstDefined(obj, paths) {
            for (const path of paths) {
                const value = typeof path === 'string' && (path.includes('.') || path.includes('['))
                    ? getNestedValue(obj, path)
                    : obj === null || obj === void 0 ? void 0 : obj[path];
                if (value !== undefined && value !== null && value !== "")
                    return value;
            }
            return undefined;
        }
        function parseTimeValue(value) {
            if (typeof value === 'number' && Number.isFinite(value)) {
                if (value < 0)
                    return 0;
                return value;
            }
            if (typeof value !== 'string')
                return 0;
            const trimmed = value.trim();
            if (!trimmed)
                return 0;
            if (/^\d+(\.\d+)?$/.test(trimmed))
                return Number(trimmed);
            if (/^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(trimmed)) {
                const parts = trimmed.split(':').map(Number);
                let seconds = 0;
                for (const part of parts)
                    seconds = seconds * 60 + part;
                return seconds * 1000;
            }
            return 0;
        }
        function normalizeMs(rawValue, fallbackDuration = 0) {
            const parsed = parseTimeValue(rawValue);
            if (!Number.isFinite(parsed) || parsed < 0)
                return 0;
            if (parsed === 0)
                return 0;
            if (typeof rawValue === 'string' && rawValue.includes(':'))
                return parsed;
            if (parsed < 1000)
                return parsed * 1000;
            if (fallbackDuration >= 1000 && parsed <= fallbackDuration / 100)
                return parsed * 1000;
            return parsed;
        }
        function parsePlayingState(value, raw) {
            if (typeof value === "boolean")
                return value;
            if (typeof value === "number") {
                if (value === 3 || value === 6)
                    return true;
                if ([0, 1, 2, 7].includes(value))
                    return false;
                return value > 0;
            }
            if (typeof value === "string") {
                const normalized = value.trim().toLowerCase();
                if (["playing", "play", "true", "1", "started", "resume", "resumed", "state_playing", "buffering"].includes(normalized))
                    return true;
                if (["paused", "pause", "false", "0", "stopped", "stop", "idle", "none", "state_paused", "state_stopped", "state_none"].includes(normalized))
                    return false;
            }
            const pausedValue = firstDefined(raw, ["paused", "isPaused", "playback.paused", "playback.isPaused"]);
            if (typeof pausedValue === "boolean")
                return !pausedValue;
            return false;
        }
        function normalizeArtwork(raw) {
            const artwork = firstDefined(raw, [
                "SongAlbumPicture",
                "albumArtBase64",
                "coverBase64",
                "artworkBase64",
                "metadata.albumArtBase64",
                "metadata.coverBase64",
                "metadata.artworkBase64"
            ]);
            if (typeof artwork === "string" && artwork.trim()) {
                if (artwork.startsWith("data:image/") || artwork.startsWith("http://") || artwork.startsWith("https://") || artwork.startsWith("file://") || artwork.startsWith("content://") || artwork.startsWith("images/")) {
                    return artwork;
                }
                return "data:image/png;base64," + artwork;
            }
            const artworkUrl = firstDefined(raw, [
                "albumArt",
                "albumArtUri",
                "artUri",
                "artwork",
                "cover",
                "image",
                "thumbnail",
                "metadata.albumArt",
                "metadata.albumArtUri",
                "metadata.artUri",
                "metadata.artwork",
                "mediaMetadata.artwork[0].src"
            ]);
            return typeof artworkUrl === "string" && artworkUrl.trim() ? artworkUrl : "images/img.jpg";
        }
        function normalizeMusicInfo(data) {
            const raw = safeParseJson(data, data) || {};
            const durationRaw = firstDefined(raw, ["Trdur", "duration", "durationMs", "length", "lengthMs", "metadata.duration", "mediaMetadata.duration", "playback.duration"]);
            const duration = normalizeMs(durationRaw, 0);
            const positionRaw = firstDefined(raw, ["Trpos", "position", "positionMs", "elapsed", "elapsedMs", "currentTime", "playbackPosition", "metadata.position", "playback.position"]);
            const normalized = {
                title: firstDefined(raw, ["SongName", "title", "track", "trackTitle", "name", "mediaTitle", "metadata.title", "mediaMetadata.title"]) || "—",
                artist: firstDefined(raw, ["SongArtist", "artist", "subtitle", "author", "albumArtist", "metadata.artist", "mediaMetadata.artist"]) || "",
                album: firstDefined(raw, ["album", "SongAlbum", "metadata.album", "mediaMetadata.albumTitle"]) || "",
                app: firstDefined(raw, ["app", "source", "packageName", "package", "player", "clientPackage", "metadata.app"]) || "",
                artwork: normalizeArtwork(raw),
                position: normalizeMs(positionRaw, duration),
                duration,
                isPlaying: parsePlayingState(firstDefined(raw, ["IsPlaying", "playing", "isPlaying", "state", "playbackState", "status", "playback.state"]), raw)
            };
            if (!normalized.artist && normalized.album)
                normalized.artist = normalized.album;
            return normalized;
        }
        function refreshTitleMarquee() {
            if (!titleEl || !titleTextEl)
                return;
            titleEl.classList.remove("is-marquee");
            titleEl.style.removeProperty("--player-title-width");
            const overflow = titleTextEl.scrollWidth - titleEl.clientWidth;
            if (overflow > 16) {
                titleEl.classList.add("is-marquee");
                titleEl.style.setProperty("--player-title-width", titleEl.clientWidth + "px");
            }
        }
        function updatePlayerArtworkVisual(artwork) {
            if (playerEl)
                playerEl.style.setProperty("--player-artwork", `url("${String(artwork || "images/img.jpg").replace(/"/g, '\\"')}")`);
        }
        function animateCoverSwap(artwork) {
            const nextArtwork = artwork || "images/img.jpg";
            if (!imgEl) {
                updatePlayerArtworkVisual(nextArtwork);
                return;
            }
            const preloader = new Image();
            preloader.onload = () => {
                setImageSource(imgEl, nextArtwork, "images/img.jpg");
                updatePlayerArtworkVisual(nextArtwork);
            };
            preloader.onerror = () => {
                setImageSource(imgEl, "images/img.jpg", "images/img.jpg");
                updatePlayerArtworkVisual("images/img.jpg");
            };
            preloader.src = nextArtwork;
        }
        function normalizeSourceLabel(value) {
            const raw = String(value || "").trim();
            if (!raw)
                return "";
            const known = {
                'com.spotify.music': 'Spotify',
                'com.vkontakte.android': 'VK Music',
                'ru.yandex.music': 'Яндекс Музыка',
                'com.apple.android.music': 'Apple Music',
                'deezer.android.app': 'Deezer',
                'com.google.android.apps.youtube.music': 'YouTube Music'
            };
            if (known[raw])
                return known[raw];
            if (raw.includes('.')) {
                const last = raw.split('.').pop() || raw;
                return last.replace(/[_-]+/g, ' ').replace(/\w/g, c => c.toUpperCase());
            }
            return raw;
        }
        function formatTime(t) {
            const safe = Math.max(0, Number(t) || 0);
            const totalSeconds = Math.floor(safe / 1000);
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
        }
        function openCurrentMusicSource() {
            if (!currentTrackPackage)
                return;
            android.runApp(currentTrackPackage);
        }
        function updateSourceChip(appValue) {
            if (!sourceEl)
                return;
            const label = normalizeSourceLabel(appValue || "");
            const isActive = !!label && !!currentTrackPackage;
            sourceEl.textContent = label || "Источник";
            sourceEl.classList.toggle('is-hidden', !label);
            sourceEl.disabled = !isActive;
            sourceEl.setAttribute('aria-disabled', isActive ? 'false' : 'true');
            sourceEl.title = isActive ? `Открыть: ${label}` : 'Источник недоступен';
        }
        function getLivePosition() {
            const duration = Math.max(0, Number(playbackState.duration) || 0);
            const basePosition = Math.max(0, Number(playbackState.position) || 0);
            if (!playbackState.isPlaying || !playbackState.updatedAt)
                return Math.min(basePosition, duration || basePosition);
            const elapsedMs = Math.max(0, Date.now() - playbackState.updatedAt);
            const livePosition = basePosition + elapsedMs;
            return duration > 0 ? Math.min(livePosition, duration) : livePosition;
        }
        function renderProgress(position, duration) {
            const pos = Math.max(0, Number(position) || 0);
            const dur = Math.max(0, Number(duration) || 0);
            const progress = dur > 0 ? Math.min(100, Math.max(0, pos / dur * 100)) : 0;
            if (progressEl)
                progressEl.style.width = progress + "%";
            if (trackDotEl)
                trackDotEl.style.left = progress + "%";
            if (timeSpans.length >= 2) {
                timeSpans[0].textContent = formatTime(pos);
                timeSpans[1].textContent = formatTime(dur);
            }
        }
        function stopProgressAnimation() {
            if (progressTimer) {
                clearInterval(progressTimer);
                progressTimer = null;
            }
        }
        function updateScrubVisual(clientX) {
            if (!trackLineEl)
                return 0;
            const rect = trackLineEl.getBoundingClientRect();
            const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
            const nextPosition = Math.round((playbackState.duration || 0) * ratio);
            renderProgress(nextPosition, playbackState.duration);
            return nextPosition;
        }
        function commitSeek(positionMs) {
            const nextPosition = Math.max(0, Math.min(Number(positionMs) || 0, playbackState.duration || Number(positionMs) || 0));
            playbackState.position = nextPosition;
            playbackState.updatedAt = Date.now();
            renderProgress(nextPosition, playbackState.duration);
            if (scrubCommitTimer)
                clearTimeout(scrubCommitTimer);
            scrubCommitTimer = setTimeout(() => android.seekTo(nextPosition), 20);
        }
        function attachTrackScrubbing() {
            if (!trackLineEl)
                return;
            trackLineEl.style.touchAction = 'none';
            const onPointerDown = (e) => {
                if ((playbackState.duration || 0) <= 0)
                    return;
                isScrubbing = true;
                stopProgressAnimation();
                trackLineEl.classList.add('is-scrubbing');
                try {
                    trackLineEl.setPointerCapture(e.pointerId);
                }
                catch (_) { }
                updateScrubVisual(e.clientX);
            };
            const onPointerMove = (e) => {
                if (!isScrubbing)
                    return;
                updateScrubVisual(e.clientX);
            };
            const finishScrub = (e) => {
                if (!isScrubbing)
                    return;
                const nextPosition = updateScrubVisual(e.clientX);
                isScrubbing = false;
                trackLineEl.classList.remove('is-scrubbing');
                commitSeek(nextPosition);
                if (playbackState.isPlaying)
                    startProgressAnimation();
            };
            trackLineEl.addEventListener('pointerdown', onPointerDown);
            trackLineEl.addEventListener('pointermove', onPointerMove);
            trackLineEl.addEventListener('pointerup', finishScrub);
            trackLineEl.addEventListener('pointercancel', () => {
                if (!isScrubbing)
                    return;
                isScrubbing = false;
                trackLineEl.classList.remove('is-scrubbing');
                renderProgress(getLivePosition(), playbackState.duration);
                if (playbackState.isPlaying)
                    startProgressAnimation();
            });
            trackLineEl.addEventListener('click', (e) => {
                if ((playbackState.duration || 0) <= 0 || isScrubbing)
                    return;
                const nextPosition = updateScrubVisual(e.clientX);
                commitSeek(nextPosition);
            });
        }
        function triggerPlayerCommand(command) {
            if (command === 'prev')
                android.runEnum('MEDIA_BACK');
            if (command === 'next')
                android.runEnum('MEDIA_NEXT');
        }
        function attachCoverSwipes() {
            if (!coverEl)
                return;
            coverEl.style.touchAction = 'pan-y';
            coverEl.addEventListener('pointerdown', (e) => {
                swipeState = { startX: e.clientX, startY: e.clientY, moved: false, fired: false, pointerId: e.pointerId };
            });
            coverEl.addEventListener('pointermove', (e) => {
                if (!swipeState || swipeState.pointerId !== e.pointerId)
                    return;
                const dx = e.clientX - swipeState.startX;
                const dy = e.clientY - swipeState.startY;
                if (Math.abs(dx) > 10 || Math.abs(dy) > 10)
                    swipeState.moved = true;
                if (swipeState.fired)
                    return;
                if (Math.abs(dx) > 52 && Math.abs(dx) > Math.abs(dy) * 1.35) {
                    swipeState.fired = true;
                    coverEl.classList.remove('swipe-left', 'swipe-right');
                    coverEl.classList.add(dx < 0 ? 'swipe-left' : 'swipe-right');
                    triggerPlayerCommand(dx < 0 ? 'next' : 'prev');
                    setTimeout(() => coverEl && coverEl.classList.remove('swipe-left', 'swipe-right'), 180);
                }
            });
            const clearSwipe = (e) => {
                if (!swipeState || (e && swipeState.pointerId !== e.pointerId))
                    return;
                const state = swipeState;
                swipeState = null;
                if (state.fired)
                    return;
            };
            coverEl.addEventListener('pointerup', clearSwipe);
            coverEl.addEventListener('pointercancel', clearSwipe);
        }
        function tickProgress() {
            const livePosition = getLivePosition();
            renderProgress(livePosition, playbackState.duration);
            if (playbackState.duration > 0 && livePosition >= playbackState.duration) {
                playbackState.position = playbackState.duration;
                playbackState.isPlaying = false;
                playbackState.updatedAt = Date.now();
                stopProgressAnimation();
                setPlaybackControls(false);
            }
        }
        function startProgressAnimation() {
            stopProgressAnimation();
            if (!playbackState.isPlaying || document.hidden)
                return;
            progressTimer = setInterval(tickProgress, 250);
        }
        function applyMusicInfo(info, source = 'external') {
            if (!info || typeof info !== 'object')
                return;
            const title = info.title || "—";
            const artist = info.artist || info.app || "";
            if (titleTextEl)
                titleTextEl.textContent = title;
            else if (titleEl)
                titleEl.textContent = title;
            if (artistEl)
                artistEl.textContent = artist;
            currentTrackPackage = String(info.app || "").includes('.') ? String(info.app || "") : "";
            updateSourceChip(info.app || "");
            animateCoverSwap(info.artwork || "images/img.jpg");
            if (coverEl)
                coverEl.classList.toggle('is-clickable', false);
            requestAnimationFrame(refreshTitleMarquee);
            playbackState = {
                position: Math.max(0, Number(info.position) || 0),
                duration: Math.max(0, Number(info.duration) || 0),
                isPlaying: !!info.isPlaying,
                updatedAt: Date.now()
            };
            renderProgress(playbackState.position, playbackState.duration);
            if (playbackState.isPlaying)
                startProgressAnimation();
            else
                stopProgressAnimation();
            setPlaybackControls(playbackState.isPlaying);
            if (source === 'external') {
                lastExternalUpdateTs = Date.now();
                lastAppliedTitle = String(info.title || '');
            }
        }
        function updateMusicInfo(data) {
            applyMusicInfo(normalizeMusicInfo(data), 'external');
        }
        function syncFromMediaSession() {
            var _a, _b;
            try {
                const metadata = (_a = navigator.mediaSession) === null || _a === void 0 ? void 0 : _a.metadata;
                if (!metadata)
                    return;
                const now = Date.now();
                if (now - lastExternalUpdateTs < 10000 && lastAppliedTitle)
                    return;
                const artworkArray = Array.isArray(metadata.artwork) ? metadata.artwork : [];
                const artworkSrc = ((_b = artworkArray.find(item => item === null || item === void 0 ? void 0 : item.src)) === null || _b === void 0 ? void 0 : _b.src) || "images/img.jpg";
                applyMusicInfo({
                    title: metadata.title || "—",
                    artist: metadata.artist || metadata.album || "",
                    artwork: artworkSrc,
                    position: 0,
                    duration: 0,
                    isPlaying: playbackState.isPlaying,
                    app: "Media Session"
                }, 'media-session');
            }
            catch (e) {
                warn("MediaSession sync failed", e);
            }
        }
        function stopMediaSessionSync() {
            if (mediaSessionTimer) {
                clearInterval(mediaSessionTimer);
                mediaSessionTimer = null;
            }
        }
        function startMediaSessionSync() {
            if (mediaSessionTimer || !("mediaSession" in navigator) || document.hidden)
                return;
            mediaSessionTimer = setInterval(syncFromMediaSession, 5000);
            syncFromMediaSession();
        }
        function handleVisibilityChange() {
            if (document.hidden) {
                stopMediaSessionSync();
                stopProgressAnimation();
            }
            else {
                startMediaSessionSync();
                startProgressAnimation();
                tickProgress();
            }
        }
        function init() {
            var _a, _b;
            (_a = document.getElementById("player__prev")) === null || _a === void 0 ? void 0 : _a.addEventListener("click", () => android.runEnum("MEDIA_BACK"));
            (_b = document.getElementById("player__next")) === null || _b === void 0 ? void 0 : _b.addEventListener("click", () => android.runEnum("MEDIA_NEXT"));
            if (toggleBtn) {
                toggleBtn.addEventListener("click", () => {
                    const nextIsPlaying = !playbackState.isPlaying;
                    if (nextIsPlaying) {
                        android.runEnum("MEDIA_PLAY");
                        playbackState.isPlaying = true;
                        playbackState.updatedAt = Date.now();
                        setPlaybackControls(true);
                        startProgressAnimation();
                    }
                    else {
                        android.runEnum("MEDIA_PAUSE");
                        playbackState.position = getLivePosition();
                        playbackState.isPlaying = false;
                        playbackState.updatedAt = Date.now();
                        setPlaybackControls(false);
                        stopProgressAnimation();
                        renderProgress(playbackState.position, playbackState.duration);
                    }
                });
            }
            else {
                playBtn === null || playBtn === void 0 ? void 0 : playBtn.addEventListener("click", () => {
                    android.runEnum("MEDIA_PLAY");
                    playbackState.isPlaying = true;
                    playbackState.updatedAt = Date.now();
                    setPlaybackControls(true);
                    startProgressAnimation();
                });
                pauseBtn === null || pauseBtn === void 0 ? void 0 : pauseBtn.addEventListener("click", () => {
                    android.runEnum("MEDIA_PAUSE");
                    playbackState.position = getLivePosition();
                    playbackState.isPlaying = false;
                    playbackState.updatedAt = Date.now();
                    setPlaybackControls(false);
                    stopProgressAnimation();
                    renderProgress(playbackState.position, playbackState.duration);
                });
            }
            const pressCover = () => {
                if (!coverEl)
                    return;
                coverEl.classList.remove('press-anim');
                requestAnimationFrame(() => coverEl.classList.add('press-anim'));
                window.setTimeout(() => coverEl === null || coverEl === void 0 ? void 0 : coverEl.classList.remove('press-anim'), 190);
            };
            coverEl === null || coverEl === void 0 ? void 0 : coverEl.addEventListener('click', () => {
                if ((swipeState === null || swipeState === void 0 ? void 0 : swipeState.moved) || (coverEl === null || coverEl === void 0 ? void 0 : coverEl.classList.contains('swipe-left')) || (coverEl === null || coverEl === void 0 ? void 0 : coverEl.classList.contains('swipe-right')))
                    return;
                pressCover();
            });
            if (coverEl) {
                coverEl.removeAttribute('tabindex');
                coverEl.removeAttribute('role');
                coverEl.removeAttribute('aria-label');
            }
            sourceEl === null || sourceEl === void 0 ? void 0 : sourceEl.addEventListener('click', () => {
                sourceEl.classList.remove('is-pressed');
                requestAnimationFrame(() => sourceEl.classList.add('is-pressed'));
                window.setTimeout(() => sourceEl === null || sourceEl === void 0 ? void 0 : sourceEl.classList.remove('is-pressed'), 160);
                openCurrentMusicSource();
            });
            sourceEl === null || sourceEl === void 0 ? void 0 : sourceEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    sourceEl.classList.remove('is-pressed');
                    requestAnimationFrame(() => sourceEl.classList.add('is-pressed'));
                    window.setTimeout(() => sourceEl === null || sourceEl === void 0 ? void 0 : sourceEl.classList.remove('is-pressed'), 160);
                    openCurrentMusicSource();
                }
            });
            attachCoverSwipes();
            attachTrackScrubbing();
            updatePlayerArtworkVisual('images/img.jpg');
            updateSourceChip('');
            setPlaybackControls(false);
            requestAnimationFrame(refreshTitleMarquee);
            window.addEventListener('resize', refreshTitleMarquee);
            document.addEventListener('visibilitychange', handleVisibilityChange);
            startMediaSessionSync();
        }
        return { updateMusicInfo, init, normalizeMusicInfo };
    })();
    // --- Климат (исправлен off для заднего правого) ---
    modules.climate = (function () {
        let climateCommands = [];
        const climateState = {};
        // Статический fallback-список с особым off для заднего правого
        const fallbackCommands = [
            { cmd: "heat_seat_l", label: "Подогрев\nводителя", max: 3, icon: "icons/Seat heated_left.svg" },
            { cmd: "heat_seat_r", label: "Подогрев\nпассажира", max: 3, icon: "icons/Seat heated_right.svg" },
            { cmd: "heat_windshield_on", label: "Подогрев\nлобового", max: 1, icon: "icons/Windshield defroster.svg" },
            { cmd: "heat_rearwindow_on", label: "Подогрев\nзаднего", max: 1, icon: "icons/Rare windshield defroster.svg" },
            { cmd: "vent_seat_l", label: "Вентиляция\nводителя", max: 3, icon: "icons/Seat vent_left.svg" },
            { cmd: "vent_seat_r", label: "Вентиляция\nпассажира", max: 3, icon: "icons/Seat vent_right.svg" },
            { cmd: "vent_zad_seat_l", label: "Вентиляция\nзад. лево", max: 3, icon: "icons/Seat vent_left.svg" },
            { cmd: "vent_zad_seat_r", label: "Вентиляция\nзад. право", max: 3, icon: "icons/Seat vent_right.svg" },
            { cmd: "sync", label: "SYNC", max: 1, icon: "icons/Sync.svg" },
            { cmd: "level", label: "Уровни", max: 3, icon: "icons/Levels.svg" },
            { cmd: "heat_wheel_on", label: "Подогрев\nруля", max: 1, icon: "icons/Steering wheel heat.svg" },
            { cmd: "heat_zad_seat_l", label: "Подогрев\nзад. лево", max: 3, icon: "icons/Seat heated_left.svg" },
            { cmd: "heat_zad_seat_r", label: "Подогрев\nзад. право", max: 3, icon: "icons/Seat heated_right.svg", off: "heat_zad_seat_r_off" },
            { cmd: "voditel_seat_1", label: "Память\nводитель 1", max: 1, icon: "icons/Driver.svg" },
            { cmd: "voditel_seat_2", label: "Память\nводитель 2", max: 1, icon: "icons/Driver.svg" },
            { cmd: "voditel_seat_3", label: "Память\nводитель 3", max: 1, icon: "icons/Driver.svg" },
        ];
        function formatLabel(cmd) {
            if (cmd === 'sync' || cmd.startsWith('sync_'))
                return 'SYNC';
            if (cmd === 'level' || cmd.startsWith('level_'))
                return 'Уровни';
            if (cmd.includes('vent_zad_seat_l'))
                return 'Вентиляция\nзад. лево';
            if (cmd.includes('vent_zad_seat_r'))
                return 'Вентиляция\nзад. право';
            if (cmd.includes('heat_zad_seat_l'))
                return 'Подогрев\nзад. лево';
            if (cmd.includes('heat_zad_seat_r'))
                return 'Подогрев\nзад. право';
            if (cmd.includes('vent_seat_l') || cmd.includes('vent_l'))
                return 'Вентиляция\nводителя';
            if (cmd.includes('vent_seat_r') || cmd.includes('vent_r'))
                return 'Вентиляция\nпассажира';
            if (cmd.includes('heat_seat_l') || cmd.includes('seat_l'))
                return 'Подогрев\nводителя';
            if (cmd.includes('heat_seat_r') || cmd.includes('seat_r'))
                return 'Подогрев\nпассажира';
            if (cmd.includes('windshield'))
                return 'Подогрев\nлобового';
            if (cmd.includes('rearwindow'))
                return 'Подогрев\nзаднего';
            if (cmd.includes('wheel'))
                return 'Подогрев\nруля';
            if (cmd.includes('voditel_1'))
                return 'Память\nводитель 1';
            if (cmd.includes('voditel_2'))
                return 'Память\nводитель 2';
            if (cmd.includes('voditel_3'))
                return 'Память\nводитель 3';
            return cmd;
        }
        async function loadCommands() {
            try {
                const listJson = android.getRunEnum();
                log("Climate commands JSON:", listJson);
                let all = [];
                try {
                    all = safeParseJson(listJson, []);
                }
                catch (parseError) {
                    warn("Failed to parse climate commands, using fallback", parseError);
                    climateCommands = fallbackCommands.map(c => (Object.assign({}, c))); // копируем
                    return;
                }
                const filtered = all.filter(cmd => cmd.startsWith('heat_') || cmd.startsWith('vent_') || cmd.startsWith('voditel_') || cmd.startsWith('sync') || cmd.startsWith('level'));
                if (filtered.length === 0) {
                    warn("No climate commands found from API, using fallback");
                    climateCommands = fallbackCommands.map(c => (Object.assign({}, c)));
                    return;
                }
                climateCommands = filtered.map(cmd => {
                    const base = {
                        cmd,
                        label: formatLabel(cmd),
                        max: (cmd.includes('seat') || cmd.includes('level')) ? 3 : 1
                    };
                    // Добавляем особый off для заднего правого
                    if (cmd === 'heat_zad_seat_r')
                        base.off = 'heat_zad_seat_r_off';
                    return base;
                });
                // Загружаем иконки
                for (let c of climateCommands) {
                    if (!c.icon) {
                        if (c.cmd.includes('vent_zad_seat_l'))
                            c.icon = 'icons/Seat vent_left.svg';
                        else if (c.cmd.includes('vent_zad_seat_r'))
                            c.icon = 'icons/Seat vent_right.svg';
                        else if (c.cmd.includes('sync'))
                            c.icon = 'icons/Sync.svg';
                        else if (c.cmd.includes('level'))
                            c.icon = 'icons/Levels.svg';
                    }
                    try {
                        const pic = android.getRunEnumPic(c.cmd);
                        c.icon = pic ? `data:image/png;base64,${pic}` : (c.icon || 'icons/Default.svg');
                    }
                    catch (_a) {
                        c.icon = c.icon || 'icons/Default.svg';
                    }
                }
                log("Loaded climate commands:", climateCommands);
            }
            catch (e) {
                warn("Error loading climate commands, using fallback", e);
                climateCommands = fallbackCommands.map(c => (Object.assign({}, c)));
            }
        }
        // Получить команду выключения для заданного cmd
        function getOffCommand(cmdObj) {
            if (cmdObj.off)
                return cmdObj.off;
            return `${cmdObj.cmd}_0`;
        }
        function renderSlot(slot) {
            const slotId = slot.dataset.climateSlot;
            const savedCmd = storage.load(`climate_slot_${slotId}`);
            slot.replaceChildren();
            if (!savedCmd) {
                const plus = document.createElement('span');
                plus.style.fontSize = '1.5rem';
                plus.style.opacity = '0.5';
                plus.textContent = '+';
                slot.appendChild(plus);
                slot.classList.remove('active');
                return;
            }
            const cmdObj = climateCommands.find(c => c.cmd === savedCmd);
            if (!cmdObj) {
                localStorage.removeItem(`climate_slot_${slotId}`);
                const plus = document.createElement('span');
                plus.style.fontSize = '1.5rem';
                plus.style.opacity = '0.5';
                plus.textContent = '+';
                slot.appendChild(plus);
                slot.classList.remove('active');
                return;
            }
            const level = climateState[savedCmd] || 0;
            const max = cmdObj.max || 1;
            const img = document.createElement('img');
            img.src = cmdObj.icon || 'icons/Default.svg';
            img.alt = String(cmdObj.label || '').replace(/\n/g, ' ');
            const label = document.createElement('div');
            label.className = 'climate-label';
            const labelLines = String(cmdObj.label || '').split('\n');
            labelLines.forEach((line, index) => {
                if (index > 0)
                    label.appendChild(document.createElement('br'));
                label.appendChild(document.createTextNode(line));
            });
            const dotsWrap = document.createElement('div');
            dotsWrap.className = 'climate-dots';
            for (let i = 0; i < max; i += 1) {
                const dot = document.createElement('span');
                dot.className = `climate-dot${i < level ? ' on' : ''}`;
                dotsWrap.appendChild(dot);
            }
            slot.append(img, label, dotsWrap);
            slot.classList.toggle('active', level > 0);
        }
        let climateOff = false;
        let lastActiveSnapshot = storage.load("climate_last_snapshot") || null;
        function hasAnyActiveClimate() {
            return Object.keys(climateState).some(key => (climateState[key] || 0) > 0);
        }
        function hasAssignedClimateSlots() {
            for (let i = 1; i <= 4; i++) {
                if (storage.load(`climate_slot_${i}`))
                    return true;
            }
            return false;
        }
        function captureClimateSnapshot() {
            const snapshot = {};
            for (let i = 1; i <= 4; i++) {
                const savedCmd = storage.load(`climate_slot_${i}`);
                if (!savedCmd)
                    continue;
                const level = climateState[savedCmd] || 0;
                if (level > 0)
                    snapshot[savedCmd] = level;
            }
            return Object.keys(snapshot).length ? snapshot : null;
        }
        function persistClimateOffState() {
            storage.save("climate_is_off", climateOff);
            storage.save("climate_last_snapshot", lastActiveSnapshot);
        }
        function updateClimateResetButton() {
            const resetBtn = document.getElementById("climateOffAll");
            const widget = document.querySelector('.widget_climate');
            if (!resetBtn)
                return;
            const hasActive = hasAnyActiveClimate();
            if (!hasActive && !climateOff)
                climateOff = true;
            if (hasActive)
                climateOff = false;
            resetBtn.classList.toggle("inactive", climateOff);
            resetBtn.classList.toggle("is-off", climateOff);
            widget === null || widget === void 0 ? void 0 : widget.classList.toggle("climate-is-off", climateOff);
            resetBtn.setAttribute("aria-label", climateOff ? "Включить климат" : "Выключить всё");
            resetBtn.textContent = climateOff ? "⏻" : "×";
            persistClimateOffState();
        }
        function updateAllSlots() {
            document.querySelectorAll(".climate_slot").forEach(renderSlot);
            updateClimateResetButton();
        }
        function requestStatusForCommand(cmd) {
            android.requestClimateStateForCommand(cmd);
        }
        function syncFromCar() {
            var _a;
            const activeCmds = new Set();
            for (let i = 1; i <= 4; i++) {
                const cmd = storage.load(`climate_slot_${i}`);
                if (cmd)
                    activeCmds.add(cmd);
            }
            if ((_a = window.androidApi) === null || _a === void 0 ? void 0 : _a.requestClimateState) {
                android.requestClimateState();
            }
            else {
                activeCmds.forEach(cmd => requestStatusForCommand(cmd));
            }
        }
        let climateFadeOffTimer = null;
        function restoreLastClimateState() {
            if (!lastActiveSnapshot)
                return false;
            const entries = Object.entries(lastActiveSnapshot).filter(([, level]) => Number(level) > 0);
            if (!entries.length)
                return false;
            entries.forEach(([cmd, level]) => {
                const cmdObj = climateCommands.find(c => c.cmd === cmd);
                if (!cmdObj)
                    return;
                climateState[cmd] = level;
                const max = cmdObj.max || 1;
                const cmdToSend = max > 1 ? `${cmd}_${Math.min(level, max)}` : cmd;
                android.runEnum(cmdToSend);
            });
            climateOff = false;
            updateAllSlots();
            return true;
        }
        function turnOffAll(event) {
            var _a, _b;
            (_a = event === null || event === void 0 ? void 0 : event.preventDefault) === null || _a === void 0 ? void 0 : _a.call(event);
            (_b = event === null || event === void 0 ? void 0 : event.stopPropagation) === null || _b === void 0 ? void 0 : _b.call(event);
            const widget = document.querySelector('.widget_climate');
            const activeSlots = Array.from(document.querySelectorAll('.climate_slot.active'));
            const hasActive = activeSlots.length > 0;
            if (climateFadeOffTimer) {
                clearTimeout(climateFadeOffTimer);
                climateFadeOffTimer = null;
            }
            if (!hasActive) {
                if (restoreLastClimateState())
                    return;
                climateOff = true;
                updateAllSlots();
                return;
            }
            lastActiveSnapshot = captureClimateSnapshot();
            widget === null || widget === void 0 ? void 0 : widget.classList.add('climate-off-transition');
            activeSlots.forEach(slot => slot.classList.add('climate-fading-off'));
            const finalizeOff = () => {
                for (let i = 1; i <= 4; i++) {
                    const savedCmd = storage.load(`climate_slot_${i}`);
                    if (!savedCmd)
                        continue;
                    const cmdObj = climateCommands.find(c => c.cmd === savedCmd);
                    if (!cmdObj)
                        continue;
                    const offCmd = getOffCommand(cmdObj);
                    android.runEnum(offCmd);
                    climateState[savedCmd] = 0;
                }
                climateOff = true;
                document.querySelectorAll('.climate_slot.climate-fading-off').forEach(slot => slot.classList.remove('climate-fading-off'));
                widget === null || widget === void 0 ? void 0 : widget.classList.remove('climate-off-transition');
                updateAllSlots();
            };
            climateFadeOffTimer = setTimeout(() => {
                climateFadeOffTimer = null;
                finalizeOff();
            }, 180);
        }
        function updateState(data) {
            var _a;
            data = safeParseJson(data, {}) || {};
            for (let key in data) {
                let value = data[key];
                const match = key.match(/^(.+)_(\d+)$/);
                if (match) {
                    const baseCmd = match[1];
                    const level = parseInt(match[2], 10);
                    const cmdObj = climateCommands.find(c => c.cmd === baseCmd);
                    if (cmdObj) {
                        climateState[baseCmd] = level;
                        continue;
                    }
                }
                // Обработка специального off для заднего правого (если пришло heat_zad_seat_r_off)
                if (key === 'heat_zad_seat_r_off') {
                    climateState['heat_zad_seat_r'] = 0;
                    continue;
                }
                const cmdObj = climateCommands.find(c => c.cmd === key);
                if (cmdObj)
                    climateState[key] = value;
            }
            if (hasAnyActiveClimate()) {
                climateOff = false;
            }
            else if (hasAssignedClimateSlots()) {
                climateOff = (_a = storage.load("climate_is_off")) !== null && _a !== void 0 ? _a : climateOff;
            }
            updateAllSlots();
        }
        let openClimatePickerForSlot = null;
        function initPicker() {
            const picker = document.getElementById("climate-picker");
            const grid = document.getElementById("climate-picker-grid");
            const close = document.getElementById("climate-picker-close");
            let curSlotId = null;
            function openPicker(slotId) {
                curSlotId = slotId;
                grid.replaceChildren();
                if (climateCommands.length === 0) {
                    grid.appendChild(createInfoMessage('Нет доступных функций'));
                    picker.classList.add('open');
                    return;
                }
                climateCommands.forEach(cmd => {
                    const d = document.createElement('div');
                    d.className = 'picker-item';
                    const img = document.createElement('img');
                    img.src = cmd.icon || 'icons/Default.svg';
                    img.alt = String(cmd.label || '').replace(/\n/g, ' ');
                    const span = document.createElement('span');
                    span.textContent = String(cmd.label || '').replace(/\n/g, ' ');
                    d.append(img, span);
                    d.onclick = () => {
                        storage.save(`climate_slot_${curSlotId}`, cmd.cmd);
                        climateState[cmd.cmd] = 0;
                        updateAllSlots();
                        picker.classList.remove('open');
                        requestStatusForCommand(cmd.cmd);
                    };
                    grid.appendChild(d);
                });
                picker.classList.add('open');
            }
            openClimatePickerForSlot = openPicker;
            const closePicker = () => picker.classList.remove("open");
            close === null || close === void 0 ? void 0 : close.addEventListener("click", closePicker);
            picker.addEventListener("click", e => {
                if (e.target === picker)
                    closePicker();
            });
            let swipeStartY = 0;
            let swipeCurrentY = 0;
            let swipeStartX = 0;
            let dragging = false;
            let tracking = false;
            let moved = false;
            const resetSwipe = () => {
                tracking = false;
                dragging = false;
                moved = false;
                swipeStartY = 0;
                swipeCurrentY = 0;
                swipeStartX = 0;
                picker.style.transition = '';
                picker.style.transform = '';
            };
            picker.addEventListener('touchstart', (e) => {
                if (!picker.classList.contains('open') || !e.touches || e.touches.length !== 1) return;
                swipeStartY = e.touches[0].clientY;
                swipeCurrentY = swipeStartY;
                swipeStartX = e.touches[0].clientX;
                tracking = true;
                dragging = false;
                moved = false;
                picker.style.transition = 'none';
            }, { passive: true });
            picker.addEventListener('touchmove', (e) => {
                if (!tracking || !e.touches || e.touches.length !== 1) return;
                swipeCurrentY = e.touches[0].clientY;
                const deltaY = swipeCurrentY - swipeStartY;
                const deltaX = e.touches[0].clientX - swipeStartX;
                if (!dragging) {
                    if (Math.abs(deltaY) < 8 && Math.abs(deltaX) < 8) return;
                    if (deltaY > 0 && Math.abs(deltaY) > Math.abs(deltaX)) {
                        dragging = true;
                    } else {
                        tracking = false;
                        picker.style.transition = '';
                        return;
                    }
                }
                moved = true;
                const translateY = Math.max(0, deltaY);
                picker.style.transform = `translate3d(0, ${translateY}px, 0)`;
                e.preventDefault();
            }, { passive: false });
            picker.addEventListener('touchend', () => {
                if (!tracking && !dragging) return;
                const deltaY = swipeCurrentY - swipeStartY;
                picker.style.transition = '';
                if (dragging && moved && deltaY > 80) {
                    closePicker();
                }
                resetSwipe();
            });
            picker.addEventListener('touchcancel', resetSwipe);
            document.querySelectorAll(".climate_slot").forEach(slot => {
                const slotId = slot.dataset.climateSlot;
                makeLongPressable(slot, () => openPicker(slotId), { delay: 700 });
                slot.addEventListener('click', (e) => {
                    if (e.detail === 0)
                        return;
                    const savedCmd = storage.load(`climate_slot_${slotId}`);
                    if (!savedCmd) {
                        openPicker(slotId);
                        return;
                    }
                    const cmdObj = climateCommands.find(c => c.cmd === savedCmd);
                    if (!cmdObj)
                        return;
                    const max = cmdObj.max || 1;
                    const current = climateState[savedCmd] || 0;
                    const next = (current + 1) % (max + 1);
                    climateState[savedCmd] = next;
                    if (next > 0) {
                        climateOff = false;
                    }
                    else if (!hasAnyActiveClimate()) {
                        climateOff = true;
                    }
                    let cmdToSend;
                    if (next === 0) {
                        cmdToSend = getOffCommand(cmdObj);
                    }
                    else {
                        cmdToSend = max > 1 ? `${savedCmd}_${next}` : savedCmd;
                    }
                    android.runEnum(cmdToSend);
                    updateAllSlots();
                });
            });
        }
        function bindResetButton() {
            const resetBtn = document.getElementById("climateOffAll");
            if (!resetBtn)
                return;
            const freshResetBtn = resetBtn.cloneNode(true);
            resetBtn.replaceWith(freshResetBtn);
            freshResetBtn.addEventListener("click", turnOffAll);
        }
        function ensureDefaultSlots() {
            const hasAssignedSlots = [1, 2, 3, 4].some(i => !!storage.load(`climate_slot_${i}`));
            if (hasAssignedSlots)
                return;
            const preferred = ["vent_zad_seat_l", "vent_zad_seat_r", "sync", "level"];
            const fallback = ["vent_seat_l", "vent_seat_r", "heat_windshield_on", "heat_rearwindow_on"];
            const pool = [...preferred, ...fallback];
            for (let i = 0; i < 4; i++) {
                const match = pool.find(cmd => climateCommands.some(c => c.cmd === cmd));
                if (!match)
                    continue;
                storage.save(`climate_slot_${i + 1}`, match);
                pool.splice(pool.indexOf(match), 1);
            }
        }
        async function init() {
            await loadCommands();
            climateOff = !!storage.load("climate_is_off");
            lastActiveSnapshot = storage.load("climate_last_snapshot") || lastActiveSnapshot;
            ensureDefaultSlots();
            initPicker();
            updateAllSlots();
            syncFromCar();
            bindResetButton();
        }
        return {
            init,
            updateState,
            openPickerForSlot(slotId = "1") {
                if (typeof openClimatePickerForSlot === 'function') {
                    openClimatePickerForSlot(String(slotId || "1"));
                }
            }
        };
    })();
    // --- Погода ---
    modules.weather = (function () {
        const drawer = document.getElementById("weather-drawer");
        const closeBtn = document.getElementById("weather-drawer-close");
        const els = {
            temp: document.getElementById("weather-temp"),
            status: document.getElementById("weather-status"),
            feels: document.getElementById("weather-feels"),
            wind: document.getElementById("weather-wind"),
            humidity: document.getElementById("weather-humidity"),
            rain: document.getElementById("weather-rain"),
            updated: document.getElementById("weather-updated"),
            location: document.getElementById("weather-location"),
            icon: document.getElementById("weather-icon"),
        };
        const DEFAULT_LOCATION = {
            latitude: 56.4977,
            longitude: 84.9744,
            label: "Томск"
        };
        const WEATHER_CODES = {
            0: "Ясно", 1: "Преимущественно ясно", 2: "Переменная облачность", 3: "Пасмурно",
            45: "Туман", 48: "Изморозь", 51: "Слабая морось", 53: "Морось", 55: "Сильная морось",
            61: "Слабый дождь", 63: "Дождь", 65: "Сильный дождь", 66: "Ледяной дождь", 67: "Сильный ледяной дождь",
            71: "Слабый снег", 73: "Снег", 75: "Сильный снег", 77: "Снежные зёрна",
            80: "Ливень", 81: "Ливень", 82: "Сильный ливень", 85: "Снегопад", 86: "Сильный снегопад",
            95: "Гроза", 96: "Гроза с градом", 99: "Сильная гроза с градом"
        };
        let lastLoadedAt = 0;
        let lastCoordsKey = '';
        let lastResolvedLocation = { ...DEFAULT_LOCATION };
        function buildWeatherUrl(latitude, longitude) {
            return `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto`;
        }
        function setLoading() {
            if (els.status) els.status.textContent = "Загрузка…";
            if (els.updated) els.updated.textContent = "Обновляем данные…";
        }
        function setLocationLabel(value) {
            if (els.location) els.location.textContent = value || "Текущее местоположение";
        }
        function formatTemp(value) {
            return Number.isFinite(value) ? `${Math.round(value)}°` : "--°";
        }
        function formatWind(value) {
            return Number.isFinite(value) ? `${Math.round(value)} м/с` : "--";
        }
        function formatPercent(value) {
            return Number.isFinite(value) ? `${Math.round(value)}%` : "--";
        }
        function formatRain(value) {
            return Number.isFinite(value) ? `${value.toFixed(1)} мм` : "--";
        }

        function getWeatherIcon(code) {
            if ([0, 1].includes(code)) return "☀️";
            if ([2].includes(code)) return "⛅";
            if ([3].includes(code)) return "☁️";
            if ([45, 48].includes(code)) return "🌫️";
            if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
            if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
            if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
            if ([95, 96, 99].includes(code)) return "⛈️";
            return "☁️";
        }
        function getDayShort(dateText) {
            try {
                const date = new Date(dateText);
                return ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][date.getDay()] || "";
            } catch (e) {
                return "";
            }
        }
        function renderDays(data) {
            const container = document.getElementById("weather-days-forecast");
            if (!container) return;
            const daily = data && data.daily ? data.daily : null;
            if (!daily || !daily.time || !daily.time.length) {
                container.innerHTML = "";
                return;
            }
            const days = daily.time.slice(0, 4).map((day, index) => {
                const code = daily.weather_code && Number.isFinite(daily.weather_code[index]) ? daily.weather_code[index] : null;
                const max = daily.temperature_2m_max && Number.isFinite(daily.temperature_2m_max[index]) ? Math.round(daily.temperature_2m_max[index]) : null;
                const min = daily.temperature_2m_min && Number.isFinite(daily.temperature_2m_min[index]) ? Math.round(daily.temperature_2m_min[index]) : null;
                const desc = code != null ? (WEATHER_CODES[code] || "Погода") : "Погода";
                return `
                  <div class="weather-day">
                    <div class="weather-day__icon">${getWeatherIcon(code)}</div>
                    <div>
                      <div class="weather-day__name">${getDayShort(day)}</div>
                      <div class="weather-day__desc">${desc}</div>
                    </div>
                    <div class="weather-day__temp">${max != null ? max + "°" : "--"}<span class="weather-day__temp-min">${min != null ? min + "°" : "--"}</span></div>
                  </div>
                `;
            });
            container.innerHTML = days.join("");
        }
        function coordsKey(latitude, longitude) {
            return `${Number(latitude).toFixed(3)},${Number(longitude).toFixed(3)}`;
        }
        function resolveGeoPosition() {
            return new Promise((resolve) => {
                if (!navigator.geolocation) {
                    resolve({ ...DEFAULT_LOCATION, isFallback: true });
                    return;
                }
                navigator.geolocation.getCurrentPosition((position) => {
                    resolve({
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude,
                        label: "Текущее местоположение",
                        isFallback: false
                    });
                }, () => {
                    resolve({ ...DEFAULT_LOCATION, isFallback: true });
                }, {
                    enableHighAccuracy: false,
                    timeout: 7000,
                    maximumAge: 10 * 60 * 1000
                });
            });
        }
        async function resolveLocationName(latitude, longitude, fallbackLabel) {
            try {
                const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&zoom=10&accept-language=ru`;
                const response = await fetch(url, {
                    cache: 'no-store',
                    headers: { 'Accept': 'application/json' }
                });
                if (!response.ok) throw new Error(`Reverse ${response.status}`);
                const data = await response.json();
                const address = data && data.address ? data.address : null;
                const label = (address && (address.city || address.town || address.village || address.municipality || address.state)) || fallbackLabel;
                return label || "Текущее местоположение";
            }
            catch (e) {
                return fallbackLabel || "Текущее местоположение";
            }
        }
        function render(data) {
            const current = data && data.current ? data.current : null;
            if (!current) throw new Error("No current weather");
            if (els.temp) els.temp.textContent = formatTemp(current.temperature_2m);
            if (els.status) els.status.textContent = WEATHER_CODES[current.weather_code] || "Погода";
            if (els.icon) els.icon.textContent = getWeatherIcon(current.weather_code);
            const attentionWeather = document.getElementById("attention-weather");
            if (attentionWeather) {
                const code = current.weather_code;
                const icon = getWeatherIcon(code);
                const text = WEATHER_CODES[code] || "Погода";
                attentionWeather.textContent = `${icon} ${text}`;
            }
            if (els.feels) els.feels.textContent = formatTemp(current.apparent_temperature);
            if (els.wind) els.wind.textContent = formatWind(current.wind_speed_10m);
            if (els.humidity) els.humidity.textContent = formatPercent(current.relative_humidity_2m);
            if (els.rain) els.rain.textContent = formatRain(current.precipitation);
            if (els.updated) {
                const ts = current.time ? new Date(current.time) : new Date();
                els.updated.textContent = `Обновлено: ${ts.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}`;
            }
            renderDays(data);
        }
        async function refresh(force = false) {
            const location = await resolveGeoPosition();
            const currentCoordsKey = coordsKey(location.latitude, location.longitude);
            const sameCoords = currentCoordsKey === lastCoordsKey;
            if (!force && sameCoords && Date.now() - lastLoadedAt < 5 * 60 * 1000) {
                setLocationLabel(lastResolvedLocation.label);
                return;
            }
            setLoading();
            setLocationLabel(location.isFallback ? DEFAULT_LOCATION.label : "Определяем местоположение…");
            try {
                const response = await fetch(buildWeatherUrl(location.latitude, location.longitude), { cache: 'no-store' });
                if (!response.ok) throw new Error(`Weather ${response.status}`);
                const data = await response.json();
                render(data);
                const resolvedLabel = location.isFallback
                    ? DEFAULT_LOCATION.label
                    : await resolveLocationName(location.latitude, location.longitude, location.label);
                lastResolvedLocation = {
                    latitude: location.latitude,
                    longitude: location.longitude,
                    label: resolvedLabel
                };
                setLocationLabel(resolvedLabel);
                lastCoordsKey = currentCoordsKey;
                lastLoadedAt = Date.now();
            }
            catch (e) {
                if (els.status) els.status.textContent = "Не удалось загрузить погоду";
                if (els.updated) els.updated.textContent = "Проверьте подключение к интернету";
                setLocationLabel(location.isFallback ? DEFAULT_LOCATION.label : "Текущее местоположение");
                const attentionWeather = document.getElementById("attention-weather");
                if (attentionWeather) attentionWeather.textContent = navigator.onLine ? "Погода недоступна" : "Нет сети";
            }
        }

        async function refreshByCoords(latitude, longitude, label = "Текущее местоположение", force = false) {
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
                return;
            const currentCoordsKey = coordsKey(latitude, longitude);
            const sameCoords = currentCoordsKey === lastCoordsKey;
            if (!force && sameCoords && Date.now() - lastLoadedAt < 5 * 60 * 1000) {
                setLocationLabel(lastResolvedLocation.label || label);
                return;
            }
            setLoading();
            setLocationLabel(label);
            try {
                const response = await fetch(buildWeatherUrl(latitude, longitude), { cache: 'no-store' });
                if (!response.ok) throw new Error(`Weather ${response.status}`);
                const data = await response.json();
                render(data);
                const resolvedLabel = await resolveLocationName(latitude, longitude, label);
                lastResolvedLocation = { latitude, longitude, label: resolvedLabel };
                setLocationLabel(resolvedLabel);
                lastCoordsKey = currentCoordsKey;
                lastLoadedAt = Date.now();
            }
            catch (e) {
                if (els.status) els.status.textContent = "Не удалось загрузить погоду";
                if (els.updated) els.updated.textContent = "Проверьте подключение к интернету";
                setLocationLabel(label);
            }
        }

        function open() {
            drawer?.classList.add('open');
            refresh(false);
        }
        function close() {
            drawer?.classList.remove('open');
        }
        function init() {
            setLocationLabel(DEFAULT_LOCATION.label);
            closeBtn?.addEventListener('click', close);
            drawer?.addEventListener('click', (e) => { if (e.target === drawer) close(); });
            let swipeStartY = 0;
            let swipeCurrentY = 0;
            let swipeStartX = 0;
            let dragging = false;
            let tracking = false;
            let moved = false;
            const resetSwipe = () => {
                tracking = false;
                dragging = false;
                moved = false;
                swipeStartY = 0;
                swipeCurrentY = 0;
                swipeStartX = 0;
                if (drawer) {
                    drawer.style.transition = '';
                    drawer.style.transform = '';
                }
            };
            drawer?.addEventListener('touchstart', (e) => {
                if (!drawer.classList.contains('open') || !e.touches || e.touches.length !== 1) return;
                swipeStartY = e.touches[0].clientY;
                swipeCurrentY = swipeStartY;
                swipeStartX = e.touches[0].clientX;
                tracking = true;
                dragging = false;
                moved = false;
                drawer.style.transition = 'none';
            }, { passive: true });
            drawer?.addEventListener('touchmove', (e) => {
                if (!tracking || !e.touches || e.touches.length !== 1) return;
                swipeCurrentY = e.touches[0].clientY;
                const deltaY = swipeCurrentY - swipeStartY;
                const deltaX = e.touches[0].clientX - swipeStartX;
                if (!dragging) {
                    if (Math.abs(deltaY) < 8 && Math.abs(deltaX) < 8) return;
                    if (deltaY > 0 && Math.abs(deltaY) > Math.abs(deltaX)) {
                        dragging = true;
                    } else {
                        tracking = false;
                        drawer.style.transition = '';
                        return;
                    }
                }
                moved = true;
                const translateY = Math.max(0, deltaY);
                drawer.style.transform = `translate3d(0, ${translateY}px, 0)`;
                e.preventDefault();
            }, { passive: false });
            drawer?.addEventListener('touchend', () => {
                if (!tracking && !dragging) return;
                const deltaY = swipeCurrentY - swipeStartY;
                drawer.style.transition = '';
                if (dragging && moved && deltaY > 80) {
                    close();
                }
                resetSwipe();
            });
            drawer?.addEventListener('touchcancel', () => {
                resetSwipe();
            });
        }
        return { init, open, close, refresh, refreshByCoords };
    })();

    // --- Внимание ---
    
    modules.hudNavigation = (function () {
        const drawer = document.getElementById("hudnav-drawer");
        const closeBtn = document.getElementById("hudnav-drawer-close");
        const btnFinish = document.getElementById("btn-navi-finish");
        const btnOpenMaps = document.getElementById("btn-open-yandex-maps");
        const TURN_ICONS = {
          2:'icons/navi/turn_2_left.svg',3:'icons/navi/turn_3_right.svg',4:'icons/navi/turn_4_fork_left.svg',
          5:'icons/navi/turn_5_fork_right.svg',6:'icons/navi/turn_6_hard_left.svg',7:'icons/navi/turn_7_hard_right.svg',
          8:'icons/navi/turn_8_uturn_left.svg',9:'icons/navi/turn_9_straight.svg',15:'icons/navi/turn_15_finish.svg',
          19:'icons/navi/turn_19_uturn_right.svg',24:'icons/navi/turn_24_roundabout.svg',49:'icons/navi/turn_49_straight.svg',
          55:'icons/navi/turn_55_roundabout_exit.svg'
        };
        let maxRemain = 0;
        let active = false;
        function el(id){ return document.getElementById(id); }
        function isActive(){ return active; }
        function close(){ drawer?.classList.remove("open"); }
        function open(){ drawer?.classList.add("open"); }
        function reset(){
          maxRemain = 0;
          active = false;
          if (el('navi-active')) el('navi-active').style.display = 'none';
          if (el('navi-inactive')) el('navi-inactive').style.display = '';
          if (el('navi-route-fill')) el('navi-route-fill').style.width = '0%';
          if (el('navi-car')) el('navi-car').style.left = '0%';
          el('navi-arrow')?.classList.remove('pulse');
          if (el('navi-finish-row')) el('navi-finish-row').style.display = 'none';
          if (el('navi-eta-row')) el('navi-eta-row').style.display = '';
        }
        function handleNaviData(data = {}) {
          active = !!data.naviOn;
          if (el('navi-active')) el('navi-active').style.display = active ? '' : 'none';
          if (el('navi-inactive')) el('navi-inactive').style.display = active ? 'none' : '';
          if (!active) {
            reset();
            if (drawer?.classList.contains('open')) {
              close();
              modules.attention?.open();
            }
            return;
          }
          if (document.getElementById('attention-drawer')?.classList.contains('open')) {
            modules.attention?.close();
            open();
          }
          const turnType = Number(data.turnType) || 9;
          const iconSrc = TURN_ICONS[turnType] || TURN_ICONS[9];
          const turnDist = parseInt(data.turnDist, 10) || 0;
          const isFinish = turnType === 15;
          const imgEl = el('navi-arrow-img');
          if (imgEl) imgEl.src = iconSrc;
          if (el('navi-finish-row')) el('navi-finish-row').style.display = isFinish ? '' : 'none';
          if (el('navi-eta-row')) el('navi-eta-row').style.display = isFinish ? 'none' : '';
          if (isFinish) {
            if (el('navi-route-fill')) el('navi-route-fill').style.width = '100%';
            if (el('navi-car')) el('navi-car').style.left = 'calc(100% - 20px)';
            return;
          }
          if (el('navi-distance')) el('navi-distance').textContent = turnDist >= 1000 ? (turnDist / 1000).toFixed(1) + ' км' : turnDist + ' м';
          if (el('navi-street')) el('navi-street').textContent = data.nextRoad || '—';
          const remainNum = parseFloat(String(data.remainDist || '0').replace(/[^\d.]/g, '')) || 0;
          if (el('navi-remain')) el('navi-remain').textContent = remainNum >= 1000 ? (remainNum / 1000).toFixed(1) + ' км' : remainNum + ' м';
          const speedSign = el('navi-speed-sign');
          if (data.speedLimit && Number(data.speedLimit) > 0) {
            if (speedSign) speedSign.style.display = 'flex';
            if (el('navi-speed-limit')) el('navi-speed-limit').textContent = String(data.speedLimit);
            if (el('navi-eta')) el('navi-eta').textContent = String(data.speedLimit) + ' км/ч';
          } else {
            if (speedSign) speedSign.style.display = 'none';
            if (el('navi-eta')) el('navi-eta').textContent = '—';
          }
          if (turnDist < 150) el('navi-arrow')?.classList.add('pulse'); else el('navi-arrow')?.classList.remove('pulse');
          if (!maxRemain || remainNum > maxRemain) maxRemain = remainNum;
          const pct = maxRemain > 0 ? Math.max(0, Math.min(100, (1 - remainNum / maxRemain) * 100)) : 0;
          if (el('navi-route-fill')) el('navi-route-fill').style.width = pct + '%';
          if (el('navi-car')) el('navi-car').style.left = `calc(${pct}% - 10px)`;
        }
        function init(){
          closeBtn?.addEventListener('click', close);
          btnFinish?.addEventListener('click', () => handleNaviData({ naviOn:false }));
          btnOpenMaps?.addEventListener('click', () => {
            if (window.Android && typeof Android.openApp === 'function') {
              Android.openApp('ru.yandex.yandexmaps'); return;
            }
            window.location.href = 'yandexmaps://maps.yandex.ru/';
          });
          window.handleNaviData = handleNaviData;
          reset();
        }
        return { init, open, close, handleNaviData, isActive };
    })();

modules.attention = (function () {
        const drawer = document.getElementById("attention-drawer");
        const closeBtn = document.getElementById("attention-drawer-close");
        const button = document.getElementById("btnAttention");
        const status = document.getElementById("attention-status");
        const details = document.getElementById("attention-details");
        const stateValue = document.getElementById("attention-state-value");
        const stateItem = document.getElementById("attention-state-item");
        const speedValue = document.getElementById("attention-speed-value");
        const speedItem = document.getElementById("attention-speed-item");
        const speedLimit = document.getElementById("attention-speed-limit");
        const pointsValue = document.getElementById("attention-points-value");
        const pointsItem = document.getElementById("attention-points-item");
        const gpsValue = document.getElementById("attention-gps-value");
        const gpsDirection = document.getElementById("attention-gps-direction");
        const gpsItem = document.getElementById("attention-gps-item");
        const driveTime = document.getElementById("attention-drive-time");
        const eventBox = document.getElementById("attention-event");
        let watchId = null;
        let lastResolvedRoadMode = "Стоянка";
        let lastGpsGoodAt = 0;
        let driveStartAt = null;
        let currentEventTimer = null;
        let detailsTimer = null;
        let lastEventLabel = "";
        let currentMainStatus = { text: "—", visual: "normal" };
        let pendingMainStatus = null;
        let pendingMainStatusTimer = null;
        let eventHoldUntil = 0;
        const STATE_CONFIRM_MS = 420;
        const EVENT_HOLD_MS = 1800;
        const GPS_MODE_HOLD_MS = 15000;
        const STATUS_PRIORITY = {
            "Торможение": 5,
            "Сбавь скорость": 5,
            "Резкий разгон": 4,
            "Плотный поток": 3,
            "Нестабильно": 3,
            "Частые остановки": 3,
            "Движение": 1,
            "Стоянка": 1,
            "Стабильно": 0,
            "Норма": 0,
            "—": 0
        };
        let statusHoldUntil = 0;
        const STATUS_HOLD_MS = 1700;
        function getStatusPriority(text) {
            return STATUS_PRIORITY[text] ?? 0;
        }
        function shouldHoldCurrentStatus(nextText) {
            const now = Date.now();
            return now < statusHoldUntil && getStatusPriority(currentMainStatus.text) > getStatusPriority(nextText);
        }
        const IMPORTANT_MAIN_STATUSES = new Set(["Сбавь скорость", "Торможение", "Плотный поток", "Резкий разгон", "Нестабильно", "Частые остановки"]);
        let attentionAutoCloseTimer = null;
        let attentionAutoOpened = false;
        const ATTENTION_AUTO_CLOSE_MS = 2600;
        const speedHistory = [];
        let gpsPlusLastGoodAt = 0;
        let gpsPlusSmoothSpeed = NaN;
        function getGpsPlusLabel(hasGps) {
            if (!hasGps) {
                const recentlyGood = Date.now() - gpsPlusLastGoodAt < 8000;
                return recentlyGood ? (navigator.onLine ? "GPS+" : "GPS") : "Нет GPS";
            }
            return navigator.onLine ? "GPS+" : "GPS";
        }
        function smoothGpsPlusSpeed(speedKmh) {
            if (!Number.isFinite(speedKmh))
                return speedKmh;
            const safe = Math.max(0, speedKmh);
            if (!Number.isFinite(gpsPlusSmoothSpeed)) {
                gpsPlusSmoothSpeed = safe;
                return safe;
            }
            const diff = Math.abs(safe - gpsPlusSmoothSpeed);
            const alpha = diff > 18 ? 0.55 : 0.28;
            gpsPlusSmoothSpeed = gpsPlusSmoothSpeed + (safe - gpsPlusSmoothSpeed) * alpha;
            return gpsPlusSmoothSpeed;
        }
        function isNightMode() {
            return document.body.classList.contains("off-mode");
        }
        function setText(target, value) {
            if (!target)
                return;
            const next = value == null ? "—" : String(value);
            if (target.textContent === next)
                return;
            target.classList.add("attention-text-swap");
            window.setTimeout(() => {
                target.textContent = next;
                target.classList.remove("attention-text-swap");
            }, 90);
        }

        function applyMainStatus(mainStatus) {
            currentMainStatus = mainStatus;
            if (getStatusPriority(mainStatus.text) >= 3) {
                statusHoldUntil = Date.now() + STATUS_HOLD_MS;
            }
            const statusClass = mainStatus.visual === "alert" ? "status-alert" : (mainStatus.visual === "caution" ? "status-warning" : "status-normal");
            if (status) {
                status.classList.remove("status-alert", "status-warning", "status-normal");
                status.classList.add(statusClass);
                setText(status, mainStatus.text);
            }
            if (stateValue) {
                stateValue.classList.remove("status-alert", "status-warning", "status-normal");
                stateValue.classList.add(statusClass);
                setText(stateValue, mainStatus.text);
            }
            setVisualState(mainStatus.visual, lastResolvedRoadMode, true);
        }
        function commitPendingMainStatus() {
            if (!pendingMainStatus)
                return;
            applyMainStatus(pendingMainStatus);
            pendingMainStatus = null;
            pendingMainStatusTimer = null;
        }
        function queueMainStatus(mainStatus) {
            const now = Date.now();
            if (shouldHoldCurrentStatus(mainStatus.text)) {
                pendingMainStatus = mainStatus;
                return;
            }
            const isImportant = IMPORTANT_MAIN_STATUSES.has(mainStatus.text);
            if (isImportant) {
                if (pendingMainStatusTimer)
                    clearTimeout(pendingMainStatusTimer);
                pendingMainStatus = null;
                pendingMainStatusTimer = null;
                applyMainStatus(mainStatus);
                return;
            }
            if (eventHoldUntil > now && IMPORTANT_MAIN_STATUSES.has(currentMainStatus.text)) {
                pendingMainStatus = mainStatus;
                return;
            }
            if (currentMainStatus.text === mainStatus.text && currentMainStatus.visual === mainStatus.visual)
                return;
            pendingMainStatus = mainStatus;
            if (pendingMainStatusTimer)
                clearTimeout(pendingMainStatusTimer);
            pendingMainStatusTimer = setTimeout(commitPendingMainStatus, STATE_CONFIRM_MS);
        }
        function addSpeedSample(speedKmh) {
            const safeSpeed = Number.isFinite(speedKmh) ? Math.max(0, speedKmh) : NaN;
            const now = Date.now();
            speedHistory.push({ speed: safeSpeed, time: now });
            const cutoff = now - 3 * 60 * 1000;
            while (speedHistory.length && speedHistory[0].time < cutoff) {
                speedHistory.shift();
            }
        }
        function getAverage(samples) {
            if (!samples.length)
                return 0;
            return samples.reduce((acc, item) => acc + item.speed, 0) / samples.length;
        }
        function getLimitByRoadMode(roadMode) {
            switch (roadMode) {
                case "Город":
                    return 60;
                case "Трасса":
                    return 90;
                default:
                    return null;
            }
        }
        function getMainStatus(speedKmh, hasGps, roadMode, speedLimitValue, sharpEvent, behavior) {
            if (!hasGps || !Number.isFinite(speedKmh))
                return { text: currentMainStatus && currentMainStatus.text && currentMainStatus.text !== "—" ? currentMainStatus.text : "Стабильно", visual: "normal" };
            if (sharpEvent === "Торможение" || behavior.label === "Торможение")
                return { text: "Торможение", visual: "alert" };
            if (speedLimitValue && speedKmh > speedLimitValue + 10)
                return { text: "Сбавь скорость", visual: "alert" };
            if (behavior.label === "Резкий разгон")
                return { text: "Резкий разгон", visual: "caution" };
            if (behavior.label === "Частые остановки")
                return { text: "Частые остановки", visual: "caution" };
            if (behavior.label === "Нестабильно")
                return { text: "Нестабильно", visual: "caution" };
            if (behavior.label === "Пробка" || behavior.label === "Плотный поток")
                return { text: "Плотный поток", visual: "caution" };
            if (speedKmh < 3 || roadMode === "Стоянка")
                return { text: "Стоянка", visual: "normal" };
            if (behavior.label === "Движение")
                return { text: "Движение", visual: behavior.visual };
            return { text: "Стабильно", visual: "normal" };
        }
        function detectRoadMode(speedKmh, hasGps) {
            if (!hasGps || !Number.isFinite(speedKmh))
                return "Нет данных";
            const now = Date.now();
            const recent15 = speedHistory.filter((item) => now - item.time <= 15 * 1000 && Number.isFinite(item.speed));
            if (recent15.length >= 3 && recent15.every((item) => item.speed < 3))
                return "Стоянка";
            const last60 = speedHistory.filter((item) => now - item.time <= 60 * 1000 && Number.isFinite(item.speed));
            const last90 = speedHistory.filter((item) => now - item.time <= 90 * 1000 && Number.isFinite(item.speed));
            const last180 = speedHistory.filter((item) => now - item.time <= 180 * 1000 && Number.isFinite(item.speed));
            if (last60.length < 4) {
                if (speedKmh < 50)
                    return speedKmh < 3 ? "Стоянка" : "Город";
                if (speedKmh > 72)
                    return "Переход";
                return "Переход";
            }
            const avg60 = getAverage(last60);
            const avg90 = getAverage(last90.length ? last90 : last60);
            const hadStop = last180.some((item) => item.speed < 5);
            const speeds60 = last60.map((item) => item.speed);
            const min60 = speeds60.length ? Math.min(...speeds60) : 0;
            const max60 = speeds60.length ? Math.max(...speeds60) : 0;
            const spread60 = max60 - min60;
            if (avg90 > 72 && !hadStop && spread60 < 20)
                return "Трасса";
            if (avg60 < 50 || hadStop || spread60 > 35)
                return "Город";
            return lastResolvedRoadMode === "Трасса" && avg60 > 62 ? "Трасса" : "Переход";
        }
        function detectBehavior(speedKmh, hasGps) {
            if (!hasGps || !Number.isFinite(speedKmh))
                return { label: "—", status: "Ожидание GPS", visual: "normal" };
            const now = Date.now();
            const recent15 = speedHistory.filter((item) => now - item.time <= 15 * 1000 && Number.isFinite(item.speed));
            if (recent15.length >= 3 && recent15.every((item) => item.speed < 3)) {
                return { label: "Стоянка", status: "Стоянка", visual: "normal" };
            }

            const recent30 = speedHistory.filter((item) => now - item.time <= 30 * 1000 && Number.isFinite(item.speed));
            const recent45 = speedHistory.filter((item) => now - item.time <= 45 * 1000 && Number.isFinite(item.speed));
            const recent120 = speedHistory.filter((item) => now - item.time <= 120 * 1000 && Number.isFinite(item.speed));
            const avg45 = getAverage(recent45);

            let stopGoChanges = 0;
            for (let i = 1; i < recent120.length; i++) {
                const prev = recent120[i - 1].speed;
                const cur = recent120[i].speed;
                if ((prev < 5 && cur > 12) || (prev > 12 && cur < 5))
                    stopGoChanges += 1;
            }

            let variation30 = 0;
            for (let i = 1; i < recent30.length; i++) {
                variation30 += Math.abs(recent30[i].speed - recent30[i - 1].speed);
            }

            const recent6 = speedHistory.filter((item) => now - item.time <= 6 * 1000 && Number.isFinite(item.speed));
            let accelKmhPerSec = 0;
            if (recent6.length >= 2) {
                const first = recent6[0];
                const last = recent6[recent6.length - 1];
                const dt = Math.max(1, (last.time - first.time) / 1000);
                accelKmhPerSec = (last.speed - first.speed) / dt;
            }

            if (accelKmhPerSec <= -8 && speedKmh > 8) {
                return { label: "Торможение", status: "Торможение", visual: "alert" };
            }
            if (accelKmhPerSec >= 9 && speedKmh > 12) {
                return { label: "Резкий разгон", status: "Резкий разгон", visual: "caution" };
            }
            if (stopGoChanges >= 4 && avg45 < 28) {
                return { label: "Частые остановки", status: "Частые остановки", visual: "caution" };
            }
            if (avg45 < 18 && stopGoChanges >= 2) {
                return { label: "Пробка", status: "Пробка", visual: "caution" };
            }
            if (variation30 > 42 && speedKmh < 65) {
                return { label: "Плотный поток", status: "Плотный поток", visual: "caution" };
            }
            if (variation30 > 58) {
                return { label: "Нестабильно", status: "Нестабильно", visual: "caution" };
            }
            if (speedKmh >= 75) {
                return { label: "Движение", status: "Движение", visual: "caution" };
            }
            return { label: "Спокойно", status: "Спокойно", visual: "normal" };
        }
        function detectSharpEvent(speedKmh, hasGps) {
            if (!hasGps || !Number.isFinite(speedKmh))
                return "";
            const now = Date.now();
            const recent4 = speedHistory.filter((item) => now - item.time <= 4 * 1000 && Number.isFinite(item.speed));
            if (recent4.length < 2)
                return "";
            const first = recent4[0];
            const last = recent4[recent4.length - 1];
            const dt = Math.max(1, (last.time - first.time) / 1000);
            const accel = (last.speed - first.speed) / dt;
            if (accel >= 10)
                return "Резкий разгон";
            if (accel <= -10 && speedKmh > 8)
                return "Торможение";
            return "";
        }
        function getDirectionLabel(heading) {
            if (!Number.isFinite(heading))
                return "—";
            const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
            const index = Math.round((((heading % 360) + 360) % 360) / 45) % 8;
            return dirs[index];
        }
        function showEvent(label) {
            if (!eventBox || !label)
                return;
            if (label === lastEventLabel && eventBox.classList.contains("is-visible"))
                return;
            lastEventLabel = label;
            eventHoldUntil = Date.now() + EVENT_HOLD_MS;
            eventBox.textContent = "⚠ " + label;
            eventBox.classList.add("is-visible");
            if (currentEventTimer)
                clearTimeout(currentEventTimer);
            currentEventTimer = setTimeout(() => {
                eventBox.classList.remove("is-visible");
                lastEventLabel = "";
                eventHoldUntil = 0;
                if (pendingMainStatus) {
                    commitPendingMainStatus();
                }
            }, EVENT_HOLD_MS);
        }
        function showAttentionAutoIfNeeded(mainStatus, sharpEvent) {
            const importantText = sharpEvent || (mainStatus && ["Торможение", "Сбавь скорость"].includes(mainStatus.text) ? mainStatus.text : "");
            if (!importantText || !drawer)
                return;
            if (!drawer.classList.contains("open")) {
                drawer.classList.add("open");
                attentionAutoOpened = true;
            }
            if (attentionAutoCloseTimer)
                clearTimeout(attentionAutoCloseTimer);
            attentionAutoCloseTimer = setTimeout(() => {
                if (attentionAutoOpened && drawer) {
                    drawer.classList.remove("open");
                    attentionAutoOpened = false;
                }
            }, ATTENTION_AUTO_CLOSE_MS);
        }

        function revealDetailsTemporarily(duration = 1800) {
            if (!details)
                return;
            details.classList.add("is-expanded");
            if (detailsTimer)
                clearTimeout(detailsTimer);
            detailsTimer = setTimeout(() => {
                details.classList.remove("is-expanded");
            }, duration);
        }

        function updateDriveTime(speedKmh, hasGps) {
            if (!driveTime)
                return;
            if (!hasGps || !Number.isFinite(speedKmh)) {
                driveStartAt = null;
                setText(driveTime, "—");
                return;
            }
            if (speedKmh > 5) {
                if (!driveStartAt)
                    driveStartAt = Date.now();
            }
            else if (speedKmh < 3) {
                driveStartAt = null;
            }
            if (!driveStartAt) {
                setText(driveTime, speedKmh < 3 ? "Стоянка" : "—");
                return;
            }
            const totalMin = Math.max(1, Math.floor((Date.now() - driveStartAt) / 60000));
            setText(driveTime, `${totalMin} мин в пути`);
        }
        function setVisualState(state, roadMode, hasGps) {
            if (button) {
                button.classList.remove("attention-caution", "attention-alert");
                if (isNightMode() && state === "caution")
                    button.classList.add("attention-caution");
                if (isNightMode() && state === "alert")
                    button.classList.add("attention-alert");
            }
            [stateItem, speedItem, gpsItem, pointsItem].forEach((item) => item === null || item === void 0 ? void 0 : item.classList.remove("is-caution", "is-alert"));
            if (!isNightMode())
                return;
            if (state === "alert") {
                stateItem === null || stateItem === void 0 ? void 0 : stateItem.classList.add("is-alert");
                speedItem === null || speedItem === void 0 ? void 0 : speedItem.classList.add("is-alert");
            }
            else if (state === "caution") {
                stateItem === null || stateItem === void 0 ? void 0 : stateItem.classList.add("is-caution");
                speedItem === null || speedItem === void 0 ? void 0 : speedItem.classList.add("is-caution");
            }
            if (!hasGps || roadMode === "Нет данных") {
                gpsItem === null || gpsItem === void 0 ? void 0 : gpsItem.classList.add("is-alert");
                return;
            }
            if (roadMode === "Трасса") {
                pointsItem === null || pointsItem === void 0 ? void 0 : pointsItem.classList.add("is-alert");
            }
            else if (roadMode === "Город" || roadMode === "Переход") {
                pointsItem === null || pointsItem === void 0 ? void 0 : pointsItem.classList.add("is-caution");
            }
        }
        function updateFromSpeed(speedKmh, hasGps = true, heading = NaN) {
            if (hasGps && Number.isFinite(speedKmh)) {
                gpsPlusLastGoodAt = Date.now();
                speedKmh = smoothGpsPlusSpeed(speedKmh);
            }
            if (gpsValue)
                setText(gpsValue, getGpsPlusLabel(hasGps));
            if (gpsDirection)
                setText(gpsDirection, hasGps ? getDirectionLabel(heading) : "—");
            if (!hasGps || !Number.isFinite(speedKmh)) {
                updateDriveTime(NaN, false);
                if (typeof window.updateAttentionMini === "function") {
                    window.updateAttentionMini({ speed: NaN, status: "Ожидание", gpsOk: false });
                }
                if (typeof window.updateDriveHUD === "function") {
                    window.updateDriveHUD({ speed: NaN, status: "Нет GPS", gpsOk: false });
                }
                const fallbackMain = (currentMainStatus && currentMainStatus.text && currentMainStatus.text !== "—" && currentMainStatus.text !== "Нет GPS")
                    ? currentMainStatus.text
                    : "Стабильно";
                queueMainStatus({ text: fallbackMain, visual: "normal" });
                if (speedValue)
                    setText(speedValue, "—");
                if (speedLimit)
                    setText(speedLimit, "лимит —");
                speedItem === null || speedItem === void 0 ? void 0 : speedItem.classList.remove("has-limit", "is-over-limit");
                const keepRoadMode = (Date.now() - lastGpsGoodAt) <= GPS_MODE_HOLD_MS;
                if (pointsValue)
                    setText(pointsValue, keepRoadMode && lastResolvedRoadMode !== "Нет данных" ? lastResolvedRoadMode : "—");
                if (drawer?.classList.contains("open"))
                    revealDetailsTemporarily(1800);
                return;
            }
            addSpeedSample(speedKmh);
            lastGpsGoodAt = Date.now();
            const rounded = Math.max(0, Math.round(speedKmh));
            const roadMode = detectRoadMode(rounded, hasGps);
            const behavior = detectBehavior(rounded, hasGps);
            const sharpEvent = detectSharpEvent(rounded, hasGps);
            if (roadMode !== "Нет данных")
                lastResolvedRoadMode = roadMode;
            if (pointsValue)
                setText(pointsValue, roadMode);
            const speedLimitValue = getLimitByRoadMode(roadMode);
            const mainStatus = getMainStatus(rounded, hasGps, roadMode, speedLimitValue, sharpEvent, behavior);
            if (typeof window.updateAttentionMini === "function") {
                window.updateAttentionMini({ speed: rounded, status: mainStatus.text, gpsOk: true });
            }
            if (typeof window.updateDriveHUD === "function") {
                window.updateDriveHUD({ speed: rounded, status: mainStatus.text, gpsOk: true });
            }
            if (speedValue)
                setText(speedValue, rounded <= 3 ? "Стоянка" : `${rounded} км/ч`);
            if (speedLimit) {
                if (speedLimitValue && rounded > 3) {
                    const delta = rounded - speedLimitValue;
                    setText(speedLimit, delta > 0 ? `лимит ${speedLimitValue} · +${delta}` : `лимит ${speedLimitValue}`);
                }
                else {
                    setText(speedLimit, "лимит —");
                }
            }
            speedItem === null || speedItem === void 0 ? void 0 : speedItem.classList.toggle("has-limit", !!speedLimitValue && rounded > 3);
            speedItem === null || speedItem === void 0 ? void 0 : speedItem.classList.toggle("is-over-limit", !!speedLimitValue && rounded > speedLimitValue);
            queueMainStatus(mainStatus);
            updateDriveTime(rounded, true);
            if (sharpEvent)
                showEvent(sharpEvent);
            showAttentionAutoIfNeeded(mainStatus, sharpEvent);
            const needsDetailReveal = !!sharpEvent
                || (speedLimitValue && rounded > speedLimitValue)
                || mainStatus.text === "Плотный поток"
                || mainStatus.text === "Торможение"
                || mainStatus.text === "Сбавь скорость";
            if (drawer?.classList.contains("open") && needsDetailReveal)
                revealDetailsTemporarily(2000);
            if (!IMPORTANT_MAIN_STATUSES.has(mainStatus.text) && (!pendingMainStatus || pendingMainStatus.text !== mainStatus.text)) {
                setVisualState(currentMainStatus.visual, roadMode, true);
            }
        }
        function startWatcher() {
            if (!navigator.geolocation || watchId !== null)
                return;
            watchId = navigator.geolocation.watchPosition((position) => {
                var _a, _b;
                const speedKmh = typeof __getGpsSpeedKmh === "function" ? __getGpsSpeedKmh(position?.coords) : (Number.isFinite(position?.coords?.speed) ? position.coords.speed * 3.6 : 0);
                const heading = Number.isFinite(position?.coords?.heading) ? position.coords.heading : NaN;
                updateFromSpeed(speedKmh, true, heading);
            }, () => {
                applyMainStatus({ text: '—', visual: 'normal' });
            updateFromSpeed(NaN, false);
            }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 });
        }
        function close() {
            if (attentionAutoCloseTimer)
                clearTimeout(attentionAutoCloseTimer);
            attentionAutoOpened = false;
            drawer === null || drawer === void 0 ? void 0 : drawer.classList.remove("open");
        }

        async function refreshByCoords(latitude, longitude, label = "Текущее местоположение", force = false) {
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
                return;
            const currentCoordsKey = coordsKey(latitude, longitude);
            const sameCoords = currentCoordsKey === lastCoordsKey;
            if (!force && sameCoords && Date.now() - lastLoadedAt < 5 * 60 * 1000) {
                setLocationLabel(lastResolvedLocation.label || label);
                return;
            }
            setLoading();
            setLocationLabel(label);
            try {
                const response = await fetch(buildWeatherUrl(latitude, longitude), { cache: 'no-store' });
                if (!response.ok) throw new Error(`Weather ${response.status}`);
                const data = await response.json();
                render(data);
                const resolvedLabel = await resolveLocationName(latitude, longitude, label);
                lastResolvedLocation = { latitude, longitude, label: resolvedLabel };
                setLocationLabel(resolvedLabel);
                lastCoordsKey = currentCoordsKey;
                lastLoadedAt = Date.now();
            }
            catch (e) {
                if (els.status) els.status.textContent = "Не удалось загрузить погоду";
                if (els.updated) els.updated.textContent = "Проверьте подключение к интернету";
                setLocationLabel(label);
            }
        }

        function open() {
            if (attentionAutoCloseTimer)
                clearTimeout(attentionAutoCloseTimer);
            attentionAutoOpened = false;
            drawer === null || drawer === void 0 ? void 0 : drawer.classList.add("open");
        }
        function init() {
            closeBtn === null || closeBtn === void 0 ? void 0 : closeBtn.addEventListener("click", close);
            applyMainStatus({ text: '—', visual: 'normal' });
            updateFromSpeed(NaN, false);
        }
        return { init, open, close, updateFromSpeed };
    })();

    // --- Приложения ---
    // --- Приложения ---
    modules.apps = (function () {
        const picker = document.getElementById("app_picker");
        const grid = document.getElementById("app-picker-grid");
        const close = document.getElementById("app-picker-close");
        let currentSlot = null;
        let appsCache = [];
        let appsRefreshTimer = null;
        let fastActionLock = false;
        function closePicker() {
            picker === null || picker === void 0 ? void 0 : picker.classList.remove('open');
            currentSlot = null;
        }
        function runFastAction(action) {
            if (fastActionLock)
                return;
            fastActionLock = true;
            try {
                action();
            }
            finally {
                setTimeout(() => { fastActionLock = false; }, 220);
            }
        }
        function bindFastPress(element, action, { allowMove = 12 } = {}) {
            if (!element)
                return;
            let startX = 0;
            let startY = 0;
            let moved = false;
            element.addEventListener('pointerdown', (event) => {
                startX = event.clientX;
                startY = event.clientY;
                moved = false;
            }, { passive: true });
            element.addEventListener('pointermove', (event) => {
                if (Math.abs(event.clientX - startX) > allowMove || Math.abs(event.clientY - startY) > allowMove) {
                    moved = true;
                }
            }, { passive: true });
            element.addEventListener('pointerup', (event) => {
                if (moved)
                    return;
                event.preventDefault();
                runFastAction(action);
            });
            element.addEventListener('click', (event) => {
                event.preventDefault();
            });
        }
        function applyAppToSlot(slotIndex, app) {
            storage.save('app_slot_' + slotIndex, { package: app.package, name: app.name, icon: app.icon });
            const slotEl = document.querySelector(`.app_slot[data-slot="${slotIndex}"]`);
            if (slotEl) {
                const slotImg = document.createElement('img');
                slotImg.src = app.icon ? `data:image/png;base64,${app.icon}` : 'icons/Default.svg';
                slotImg.alt = app.name || 'App';
                slotEl.replaceChildren(slotImg);
            }
        }
        function buildAppsGrid(apps, mode = 'launch') {
            grid.replaceChildren();
            if (!Array.isArray(apps) || apps.length === 0) {
                grid.appendChild(createInfoMessage('Нет доступных приложений'));
                return;
            }
            const fragment = document.createDocumentFragment();
            apps.forEach(app => {
                const d = document.createElement('div');
                d.className = 'picker-item';
                const img = document.createElement('img');
                img.src = app.icon ? `data:image/png;base64,${app.icon}` : 'icons/Default.svg';
                img.alt = app.name || 'App';
                const span = document.createElement('span');
                span.textContent = app.name || 'Без названия';
                d.append(img, span);
                bindFastPress(d, () => {
                    if (!app.package)
                        return;
                    if (mode === 'assign' && currentSlot !== null) {
                        applyAppToSlot(currentSlot, app);
                    }
                    else {
                        closePicker();
                        android.runApp(app.package);
                        return;
                    }
                    closePicker();
                });
                fragment.appendChild(d);
            });
            grid.appendChild(fragment);
        }
        function fetchAndRenderApps(mode = 'launch', { background = false } = {}) {
            try {
                const apps = safeParseJson(android.getUserApps(), []);
                appsCache = Array.isArray(apps) ? apps : [];
                buildAppsGrid(appsCache, mode);
            }
            catch (e) {
                if (!background && !appsCache.length) {
                    grid.replaceChildren(createInfoMessage('Ошибка загрузки приложений'));
                }
                error('Failed to load apps:', e);
            }
        }
        function scheduleAppsRefresh(mode = 'launch') {
            if (appsRefreshTimer)
                clearTimeout(appsRefreshTimer);
            appsRefreshTimer = setTimeout(() => {
                fetchAndRenderApps(mode, { background: true });
            }, 120);
        }
        function renderApps(mode = 'launch') {
            picker === null || picker === void 0 ? void 0 : picker.classList.add('open');
            if (appsCache.length) {
                buildAppsGrid(appsCache, mode);
                scheduleAppsRefresh(mode);
            }
            else {
                fetchAndRenderApps(mode);
            }
        }
        function openPicker(slot) {
            currentSlot = slot.dataset.slot;
            renderApps('assign');
        }
        function openMenu() {
            currentSlot = null;
            renderApps('launch');
        }
        function init() {
            const slots = document.querySelectorAll(".app_slot");
            slots.forEach(s => {
                const saved = storage.load("app_slot_" + s.dataset.slot);
                if (saved) {
                    const img = document.createElement('img');
                    img.src = saved.icon ? `data:image/png;base64,${saved.icon}` : 'icons/Default.svg';
                    img.alt = saved.name || 'App';
                    s.replaceChildren(img);
                }
            });
            try {
                const initialApps = safeParseJson(android.getUserApps(), []);
                if (Array.isArray(initialApps))
                    appsCache = initialApps;
            }
            catch (e) {
                error('Initial apps cache failed:', e);
            }
            setTimeout(() => {
                try {
                    const warmApps = safeParseJson(android.getUserApps(), []);
                    if (Array.isArray(warmApps) && warmApps.length)
                        appsCache = warmApps;
                }
                catch (e) {
                    error('Warm apps cache failed:', e);
                }
            }, 0);
            close === null || close === void 0 ? void 0 : close.addEventListener("click", closePicker);
            picker === null || picker === void 0 ? void 0 : picker.addEventListener("click", e => {
                if (e.target === picker)
                    closePicker();
            });
            slots.forEach(slot => {
                makeLongPressable(slot, () => openPicker(slot), { delay: 700 });
                bindFastPress(slot, () => {
                    const app = storage.load("app_slot_" + slot.dataset.slot);
                    if (!app) {
                        openPicker(slot);
                    }
                    else if (app.package) {
                        android.runApp(app.package);
                    }
                    else {
                        openPicker(slot);
                    }
                });
            });
        }
        return { init, openMenu };
    })();
    // ---------- Обработка событий от Android ----------
    window.onAndroidEvent = function (type, data) {
        log("Android event:", type, data);
        const musicEventTypes = new Set(["musicInfo", "mediaInfo", "playerInfo", "audioInfo", "mediaMetadata", "mediaSession", "nowPlaying"]);
        if (musicEventTypes.has(type)) {
            modules.player.updateMusicInfo(data);
        }
        else if (type === "climateState") {
            modules.climate.updateState(data);
        }
    };
    window.updateMusicInfo = function (data) {
        modules.player.updateMusicInfo(data);
    };
    window.updateMediaInfo = function (data) {
        modules.player.updateMusicInfo(data);
    };
    // ---------- Инициализация интерфейса ----------
    function bindNightExitGesture() {
        if (document.body.dataset.nightExitBound === 'true')
            return;
        document.body.dataset.nightExitBound = 'true';
        document.addEventListener('pointerup', (event) => {
            var _a, _b;
            if (!document.body.classList.contains('off-mode'))
                return;
            if (tapMoved)
                return;
            const clockWidget = event.target.closest('.widget_time');
            const bgTarget = !event.target.closest(interactiveSelector);
            if (clockWidget || bgTarget) {
                (_b = (_a = modules.wallpaper) === null || _a === void 0 ? void 0 : _a.toggle) === null || _b === void 0 ? void 0 : _b.call(_a);
            }
        }, { passive: true });
        document.addEventListener('keydown', (event) => {
            var _a, _b;
            if (!document.body.classList.contains('off-mode'))
                return;
            if (event.key === 'Escape') {
                event.preventDefault();
                (_b = (_a = modules.wallpaper) === null || _a === void 0 ? void 0 : _a.toggle) === null || _b === void 0 ? void 0 : _b.call(_a);
            }
        });
    }
    function bindWallpaperTapGesture() {
        let tapStartX = 0;
        let tapStartY = 0;
        let tapMoved = false;
        const interactiveSelector = [
            'button',
            'a',
            'input',
            'textarea',
            'select',
            '[role="button"]',
            '.widget_buttons',
            '.widget_player',
            '.widget_apps',
            '.widget_climate',
            '.widget_time',
            '.app_slot',
            '.climate_slot',
            '.climate-off-all',
            '.sidebar',
            '.wallpaper-item',
            '.picker-drawer',
            '.drawer-header',
            '.drawer-close',
            '.picker-grid',
            '#global-loader'
        ].join(', ');
        document.addEventListener('pointerdown', (event) => {
            tapStartX = event.clientX;
            tapStartY = event.clientY;
            tapMoved = false;
        }, { passive: true });
        document.addEventListener('pointermove', (event) => {
            if (Math.abs(event.clientX - tapStartX) > 10 || Math.abs(event.clientY - tapStartY) > 10) {
                tapMoved = true;
            }
        }, { passive: true });
        document.addEventListener('pointerup', (event) => {
            var _a, _b, _c;
            if (tapMoved)
                return;
            if (document.body.classList.contains('off-mode'))
                return;
            if ((_a = document.getElementById('sidebar')) === null || _a === void 0 ? void 0 : _a.classList.contains('open'))
                return;
            if (document.querySelector('.picker-drawer.open'))
                return;
            if (event.target.closest(interactiveSelector))
                return;
            (_c = (_b = modules.wallpaper) === null || _b === void 0 ? void 0 : _b.cycleTapWallpaper) === null || _c === void 0 ? void 0 : _c.call(_b);
        }, { passive: true });
    }
    function initUI() {
        var _a, _b;
        modules.wallpaper.restore();
        modules.wallpaper.initAutoMode();
        modules.clock.start();
        modules.brandEditor.init();
        modules.player.init();
        modules.apps.init();
        modules.weather.init();
        modules.hudNavigation.init();
        modules.attention.init();
        bindWallpaperTapGesture();
        bindNightExitGesture();
        const btnWeather = document.getElementById("btnWeather");
        if (btnWeather) {
            btnWeather.classList.remove("active");
        }
        const sidebar = document.getElementById("sidebar");
        const bindFastSidebarOpen = (element, action) => {
            if (!element)
                return;
            let startX = 0;
            let startY = 0;
            let moved = false;
            element.addEventListener('pointerdown', (event) => {
                startX = event.clientX;
                startY = event.clientY;
                moved = false;
            }, { passive: true });
            element.addEventListener('pointermove', (event) => {
                if (Math.abs(event.clientX - startX) > 12 || Math.abs(event.clientY - startY) > 12) {
                    moved = true;
                }
            }, { passive: true });
            element.addEventListener('pointerup', (event) => {
                if (moved)
                    return;
                event.preventDefault();
                action();
            });
            element.addEventListener('click', (event) => {
                event.preventDefault();
            });
        };
        const openAttentionDrawer = (event) => {
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            sidebar === null || sidebar === void 0 ? void 0 : sidebar.classList.remove("open");
            document.getElementById("app_picker") === null || document.getElementById("app_picker") === void 0 ? void 0 : document.getElementById("app_picker").classList.remove("open");
            document.getElementById("climate-picker") === null || document.getElementById("climate-picker") === void 0 ? void 0 : document.getElementById("climate-picker").classList.remove("open");
            document.getElementById("weather-drawer") === null || document.getElementById("weather-drawer") === void 0 ? void 0 : document.getElementById("weather-drawer").classList.remove("open");
            document.getElementById("attention-drawer") === null || document.getElementById("attention-drawer") === void 0 ? void 0 : document.getElementById("attention-drawer").classList.remove("open");
            document.getElementById("hudnav-drawer") === null || document.getElementById("hudnav-drawer") === void 0 ? void 0 : document.getElementById("hudnav-drawer").classList.remove("open");
            return modules.hudNavigation && modules.hudNavigation.isActive && modules.hudNavigation.isActive()
              ? modules.hudNavigation.open()
              : modules.attention.open();
        }
        const btnAttention = document.getElementById("btnAttention");
        if (btnAttention) {
            bindFastSidebarOpen(btnAttention, (event) => {
            startGPSOnceFromButton();
            if (modules.hudNavigation?.isActive?.()) {
                modules.hudNavigation?.open?.();
            } else {
                openAttentionDrawer(event);
            }
        });
        }
        const closeAllOverlays = () => {
            sidebar === null || sidebar === void 0 ? void 0 : sidebar.classList.remove("open");
            document.getElementById("app_picker") === null || document.getElementById("app_picker") === void 0 ? void 0 : document.getElementById("app_picker").classList.remove("open");
            document.getElementById("climate-picker") === null || document.getElementById("climate-picker") === void 0 ? void 0 : document.getElementById("climate-picker").classList.remove("open");
            document.getElementById("weather-drawer") === null || document.getElementById("weather-drawer") === void 0 ? void 0 : document.getElementById("weather-drawer").classList.remove("open");
            document.getElementById("attention-drawer") === null || document.getElementById("attention-drawer") === void 0 ? void 0 : document.getElementById("attention-drawer").classList.remove("open");
            document.getElementById("hudnav-drawer") === null || document.getElementById("hudnav-drawer") === void 0 ? void 0 : document.getElementById("hudnav-drawer").classList.remove("open");
        };
        const openSidebarBtn = document.getElementById("openSidebar");
        const openWeatherDrawer = (event) => {
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            sidebar === null || sidebar === void 0 ? void 0 : sidebar.classList.remove("open");
            document.getElementById("app_picker") === null || document.getElementById("app_picker") === void 0 ? void 0 : document.getElementById("app_picker").classList.remove("open");
            document.getElementById("climate-picker") === null || document.getElementById("climate-picker") === void 0 ? void 0 : document.getElementById("climate-picker").classList.remove("open");
            document.getElementById("weather-drawer") === null || document.getElementById("weather-drawer") === void 0 ? void 0 : document.getElementById("weather-drawer").classList.remove("open");
            document.getElementById("attention-drawer") === null || document.getElementById("attention-drawer") === void 0 ? void 0 : document.getElementById("attention-drawer").classList.remove("open");
            document.getElementById("weather-drawer") === null || document.getElementById("weather-drawer") === void 0 ? void 0 : document.getElementById("weather-drawer").classList.add("open");
            return modules.weather.open();
        };
        const openAppsSidebar = (event) => {
            var _a, _b;
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            sidebar === null || sidebar === void 0 ? void 0 : sidebar.classList.remove("open");
            document.getElementById("climate-picker") === null || document.getElementById("climate-picker") === void 0 ? void 0 : document.getElementById("climate-picker").classList.remove("open");
            document.getElementById("weather-drawer") === null || document.getElementById("weather-drawer") === void 0 ? void 0 : document.getElementById("weather-drawer").classList.remove("open");
            document.getElementById("attention-drawer") === null || document.getElementById("attention-drawer") === void 0 ? void 0 : document.getElementById("attention-drawer").classList.remove("open");
            return (_b = (_a = modules.apps) === null || _a === void 0 ? void 0 : _a.openMenu) === null || _b === void 0 ? void 0 : _b.call(_a);
        };
        bindFastSidebarOpen(btnWeather, openWeatherDrawer);
        if (openSidebarBtn) {
            openSidebarBtn.replaceWith(openSidebarBtn.cloneNode(true));
            const openSidebarBtnFresh = document.getElementById("openSidebar");
            if (openSidebarBtnFresh) {
                bindFastSidebarOpen(openSidebarBtnFresh, openAppsSidebar);
            }
        }
        const closeSidebarButton = document.getElementById("closeSidebar");
        const closeWallpaperSidebar = (event) => {
            var _a, _b;
            if (event && typeof event.preventDefault === "function")
                event.preventDefault();
            if (event && typeof event.stopPropagation === "function")
                event.stopPropagation();
            return (_b = (_a = modules.wallpaper) === null || _a === void 0 ? void 0 : _a.closeSidebarFast) === null || _b === void 0 ? void 0 : _b.call(_a);
        };
        ["click", "pointerup", "touchend"].forEach((eventName) => {
            closeSidebarButton === null || closeSidebarButton === void 0 ? void 0 : closeSidebarButton.addEventListener(eventName, closeWallpaperSidebar, eventName === "touchend" ? { passive: false } : undefined);
        });
        sidebar === null || sidebar === void 0 ? void 0 : sidebar.addEventListener("click", (event) => {
            if (!(sidebar === null || sidebar === void 0 ? void 0 : sidebar.classList.contains("open")))
                return;
            const onWallpaperItem = event.target.closest('.wallpaper-item');
            const onTopbar = event.target.closest('.sidebar__topbar');
            const onCloseBtn = event.target.closest('#closeSidebar');
            if (!onWallpaperItem && !onTopbar && !onCloseBtn) {
                closeWallpaperSidebar(event);
            }
        }, true);
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && (sidebar === null || sidebar === void 0 ? void 0 : sidebar.classList.contains("open"))) {
                closeWallpaperSidebar(event);
            }
        });
        const wallpaperItems = document.querySelectorAll('.wallpaper-item');
        wallpaperItems.forEach((item, i) => {
            item.addEventListener('click', () => {
                wallpaperItems.forEach(el => el.classList.remove('is-active'));
                item.classList.add('is-active');
                modules.wallpaper.setCustomByIndex(i);
                modules.wallpaper.closeSidebarFast();
            });
        });
        const climateWidget = document.querySelector('.widget_climate');
        climateWidget === null || climateWidget === void 0 ? void 0 : climateWidget.addEventListener('click', (event) => {
            if (!event.target.closest('.climate_slot, .climate-off-all')) {
                modules.climate.openPickerForSlot('1');
                return;
            }
        });
        document.addEventListener("contextmenu", e => e.preventDefault());
        android.onJsReady();
    }
    async function start() {
        await modules.climate.init();
        initUI();
    }
    window.AppModules = modules;
    window.modules = modules;
    return { start };
})();
document.addEventListener("DOMContentLoaded", () => App.start());
// Apps fine polish
window.addEventListener('load', () => {
    try {
        document.querySelectorAll('.app-slot, .apps-slot').forEach((slot) => {
            const label = slot.querySelector('span, .label');
            if (label && label.textContent) {
                label.textContent = label.textContent.trim();
                slot.setAttribute('title', label.textContent);
            }
        });
    }
    catch (e) { }
});




// ==== GPS START FIX ====
function startGPS() {
  if (!navigator.geolocation) {
    console.log("GPS не поддерживается");
    return;
  }

  navigator.geolocation.watchPosition(
    (pos) => {
      const speed = typeof __getGpsSpeedKmh === "function" ? __getGpsSpeedKmh(pos?.coords) : (Number.isFinite(pos?.coords?.speed) ? pos.coords.speed * 3.6 : 0);
      const heading = Number.isFinite(pos?.coords?.heading) ? pos.coords.heading : NaN;

      console.log("GPS OK:", pos.coords);

      if (window.modules && window.modules.attention && typeof window.modules.attention.updateFromSpeed === "function") {
        window.modules.attention.updateFromSpeed(speed, true, heading);
      }
      if (window.modules && window.modules.weather && typeof window.modules.weather.refreshByCoords === "function") {
        const lat = pos?.coords?.latitude;
        const lon = pos?.coords?.longitude;
        const now = Date.now();
        if (Number.isFinite(lat) && Number.isFinite(lon) && (!window.__lastWeatherGpsUpdate || now - window.__lastWeatherGpsUpdate > 5 * 60 * 1000)) {
          window.__lastWeatherGpsUpdate = now;
          window.modules.weather.refreshByCoords(lat, lon, "Текущее местоположение", false);
        }
      }
    },
    (err) => {
      console.log("GPS ошибка:", err);

      if (window.modules && window.modules.attention && typeof window.modules.attention.updateFromSpeed === "function") {
        window.modules.attention.updateFromSpeed(NaN, false);
      }
    },
    {
      enableHighAccuracy: true,
      maximumAge: 15000,
      timeout: 10000
    }
  );
}



let __gpsStartedFromButton = false;
function startGPSOnceFromButton() {
  if (__gpsStartedFromButton) return;
  __gpsStartedFromButton = true;
  startGPS();
}

// ==== GPS END FIX ====



// ==== iPhone speed fallback from coordinates ====
let __iphoneLastSpeedPosition = null;
let __iphoneLastSpeedTime = null;

function __toRad(value) {
  return value * Math.PI / 180;
}

function __distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = __toRad(lat2 - lat1);
  const dLon = __toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(__toRad(lat1)) *
    Math.cos(__toRad(lat2)) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function __calculateIphoneSpeedKmh(coords) {
  if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
    return 0;
  }

  const now = Date.now();
  const current = {
    lat: coords.latitude,
    lon: coords.longitude
  };

  if (!__iphoneLastSpeedPosition || !__iphoneLastSpeedTime) {
    __iphoneLastSpeedPosition = current;
    __iphoneLastSpeedTime = now;
    return 0;
  }

  const dt = Math.max(0.5, (now - __iphoneLastSpeedTime) / 1000);
  const distance = __distanceMeters(
    __iphoneLastSpeedPosition.lat,
    __iphoneLastSpeedPosition.lon,
    current.lat,
    current.lon
  );

  __iphoneLastSpeedPosition = current;
  __iphoneLastSpeedTime = now;

  if (distance < 3) return 0;

  const speed = (distance / dt) * 3.6;
  if (!Number.isFinite(speed)) return 0;

  return Math.min(Math.max(speed, 0), 180);
}

function __getGpsSpeedKmh(coords) {
  if (coords && Number.isFinite(coords.speed)) {
    return Math.max(0, coords.speed * 3.6);
  }
  return __calculateIphoneSpeedKmh(coords);
}
// ==== iPhone speed fallback END ====


// ==== GPS HARD FIX FOR iPHONE ====
(function () {
  const btn = document.getElementById("btnAttention");
  if (!btn) return;

  let gpsPermissionRequested = false;

  function requestGPSPermissionOnce() {
    if (gpsPermissionRequested) return;
    gpsPermissionRequested = true;

    if (!navigator.geolocation) {
      console.log("GPS не поддерживается");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        console.log("GPS разрешен", pos.coords);
        const speed = typeof __getGpsSpeedKmh === "function" ? __getGpsSpeedKmh(pos?.coords) : (Number.isFinite(pos?.coords?.speed) ? pos.coords.speed * 3.6 : 0);
        const heading = Number.isFinite(pos?.coords?.heading) ? pos.coords.heading : NaN;
        if (window.modules && window.modules.attention && typeof window.modules.attention.updateFromSpeed === "function") {
          window.modules.attention.updateFromSpeed(speed, true, heading);
        }
        if (window.modules && window.modules.weather && typeof window.modules.weather.refreshByCoords === "function") {
          const lat = pos?.coords?.latitude;
          const lon = pos?.coords?.longitude;
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            window.__lastWeatherGpsUpdate = Date.now();
            window.modules.weather.refreshByCoords(lat, lon, "Текущее местоположение", true);
          }
        }
        if (typeof startGPS === "function") startGPS();
      },
      (err) => {
        console.log("GPS ошибка", err);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000
      }
    );
  }

  btn.addEventListener("click", requestGPSPermissionOnce, { capture: true });
  btn.addEventListener("touchstart", requestGPSPermissionOnce, { capture: true });
})();
// ==== GPS HARD FIX FOR iPHONE END ====



// ==== Floating HUD layer ====
(function () {
  window.updateDriveHUD = function (payload) {
    const hud = document.getElementById("drive-hud");
    const speedEl = document.getElementById("drive-hud-speed");
    const statusEl = document.getElementById("drive-hud-status");
    if (!hud || !speedEl || !statusEl || !payload) return;

    const speed = Number(payload.speed);
    const status = payload.status || "GPS";
    const hasGps = payload.gpsOk !== false;

    if (!hasGps || !Number.isFinite(speed)) {
      speedEl.textContent = "—";
      statusEl.textContent = "Нет GPS";
      hud.classList.add("is-idle");
      hud.classList.remove("is-alert");
      return;
    }

    const rounded = Math.max(0, Math.round(speed));
    speedEl.textContent = rounded <= 3 ? "0" : String(rounded);
    statusEl.textContent = status;

    hud.classList.toggle("is-idle", rounded <= 3);
    hud.classList.toggle("is-alert", ["Сбавь скорость", "Торможение"].includes(status));
    hud.classList.toggle("is-warning", ["Резкий разгон", "Плотный поток", "Нестабильно", "Частые остановки"].includes(status));
  };
})();



// ==== Attention internet context ====
(function () {
  function updateAttentionNetStatus() {
    const el = document.getElementById("attention-net");
    if (!el) return;
    el.textContent = navigator.onLine ? "" : "Нет сети";
  }

  window.updateAttentionNetStatus = updateAttentionNetStatus;
  window.addEventListener("online", updateAttentionNetStatus);
  window.addEventListener("offline", updateAttentionNetStatus);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateAttentionNetStatus);
  } else {
    updateAttentionNetStatus();
  }
})();



// ==== Main HUD disabled visually; GPS stays inside Attention ====
(function () {
  window.updateDriveHUD = function () {
    // Главный HUD отключён. GPS и скорость остаются в шторке "Внимание".
  };
})();



// ==== Attention mini bar ====
(function () {
  const MINI_PRIORITY = {
    "Торможение": 5,
    "Сбавь скорость": 5,
    "Резкий разгон": 4,
    "Плотный поток": 3,
    "Нестабильно": 3,
    "Частые остановки": 3,
    "Движение": 1,
    "Стоянка": 1,
    "Стабильно": 0,
    "Норма": 0,
    "Ожидание": 0
  };
  let miniHeldStatus = "Ожидание";
  let miniHoldUntil = 0;

  function miniPriority(status) {
    return MINI_PRIORITY[status] ?? 0;
  }

  function resolveMiniStatus(nextStatus) {
    const now = Date.now();
    if (miniPriority(nextStatus) >= 3) {
      miniHeldStatus = nextStatus;
      miniHoldUntil = now + 2200;
      return miniHeldStatus;
    }

    if (now < miniHoldUntil && miniPriority(miniHeldStatus) > miniPriority(nextStatus)) {
      return miniHeldStatus;
    }

    miniHeldStatus = nextStatus;
    return miniHeldStatus;
  }

  window.updateAttentionMini = function (payload) {
    const mini = document.getElementById("attention-mini");
    const statusEl = document.getElementById("attention-mini-status");
    const speedEl = document.getElementById("attention-mini-speed");
    if (!mini || !statusEl || !speedEl || !payload) return;

    const rawStatus = payload.status || "";
    const speed = Number(payload.speed);
    const gpsOk = payload.gpsOk !== false;

    mini.classList.remove("is-idle", "is-warning", "is-alert", "is-quiet");

    if (!gpsOk || !Number.isFinite(speed)) {
      const status = resolveMiniStatus("Ожидание");
      statusEl.textContent = status === "Ожидание" ? "Ожидание GPS" : status;
      speedEl.textContent = "";
      mini.classList.add("is-idle");
      return;
    }

    const rounded = Math.max(0, Math.round(speed));
    const readableStatus = rawStatus === "Стабильно" ? "Норма" : rawStatus;
    const status = resolveMiniStatus(readableStatus);

    statusEl.textContent = status;
    speedEl.textContent = rounded <= 3 ? "Стоянка" : `${rounded} км/ч`;

    if (rounded <= 3 || status === "Стоянка") {
      mini.classList.add("is-idle");
    } else if (["Торможение", "Сбавь скорость"].includes(status)) {
      mini.classList.add("is-alert");
    } else if (["Плотный поток", "Нестабильно", "Частые остановки", "Резкий разгон"].includes(status)) {
      mini.classList.add("is-warning");
    } else if (status === "Норма" || status === "Движение") {
      mini.classList.add("is-quiet");
    }
  };
})();



// ==== Attention mini initial state ====
(function () {
  function initAttentionMini() {
    if (typeof window.updateAttentionMini === "function") {
      window.updateAttentionMini({ speed: NaN, status: "Ожидание", gpsOk: false });
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAttentionMini);
  } else {
    initAttentionMini();
  }
})();



// ==== Final clean mini-line behavior ====
(function () {
  const PRIORITY = {
    "Торможение": 5, "Сбавь скорость": 5,
    "Резкий разгон": 4,
    "Плотный поток": 3, "Нестабильно": 3, "Частые остановки": 3,
    "Движение": 1, "Стоянка": 1,
    "Стабильно": 0, "Норма": 0, "Ожидание": 0, "": 0
  };

  let heldStatus = "";
  let holdUntil = 0;

  function priority(status) {
    return PRIORITY[status] ?? 0;
  }

  function resolveStatus(nextStatus) {
    const now = Date.now();

    if (priority(nextStatus) >= 3) {
      heldStatus = nextStatus;
      holdUntil = now + 2200;
      return heldStatus;
    }

    if (now < holdUntil && priority(heldStatus) > priority(nextStatus)) {
      return heldStatus;
    }

    heldStatus = nextStatus;
    return heldStatus;
  }

  window.updateAttentionMini = function (payload) {
    const mini = document.getElementById("attention-mini");
    const statusEl = document.getElementById("attention-mini-status");
    const speedEl = document.getElementById("attention-mini-speed");
    const dotEl = mini ? mini.querySelector(".attention-mini__dot") : null;

    if (!mini || !statusEl || !speedEl || !payload) return;

    const speed = Number(payload.speed);
    const gpsOk = payload.gpsOk !== false;

    mini.classList.remove("is-idle", "is-warning", "is-alert", "is-quiet");

    if (!gpsOk || !Number.isFinite(speed) || speed <= 3) {
      statusEl.textContent = "";
      speedEl.textContent = "";
      if (dotEl) dotEl.style.display = "none";
      mini.style.opacity = "0";
      mini.style.transform = "translate3d(-50%, 10px, 0) scale(0.96)";
      return;
    }

    mini.style.opacity = "";
    mini.style.transform = "";

    const rounded = Math.max(0, Math.round(speed));
    const rawStatus = payload.status || "";
    const readableStatus = rawStatus === "Стабильно" ? "Норма" : rawStatus;
    const status = resolveStatus(readableStatus || "Норма");

    statusEl.textContent = status;
    speedEl.textContent = `${rounded} км/ч`;
    if (dotEl) dotEl.style.display = "";

    if (["Торможение", "Сбавь скорость"].includes(status)) {
      mini.classList.add("is-alert");
    } else if (["Плотный поток", "Нестабильно", "Частые остановки", "Резкий разгон"].includes(status)) {
      mini.classList.add("is-warning");
    } else {
      mini.classList.add("is-quiet");
    }
  };

  function hideMiniOnLoad() {
    const mini = document.getElementById("attention-mini");
    const statusEl = document.getElementById("attention-mini-status");
    const speedEl = document.getElementById("attention-mini-speed");
    if (statusEl) statusEl.textContent = "";
    if (speedEl) speedEl.textContent = "";
    if (mini) {
      mini.style.opacity = "0";
      mini.style.transform = "translate3d(-50%, 10px, 0) scale(0.96)";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", hideMiniOnLoad);
  } else {
    hideMiniOnLoad();
  }
})();
// ==== Final clean mini-line behavior END ====



/* ==========================================================
   TESLA WEATHER CACHE MODE
   - погода появляется сразу из кэша
   - свежие данные обновляются в фоне
   - координаты берутся из TomskTeslaGPS
   - без частых запросов к погодному API
   ========================================================== */

(function () {
  const WEATHER_CACHE_KEY = "tomsk_tesla_weather_cache_v2";
  const WEATHER_CACHE_TTL = 1000 * 60 * 10; // 10 минут

  function readWeatherCache() {
    try {
      const raw = localStorage.getItem(WEATHER_CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.value) return null;
      if (Date.now() - data.savedAt > WEATHER_CACHE_TTL) return null;
      return data.value;
    } catch {
      return null;
    }
  }

  function saveWeatherCache(value) {
    try {
      localStorage.setItem(
        WEATHER_CACHE_KEY,
        JSON.stringify({
          savedAt: Date.now(),
          value
        })
      );
    } catch {}
  }

  function weatherText(code) {
    if (code === 0) return "Ясно";
    if ([1, 2].includes(code)) return "Переменная облачность";
    if (code === 3) return "Облачно";
    if ([45, 48].includes(code)) return "Туман";
    if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "Осадки";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "Снег";
    if ([95, 96, 99].includes(code)) return "Гроза";
    return "Погода";
  }

  function renderWeatherSafe(weather, fromCache) {
    const temp = Math.round(weather.temp);
    const wind = weather.wind != null ? Math.round(weather.wind) : "—";
    const desc = weatherText(weather.code);

    const candidates = {
      temp: ["weatherTemp", "weather-value", "weatherTemperature", "tempValue"],
      desc: ["weatherDesc", "weather-status", "weatherText", "weatherDescription"],
      wind: ["weatherWind", "windValue"],
      updated: ["weatherUpdated", "weatherUpdate", "weatherTime"]
    };

    function setText(ids, value) {
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
      }
    }

    setText(candidates.temp, `${temp}°`);
    setText(candidates.desc, desc);
    setText(candidates.wind, wind === "—" ? "—" : `${wind} км/ч`);
    setText(candidates.updated, fromCache ? "из кэша" : "сейчас");

    const weatherPanel = document.getElementById("weatherPanelText");
    if (weatherPanel) {
      weatherPanel.textContent = `${desc}. Температура ${temp}°C, ветер ${wind} км/ч.`;
    }

    document.documentElement.dataset.weatherReady = "true";
  }

  async function fetchWeatherByCoords(coords) {
    const lat = coords.lat;
    const lon = coords.lon;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,wind_speed_10m,precipitation,relative_humidity_2m&timezone=auto`;

    const res = await fetch(url);
    const data = await res.json();
    const current = data.current || {};

    return {
      temp: current.temperature_2m,
      code: current.weather_code,
      wind: current.wind_speed_10m,
      rain: current.precipitation,
      humidity: current.relative_humidity_2m,
      time: current.time
    };
  }

  async function updateWeather(force) {
    if (!force) {
      const cached = readWeatherCache();
      if (cached) renderWeatherSafe(cached, true);
    }

    try {
      const coords = window.TomskTeslaGPS
        ? await window.TomskTeslaGPS.getDashboardCoords()
        : { lat: 56.4846, lon: 84.9486 };

      const fresh = await fetchWeatherByCoords(coords);
      saveWeatherCache(fresh);
      renderWeatherSafe(fresh, false);
    } catch (e) {
      const cached = readWeatherCache();
      if (cached) renderWeatherSafe(cached, true);
    }
  }

  window.TomskTeslaWeather = {
    updateWeather,
    clearWeatherCache: () => {
      try { localStorage.removeItem(WEATHER_CACHE_KEY); } catch {}
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => updateWeather(false), 400);
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!target) return;

    const text = String(target.textContent || "");
    const id = target.id || "";

    if (
      id === "refreshWeatherBtn" ||
      text.includes("Обновить погоду") ||
      text.includes("Погода")
    ) {
      updateWeather(true);
    }

    if (
      id === "clearCacheBtn" ||
      text.includes("Очистить кэш")
    ) {
      try { localStorage.removeItem(WEATHER_CACHE_KEY); } catch {}
    }
  });
})();



/* ==========================================================
   SAFE UX: кнопка «Внимание» работает как toggle
   - первое нажатие: открыть шторку
   - второе нажатие: закрыть шторку
   - GPS не запрашивается лишний раз при закрытии
   ========================================================== */
(function () {
  let attentionOpen = false;
  let lastClickAt = 0;

  function findAttentionButton() {
    const buttons = Array.from(document.querySelectorAll("button, .app-btn, [role='button'], [data-panel]"));
    return buttons.find((el) => {
      const text = String(el.textContent || "").trim();
      const panel = el.dataset?.panel || "";
      return text.includes("Внимание") || panel === "attention" || panel === "attentionPanel" || el.id === "attentionBtn";
    });
  }

  function findAttentionPanel() {
    const candidates = Array.from(document.querySelectorAll("section, aside, div"));
    return candidates.find((el) => {
      const text = String(el.textContent || "");
      const id = String(el.id || "").toLowerCase();
      const cls = String(el.className || "").toLowerCase();

      const looksLikePanel =
        id.includes("attention") ||
        cls.includes("attention") ||
        text.includes("СОСТОЯНИЕ ДВИЖЕНИЯ") ||
        text.includes("Состояние движения");

      const isNotButton = !el.matches("button, .app-btn, [role='button']");

      return looksLikePanel && isNotButton;
    });
  }

  function isPanelVisible(panel) {
    if (!panel) return false;
    const style = window.getComputedStyle(panel);
    const rect = panel.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function closeAttentionPanel() {
    const panel = findAttentionPanel();

    if (panel) {
      panel.classList.remove("open", "active", "show", "visible", "is-open");
      panel.setAttribute("aria-hidden", "true");
    }

    document.body.classList.remove("attention-open");
    const btn = findAttentionButton();
    if (btn) {
      btn.classList.remove("is-active", "active", "open");
      btn.setAttribute("aria-expanded", "false");
    }

    const gpsOverlay = document.getElementById("teslaGpsOverlay");
    if (gpsOverlay) gpsOverlay.classList.remove("open");

    attentionOpen = false;
  }

  function markAttentionOpen() {
    const btn = findAttentionButton();
    if (btn) {
      btn.id = "attentionBtn";
      btn.setAttribute("aria-expanded", "true");
    }
    document.body.classList.add("attention-open");
    attentionOpen = true;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = findAttentionButton();
    if (btn) {
      btn.id = "attentionBtn";
      btn.setAttribute("aria-expanded", "false");
    }
  });

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!target) return;

      const btn = target.closest ? target.closest("button, .app-btn, [role='button'], [data-panel]") : null;
      if (!btn) return;

      const text = String(btn.textContent || "");
      const panel = btn.dataset?.panel || "";

      const isAttention =
        btn.id === "attentionBtn" ||
        panel === "attention" ||
        panel === "attentionPanel" ||
        text.includes("Внимание");

      if (!isAttention) return;

      const now = Date.now();
      if (now - lastClickAt < 250) return;
      lastClickAt = now;

      const attentionPanel = findAttentionPanel();
      const visible = isPanelVisible(attentionPanel) || attentionOpen;

      if (visible) {
        event.preventDefault();
        event.stopPropagation();
        closeAttentionPanel();
        return;
      }

      setTimeout(markAttentionOpen, 250);
    },
    true
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && attentionOpen) {
      closeAttentionPanel();
    }
  });
})();






/* ==========================================================
   AUTO GPS — safe car mode
   - не ломает кнопку «Внимание»
   - GPS появляется отдельной карточкой
   - автообновление только когда карточка открыта
   - запрос не чаще 1 раза в 60 секунд
   ========================================================== */
(function () {
  const CACHE_KEY = "tomsk_auto_gps_cache";
  const CACHE_TTL = 1000 * 60 * 10;
  const MIN_INTERVAL = 1000 * 60;
  const AUTO_REFRESH_INTERVAL = 1000 * 60;

  let visible = false;
  let busy = false;
  let lastRequestAt = 0;
  let autoTimer = null;

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.savedAt > CACHE_TTL) return null;
      return data;
    } catch {
      return null;
    }
  }

  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        ...data,
        savedAt: Date.now()
      }));
    } catch {}
  }

  function createOverlay() {
    let overlay = document.getElementById("gpsSafeOverlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "gpsSafeOverlay";
    overlay.innerHTML = `
      <div class="gps-safe-card">
        <div class="gps-safe-title">GPS</div>
        <div class="gps-safe-line">
          <span>Статус</span>
          <b id="gpsSafeStatus">Ожидание</b>
        </div>
        <div class="gps-safe-line">
          <span>Состояние</span>
          <b id="gpsSafeMotion">Стоянка</b>
        </div>
        <div class="gps-safe-line">
          <span>Точность</span>
          <b id="gpsSafeAccuracy">—</b>
        </div>
        <div class="gps-safe-line">
          <span>Обновление</span>
          <b id="gpsSafeUpdated">—</b>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function render(data, status) {
    createOverlay();

    setText("gpsSafeStatus", status || "Ожидание");

    if (!data) {
      setText("gpsSafeMotion", "Стоянка");
      setText("gpsSafeAccuracy", "—");
      setText("gpsSafeUpdated", "—");
      return;
    }

    const speed = data.speed || 0;
    const motionData = window.TomskKalmanGPS
      ? window.TomskKalmanGPS.getMotionBySpeed(speed)
      : { motion: (speed * 3.6 < 3 ? "Стоянка" : "Движение"), kmh: speed * 3.6 };

    setText("gpsSafeMotion", motionData.motion);
    setText("gpsSafeAccuracy", data.accuracy ? `≈ ${Math.round(data.accuracy)} м` : "—");

    const date = new Date(data.savedAt || Date.now());
    setText(
      "gpsSafeUpdated",
      date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
    );
  }

  function canRequest() {
    return Date.now() - lastRequestAt > MIN_INTERVAL;
  }

  function requestGps(force = false) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }

      if (busy || (!force && !canRequest())) {
        resolve(readCache());
        return;
      }

      busy = true;
      lastRequestAt = Date.now();

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          busy = false;
          const data = {
            accuracy: pos.coords.accuracy,
            speed: pos.coords.speed || 0,
            savedAt: Date.now()
          };
          saveCache(data);
          resolve(data);
        },
        () => {
          busy = false;
          resolve(readCache());
        },
        {
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 1000 * 60 * 5
        }
      );
    });
  }

  async function refreshGps(force = false) {
    const cached = readCache();

    if (cached) render(cached, "Из кэша");
    else render(null, "Обновление…");

    const fresh = await requestGps(force);

    if (!visible) return;

    if (fresh) render(fresh, "Активен");
    else render(null, "Нет доступа");
  }

  function startAutoGps() {
    stopAutoGps();
    autoTimer = setInterval(() => {
      if (visible) refreshGps(false);
    }, AUTO_REFRESH_INTERVAL);
  }

  function stopAutoGps() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  async function showGpsOverlay() {
    visible = true;
    const overlay = createOverlay();
    overlay.classList.add("show");

    await refreshGps(true);
    startAutoGps();
  }

  function hideGpsOverlay() {
    visible = false;
    stopAutoGps();

    const overlay = document.getElementById("gpsSafeOverlay");
    if (overlay) overlay.classList.remove("show");
  }

  function isAttentionButtonClick(event) {
    const target = event.target;
    if (!target) return false;

    const btn = target.closest ? target.closest("button, .app-btn, [role='button'], [data-panel]") : null;
    if (!btn) return false;

    const text = String(btn.textContent || "");
    const panel = btn.dataset?.panel || "";

    return (
      btn.id === "attentionBtn" ||
      panel === "attention" ||
      panel === "attentionPanel" ||
      text.includes("Внимание")
    );
  }

  document.addEventListener("DOMContentLoaded", () => {
    createOverlay();
    const cached = readCache();
    if (cached) render(cached, "Из кэша");
  });

  // Не ломаем кнопку: не preventDefault и не stopPropagation
  document.addEventListener("click", (event) => {
    if (!isAttentionButtonClick(event)) return;

    setTimeout(() => {
      const expanded = document.getElementById("attentionBtn")?.getAttribute("aria-expanded");
      const shouldShow = expanded === "true" || document.body.classList.contains("attention-open");

      if (shouldShow) showGpsOverlay();
      else hideGpsOverlay();
    }, 420);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideGpsOverlay();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAutoGps();
    else if (visible) startAutoGps();
  });

  window.TomskAutoGPS = {
    show: showGpsOverlay,
    hide: hideGpsOverlay,
    refresh: () => refreshGps(true),
    clear: () => localStorage.removeItem(CACHE_KEY)
  };
})();



/* ==========================================================
   GPS -> WEATHER LINK
   - погода берёт координаты из GPS
   - если GPS недоступен: IP fallback
   - если всё недоступно: Томск
   - кэш координат и погоды
   ========================================================== */
(function () {
  const GPS_WEATHER_CACHE = "tomsk_gps_weather_coords_v1";
  const WEATHER_CACHE = "tomsk_gps_weather_data_v1";
  const COORDS_TTL = 1000 * 60 * 20;
  const WEATHER_TTL = 1000 * 60 * 10;
  const DEFAULT = { lat: 56.4846, lon: 84.9486, city: "Томск", source: "default" };

  function readCache(key, ttl) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.savedAt > ttl) return null;
      return data.value;
    } catch {
      return null;
    }
  }

  function saveCache(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }));
    } catch {}
  }

  function getGpsCoords() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            source: "gps"
          });
        },
        () => resolve(null),
        {
          enableHighAccuracy: false,
          timeout: 7000,
          maximumAge: 1000 * 60 * 10
        }
      );
    });
  }

  async function getIpCoords() {
    try {
      const res = await fetch("https://ipapi.co/json/");
      const data = await res.json();
      if (!data.latitude || !data.longitude) return null;

      return {
        lat: data.latitude,
        lon: data.longitude,
        city: data.city || "Город",
        source: "ip"
      };
    } catch {
      return null;
    }
  }

  async function getBestCoords(force = false) {
    if (!force) {
      const cached = readCache(GPS_WEATHER_CACHE, COORDS_TTL);
      if (cached) return cached;
    }

    let coords = await getGpsCoords();

    if (!coords) {
      coords = await getIpCoords();
    }

    if (!coords) {
      coords = DEFAULT;
    }

    saveCache(GPS_WEATHER_CACHE, coords);
    return coords;
  }

  function weatherInfo(code) {
    if (code === 0) return { text: "Ясно", icon: "☀️" };
    if ([1,2].includes(code)) return { text: "Переменная облачность", icon: "🌤️" };
    if (code === 3) return { text: "Пасмурно", icon: "☁️" };
    if ([45,48].includes(code)) return { text: "Туман", icon: "🌫️" };
    if ([51,53,55,61,63,65,80,81,82].includes(code)) return { text: "Дождь", icon: "🌧️" };
    if ([71,73,75,77,85,86].includes(code)) return { text: "Снег", icon: "❄️" };
    if ([95,96,99].includes(code)) return { text: "Гроза", icon: "⛈️" };
    return { text: "Погода", icon: "☁️" };
  }

  async function fetchWeather(coords) {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&current=temperature_2m,weather_code,wind_speed_10m,precipitation,relative_humidity_2m&timezone=auto`;

    const res = await fetch(url);
    const data = await res.json();
    const c = data.current || {};

    return {
      temp: Math.round(c.temperature_2m),
      code: c.weather_code,
      wind: Math.round(c.wind_speed_10m || 0),
      rain: c.precipitation ?? 0,
      humidity: c.relative_humidity_2m ?? null,
      city: coords.city || (coords.source === "gps" ? "GPS" : DEFAULT.city),
      source: coords.source,
      time: c.time || new Date().toISOString()
    };
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function renderWeather(w, fromCache) {
    if (!w) return;

    const info = weatherInfo(w.code);

    setText("weatherTemp", `${w.temp}°`);
    setText("weatherIcon", info.icon);
    setText("weatherDesc", info.text);
    setText("weatherWind", `${w.wind} км/ч`);
    setText("weatherRain", `${w.rain} мм`);
    setText("weatherUpdated", fromCache ? "из кэша" : "сейчас");

    // город: если GPS — не пишем "GPS", оставляем текущий город/Томск
    const cityText = w.city && w.city !== "GPS" ? w.city : "Томск";
    setText("weatherCity", cityText.toUpperCase());
    setText("cityName", cityText.toUpperCase());
    setText("locationName", cityText.toUpperCase());
    setText("weatherLocation", cityText.toUpperCase());

    const panel = document.getElementById("weatherPanelText");
    if (panel) {
      panel.textContent = `${info.text}. Температура ${w.temp}°C, ветер ${w.wind} км/ч, осадки ${w.rain} мм.`;
    }
  }

  async function updateGpsWeather(force = false) {
    if (!force) {
      const cachedWeather = readCache(WEATHER_CACHE, WEATHER_TTL);
      if (cachedWeather) renderWeather(cachedWeather, true);
    }

    try {
      const coords = await getBestCoords(force);
      const weather = await fetchWeather(coords);
      saveCache(WEATHER_CACHE, weather);
      renderWeather(weather, false);
      return weather;
    } catch {
      const cachedWeather = readCache(WEATHER_CACHE, WEATHER_TTL);
      if (cachedWeather) renderWeather(cachedWeather, true);
    }
  }

  window.TomskGpsWeather = {
    update: updateGpsWeather,
    clear: () => {
      localStorage.removeItem(GPS_WEATHER_CACHE);
      localStorage.removeItem(WEATHER_CACHE);
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => updateGpsWeather(false), 900);
  });

  document.addEventListener("click", (event) => {
    const text = String(event.target?.textContent || "");
    const id = event.target?.id || "";

    if (id === "refreshWeatherBtn" || text.includes("Обновить погоду") || text.includes("Погода")) {
      setTimeout(() => updateGpsWeather(true), 250);
    }
  });
})();



/* ==========================================================
   YANDEX-LIKE WEATHER TEXT
   - подача погоды человеческим языком
   - ощущается как
   - ветер/осадки/влажность словами
   - не меняет GPS, кнопку «Внимание» и плеер
   ========================================================== */
(function () {
  function feelsLike(temp, wind, humidity) {
    let feels = Number(temp);
    const w = Number(wind || 0);
    const h = Number(humidity || 50);

    if (w > 15) feels -= 3;
    else if (w > 8) feels -= 2;
    else if (w > 4) feels -= 1;

    if (h > 80 && temp < 10) feels -= 1;
    if (h > 80 && temp > 20) feels += 1;

    return Math.round(feels);
  }

  function windText(wind) {
    const w = Number(wind || 0);
    if (w < 5) return "ветер слабый";
    if (w < 15) return "ветер умеренный";
    if (w < 28) return "ветер заметный";
    return "ветер сильный";
  }

  function rainText(rain, code) {
    const r = Number(rain || 0);

    if ([71, 73, 75, 77, 85, 86].includes(code)) {
      if (r <= 0) return "возможен снег";
      if (r < 1) return "лёгкий снег";
      return "снег";
    }

    if ([95, 96, 99].includes(code)) return "возможна гроза";

    if (r <= 0) {
      if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "возможен дождь";
      return "без осадков";
    }

    if (r < 0.5) return "морось";
    if (r < 2) return "лёгкий дождь";
    return "дождь";
  }

  function humidityText(humidity) {
    const h = Number(humidity || 0);
    if (!h) return "";
    if (h < 35) return "сухо";
    if (h < 70) return "комфортно";
    return "сыро";
  }

  function findWeatherTemp() {
    const ids = ["weatherTemp", "weatherTemperature", "tempValue"];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const match = String(el.textContent || "").match(/-?\d+/);
      if (match) return Number(match[0]);
    }
    return null;
  }

  function readWeatherFromDOM() {
    const temp = findWeatherTemp();

    let desc = "";
    const descEl = document.getElementById("weatherDesc") || document.querySelector(".weather-desc");
    if (descEl) desc = String(descEl.textContent || "").trim();

    let wind = 0;
    const windEl = document.getElementById("weatherWind");
    if (windEl) {
      const m = String(windEl.textContent || "").match(/\d+/);
      if (m) wind = Number(m[0]);
    }

    let rain = 0;
    const rainEl = document.getElementById("weatherRain");
    if (rainEl) {
      const m = String(rainEl.textContent || "").replace(",", ".").match(/\d+(\.\d+)?/);
      if (m) rain = Number(m[0]);
    }

    return { temp, desc, wind, rain, humidity: null, code: null };
  }

  function ensureYandexLine() {
    let line = document.getElementById("yandexWeatherLine");
    if (line) return line;

    const weatherCard = document.querySelector(".weather-card") || document.querySelector("[class*='weather']");
    if (!weatherCard) return null;

    line = document.createElement("div");
    line.id = "yandexWeatherLine";
    line.className = "yandex-weather-line";

    const desc = document.getElementById("weatherDesc") || weatherCard.querySelector(".weather-desc");
    if (desc && desc.parentElement) {
      desc.insertAdjacentElement("afterend", line);
    } else {
      weatherCard.appendChild(line);
    }

    return line;
  }

  function ensureDetailsLine() {
    let line = document.getElementById("yandexWeatherDetails");
    if (line) return line;

    const weatherCard = document.querySelector(".weather-card") || document.querySelector("[class*='weather']");
    if (!weatherCard) return null;

    line = document.createElement("div");
    line.id = "yandexWeatherDetails";
    line.className = "yandex-weather-details";

    const mainLine = ensureYandexLine();
    if (mainLine) mainLine.insertAdjacentElement("afterend", line);
    else weatherCard.appendChild(line);

    return line;
  }

  function renderYandexWeather(weather) {
    if (!weather) weather = readWeatherFromDOM();

    if (weather.temp == null || Number.isNaN(weather.temp)) return;

    const f = feelsLike(weather.temp, weather.wind, weather.humidity);
    const wind = windText(weather.wind);
    const rain = rainText(weather.rain, weather.code);
    const humidity = humidityText(weather.humidity);

    const line = ensureYandexLine();
    if (line) {
      line.textContent = `ощущается как ${f}°`;
    }

    const details = ensureDetailsLine();
    if (details) {
      details.textContent = humidity ? `${wind} · ${rain} · ${humidity}` : `${wind} · ${rain}`;
    }

    const panel = document.getElementById("weatherPanelText");
    if (panel) {
      const desc = weather.desc || (document.getElementById("weatherDesc")?.textContent || "Погода");
      panel.textContent = `${desc}. Ощущается как ${f}°. ${wind}, ${rain}${humidity ? ", " + humidity : ""}.`;
    }
  }

  // Перехватываем renderWeather мягко, если он глобальный
  const oldRender = window.renderWeather;
  if (typeof oldRender === "function") {
    window.renderWeather = function (w, fromCache) {
      oldRender.apply(this, arguments);
      setTimeout(() => renderYandexWeather(w), 50);
    };
  }

  // Перехватываем обновление GPS-погоды, если модуль есть
  function patchGpsWeather() {
    if (!window.TomskGpsWeather || window.TomskGpsWeather.__yandexPatched) return;

    const oldUpdate = window.TomskGpsWeather.update;
    if (typeof oldUpdate === "function") {
      window.TomskGpsWeather.update = async function () {
        const result = await oldUpdate.apply(this, arguments);
        setTimeout(() => renderYandexWeather(result), 80);
        return result;
      };
      window.TomskGpsWeather.__yandexPatched = true;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(patchGpsWeather, 300);
    setTimeout(() => renderYandexWeather(), 1200);
    setTimeout(() => renderYandexWeather(), 2500);
  });

  document.addEventListener("click", (event) => {
    const text = String(event.target?.textContent || "");
    const id = event.target?.id || "";
    if (id === "refreshWeatherBtn" || text.includes("Погода") || text.includes("Обновить погоду")) {
      setTimeout(patchGpsWeather, 100);
      setTimeout(() => renderYandexWeather(), 1200);
    }
  });

  // если данные погоды перерисовались другим кодом — мягко обновим текст
  const observer = new MutationObserver(() => {
    clearTimeout(window.__yandexWeatherTimer);
    window.__yandexWeatherTimer = setTimeout(() => renderYandexWeather(), 120);
  });

  document.addEventListener("DOMContentLoaded", () => {
    const card = document.querySelector(".weather-card") || document.querySelector("[class*='weather']");
    if (card) {
      observer.observe(card, { childList: true, subtree: true, characterData: true });
    }
  });
})();



/* ==========================================================
   GPS FORCE FIX FOR iPHONE
   - принудительный запуск GPS через watchPosition
   - координаты сохраняются в кэш погоды
   - обновляет погоду по GPS
   - не трогает кнопку «Внимание»
   ========================================================== */
(function () {
  const GPS_WEATHER_CACHE = "tomsk_gps_weather_coords_v1";
  const WEATHER_CACHE = "tomsk_gps_weather_data_v1";

  let watchId = null;
  let lastWeatherUpdateAt = 0;
  const WEATHER_INTERVAL = 1000 * 60 * 5;

  const DEFAULT = {
    lat: 56.4846,
    lon: 84.9486,
    city: "Томск",
    source: "default"
  };

  function saveCache(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({
        savedAt: Date.now(),
        value
      }));
    } catch {}
  }

  function weatherInfo(code) {
    if (code === 0) return { text: "Ясно", icon: "☀️" };
    if ([1, 2].includes(code)) return { text: "Переменная облачность", icon: "🌤️" };
    if (code === 3) return { text: "Пасмурно", icon: "☁️" };
    if ([45, 48].includes(code)) return { text: "Туман", icon: "🌫️" };
    if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return { text: "Дождь", icon: "🌧️" };
    if ([71, 73, 75, 77, 85, 86].includes(code)) return { text: "Снег", icon: "❄️" };
    if ([95, 96, 99].includes(code)) return { text: "Гроза", icon: "⛈️" };
    return { text: "Погода", icon: "☁️" };
  }

  async function reverseCity(lat, lon) {
    try {
      if (window.TomskBigDataCloud?.getCity) {
        const bdcCity = await window.TomskBigDataCloud.getCity(lat, lon);
        if (bdcCity) {
          window.TomskBigDataCloud.setCityUI(bdcCity);
          return bdcCity;
        }
      }

      const url =
        `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}` +
        `&longitude=${lon}&language=ru&format=json`;

      const res = await fetch(url);
      const data = await res.json();
      const first = data.results && data.results[0];

      return first?.name || DEFAULT.city;
    } catch {
      return DEFAULT.city;
    }
  }

  async function fetchWeather(lat, lon, city) {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,relative_humidity_2m&timezone=auto`;

    const res = await fetch(url);
    const data = await res.json();
    const c = data.current || {};

    return {
      temp: Math.round(c.temperature_2m),
      feels: Math.round(c.apparent_temperature ?? c.temperature_2m),
      code: c.weather_code,
      wind: Math.round(c.wind_speed_10m || 0),
      rain: c.precipitation ?? 0,
      humidity: c.relative_humidity_2m ?? null,
      city: city || DEFAULT.city,
      source: "gps",
      time: c.time || new Date().toISOString()
    };
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function updateCityUI(city) {
    const value = (city || DEFAULT.city).toUpperCase();

    ["weatherCity", "cityName", "locationName", "weatherLocation"].forEach((id) => {
      setText(id, value);
    });

    document.querySelectorAll(".weather-city").forEach((el) => {
      el.textContent = value;
    });
  }

  function updateWeatherUI(w) {
    if (!w) return;

    const info = weatherInfo(w.code);

    setText("weatherTemp", `${w.temp}°`);
    setText("weatherIcon", info.icon);
    setText("weatherDesc", info.text);
    setText("weatherWind", `${w.wind} км/ч`);
    setText("weatherRain", `${w.rain} мм`);
    setText("weatherUpdated", "по GPS");
    updateCityUI(w.city);

    const panel = document.getElementById("weatherPanelText");
    if (panel) {
      panel.textContent = `${info.text}. Ощущается как ${w.feels}°. Ветер ${w.wind} км/ч, осадки ${w.rain} мм.`;
    }

    const yLine = document.getElementById("yandexWeatherLine");
    if (yLine) yLine.textContent = `ощущается как ${w.feels}°`;

    const yDetails = document.getElementById("yandexWeatherDetails");
    if (yDetails) {
      const windText = w.wind < 5 ? "ветер слабый" : w.wind < 15 ? "ветер умеренный" : "ветер заметный";
      const rainText = Number(w.rain || 0) <= 0 ? "без осадков" : Number(w.rain) < 1 ? "лёгкий дождь" : "дождь";
      const humText = w.humidity == null ? "" : (w.humidity < 35 ? "сухо" : w.humidity < 70 ? "комфортно" : "сыро");
      yDetails.textContent = humText ? `${windText} · ${rainText} · ${humText}` : `${windText} · ${rainText}`;
    }
  }

  async function updateWeatherFromCoords(lat, lon) {
    if (Date.now() - lastWeatherUpdateAt < WEATHER_INTERVAL) return;
    lastWeatherUpdateAt = Date.now();

    try {
      const city = await reverseCity(lat, lon);

      const coords = {
        lat,
        lon,
        city,
        source: "gps",
        accuracy: window.__tomskLastGpsAccuracy || null
      };

      saveCache(GPS_WEATHER_CACHE, coords);
      updateCityUI(city);

      const weather = await fetchWeather(lat, lon, city);
      saveCache(WEATHER_CACHE, weather);
      updateWeatherUI(weather);

      if (window.TomskAttentionGpsStatus?.update) {
        window.TomskAttentionGpsStatus.update();
      }
    } catch (e) {
      console.log("GPS weather update failed:", e);
    }
  }

  function updateMotionUI(pos) {
    const speed = pos.coords.speed || 0;
    const motionData = window.TomskKalmanGPS
      ? window.TomskKalmanGPS.getMotionBySpeed(speed)
      : { motion: (speed * 3.6 < 3 ? "Стоянка" : "Движение"), kmh: speed * 3.6 };
    const kmh = motionData.kmh;
    const motion = motionData.motion;

    window.__tomskLastGpsAccuracy = pos.coords.accuracy;

    setText("gpsSafeStatus", "Активен");
    setText("gpsSafeMotion", motion);
    setText("gpsSafeAccuracy", pos.coords.accuracy ? `≈ ${Math.round(pos.coords.accuracy)} м` : "—");

    const updated = document.getElementById("gpsSafeUpdated");
    if (updated) {
      updated.textContent = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    }

    const candidates = Array.from(document.querySelectorAll("strong, b, div, span, p"));
    const motionEl = candidates.find((el) => {
      const t = String(el.textContent || "").trim();
      return t === "Стоянка" || t === "Движение";
    });

    if (motionEl) motionEl.textContent = motion;
  }

  function startGpsForce() {
    if (!navigator.geolocation) {
      console.log("GPS not supported");
      return;
    }

    if (watchId !== null) return;

    try {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;

          console.log("Tomsk GPS OK:", lat, lon, "accuracy:", pos.coords.accuracy);

          updateMotionUI(pos);
          updateWeatherFromCoords(lat, lon);
        },
        (err) => {
          console.log("Tomsk GPS ERROR:", err.code, err.message);
          setText("gpsSafeStatus", "Нет доступа");
        },
        {
          enableHighAccuracy: true,
          maximumAge: 1000 * 60 * 2,
          timeout: 15000
        }
      );
    } catch (e) {
      console.log("Tomsk GPS start failed:", e);
    }
  }

  function stopGpsForce() {
    if (watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  window.TomskGPSForceFix = {
    start: startGpsForce,
    stop: stopGpsForce,
    refresh: () => {
      stopGpsForce();
      setTimeout(startGpsForce, 250);
    }
  };

  window.addEventListener("load", () => {
    setTimeout(startGpsForce, 1000);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopGpsForce();
    } else {
      setTimeout(startGpsForce, 500);
    }
  });

  document.addEventListener("click", () => {
    startGpsForce();
  }, { once: true });
})();



/* ==========================================================
   TIGGO / ANDROID MODE
   - Android WebView / Tiggo ready
   - safe bridge hooks
   ========================================================== */
(function () {
  const isAndroid =
    /Android/i.test(navigator.userAgent) ||
    !!window.Android ||
    !!window.TiggoBridge;

  function callBridge(method, ...args) {
    const bridge = window.Android || window.TiggoBridge;
    try {
      if (bridge && typeof bridge[method] === "function") {
        return bridge[method](...args);
      }
    } catch (e) {
      console.log("Bridge error:", method, e);
    }
    return null;
  }

  function enterFullscreen() {
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } catch {}
  }

  function setupMediaBridge() {
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      if (target.id === "playerPlay") callBridge("playPause");
      if (target.id === "playerNext") callBridge("next");
      if (target.id === "playerPrev") callBridge("prev");
    });
  }

  window.onAndroidMediaUpdate = function (title, artist, source) {
    const titleEl = document.getElementById("trackTitle") || document.querySelector(".track-title");
    const artistEl = document.getElementById("trackArtist") || document.querySelector(".track-artist");
    const sourceEl = document.getElementById("trackSource") || document.querySelector(".track-source");

    if (titleEl && title) titleEl.textContent = title;
    if (artistEl && artist) artistEl.textContent = artist;
    if (sourceEl && source) sourceEl.textContent = source;
  };

  window.onAndroidLocation = function (lat, lon, accuracy, speed) {
    try {
      const speedValue = Number(speed || 0);
      const motionData = window.TomskKalmanGPS
        ? window.TomskKalmanGPS.getMotionBySpeed(speedValue)
        : { motion: speedValue * 3.6 < 3 ? "Стоянка" : "Движение" };

      const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
      };

      setText("gpsSafeStatus", "Активен");
      setText("gpsSafeMotion", motionData.motion);
      setText("gpsSafeAccuracy", accuracy ? `≈ ${Math.round(Number(accuracy))} м` : "—");
    } catch (e) {
      console.log("Android location update error:", e);
    }
  };

  window.TomskTiggo = {
    enterFullscreen,
    callBridge,
    isAndroid: () => isAndroid
  };

  window.addEventListener("load", () => {
    document.body.classList.add("tiggo-mode");
    if (isAndroid) document.body.classList.add("android-mode");
    setupMediaBridge();
    setTimeout(() => callBridge("ready"), 500);
  });

  document.addEventListener("click", () => {
    if (isAndroid) enterFullscreen();
  }, { once: true });
})();



/* ==========================================================
   SOFT PLAYER POLISH
   - спокойная полировка плеера
   - без перегруза
   - Android Bridge остаётся
   ========================================================== */
(function () {
  function findPlayer() {
    return (
      document.querySelector(".media-player") ||
      document.querySelector(".player") ||
      document.querySelector("[class*='player']") ||
      document.querySelector("[class*='music']") ||
      null
    );
  }

  function applySoftPlayer() {
    const player = findPlayer();
    if (!player) return;

    player.classList.add("soft-player-ui");

    const title =
      document.getElementById("trackTitle") ||
      player.querySelector(".track-title") ||
      player.querySelector("[data-track-title]");

    const artist =
      document.getElementById("trackArtist") ||
      player.querySelector(".track-artist") ||
      player.querySelector("[data-track-artist]");

    const source =
      document.getElementById("trackSource") ||
      player.querySelector(".track-source") ||
      player.querySelector("[data-track-source]");

    if (title) title.classList.add("soft-track-title");
    if (artist) artist.classList.add("soft-track-artist");
    if (source) source.classList.add("soft-track-source");

    player.querySelectorAll("button").forEach((btn) => {
      btn.classList.add("soft-player-btn");
    });

    player.querySelectorAll('input[type="range"]').forEach((range) => {
      range.classList.add("soft-player-range");
    });
  }

  function bridge(method) {
    const bridge = window.Android || window.TiggoBridge;
    try {
      if (bridge && typeof bridge[method] === "function") {
        bridge[method]();
        return true;
      }
    } catch {}
    return false;
  }

  function setupBridgeControls() {
    document.addEventListener("click", (event) => {
      const btn = event.target.closest("button, .soft-player-btn, [role='button']");
      if (!btn) return;

      const text = String(btn.textContent || "").toLowerCase();
      const id = String(btn.id || "").toLowerCase();
      const cls = String(btn.className || "").toLowerCase();

      if (id.includes("next") || cls.includes("next") || text.includes("⏭")) bridge("next");
      if (id.includes("prev") || cls.includes("prev") || text.includes("⏮")) bridge("prev");
      if (id.includes("play") || cls.includes("play") || text.includes("▶") || text.includes("⏸")) bridge("playPause");
    });
  }

  const oldMediaUpdate = window.onAndroidMediaUpdate;
  window.onAndroidMediaUpdate = function (title, artist, source) {
    if (typeof oldMediaUpdate === "function") {
      try { oldMediaUpdate(title, artist, source); } catch {}
    }

    setTimeout(applySoftPlayer, 50);
  };

  window.TomskSoftPlayer = {
    refresh: applySoftPlayer
  };

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(applySoftPlayer, 500);
    setupBridgeControls();
  });

  window.addEventListener("load", () => {
    setTimeout(applySoftPlayer, 800);
  });
})();

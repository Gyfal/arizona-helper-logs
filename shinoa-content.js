(function() {
    'use strict';

    const DEBUG_PREFIX = '[ShinoaHelper]';
    const INTERCEPT_EVENT = 'shinoa-player-helper';
    const ROUTE_PREFIX = '/tech/player';
    const geoCache = new Map(); // ip -> { text, lat, lon }
    const INLINE_STYLE_ID = 'shinoa-player-helper-inline-style';
    const ATTACHMENT_STYLE_ID = 'shinoa-attachment-helper-style';
    const NOTIFICATION_STYLE_ID = 'shinoa-helper-notification-style';
    const NOTIFICATION_CONTAINER_ID = 'shinoa-helper-notification-container';
    const MAX_SAFE_MONTHS = 5; // Максимальный безопасный период для логов (уменьшен из-за HTTP 504)
    const GEO_BATCH_SIZE = 30; // Размер batch для запросов геолокации
    let isPlayerRouteActive = false;
    let attachmentCache = new Map(); // accountId -> { vk: {...}, telegram: {...} }
    let emailCache = new Map(); // accountId -> { current, history, loadStatus }
    let ipLogCache = new Map(); // accountId -> { ips: [...], loadStatus }
    let lastPlayerData = null; // Сохраняем последние данные игрока для переинициализации кнопок
    let tableObserver = null; // MutationObserver для отслеживания изменений таблицы
    let lastIPAnnotation = null; // Stores last IP payload to reapply after table rerenders
    let ipAnnotationScheduled = false;
    let logsAuthNoticeShown = false;
    const notificationSeen = new Set();
    let lastAutoHydrateKey = null;

    async function sendMessageSafe(message, retries = 1, retryDelayMs = 300) {
        const wait = (ms) => new Promise((res) => setTimeout(res, ms));

        if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
            if (retries > 0) {
                await wait(retryDelayMs);
                return sendMessageSafe(message, retries - 1, retryDelayMs * 2);
            }
            throw new Error('Extension context unavailable (проверьте что расширение включено и имеет доступ к сайту)');
        }

        const attempt = () => new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, (response) => {
                const lastError = chrome.runtime.lastError;
                if (lastError) {
                    reject(new Error(lastError.message));
                    return;
                }
                resolve(response);
            });
        });

        try {
            return await attempt();
        } catch (error) {
            const isContextInvalid =
                typeof error.message === 'string' &&
                /extension context (invalidated|closed|unavailable)/i.test(error.message);

            if (isContextInvalid && retries > 0) {
                await wait(retryDelayMs);
                return sendMessageSafe(message, retries - 1, retryDelayMs * 2);
            }
            throw error;
        }
    }

    if (!location.hostname.endsWith('shinoa.tech')) {
        return;
    }

    function getOrCreateCellContainer(cell, baseValue) {
        let container = cell.querySelector('.shinoa-ip-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'shinoa-ip-container';

            const base = document.createElement('div');
            base.className = 'shinoa-ip-base';
            base.textContent = baseValue;
            container.appendChild(base);

            cell.textContent = '';
            cell.appendChild(container);
            return container;
        }

        const base = container.querySelector('.shinoa-ip-base');
        if (base) {
            base.textContent = baseValue;
        } else {
            const newBase = document.createElement('div');
            newBase.className = 'shinoa-ip-base';
            newBase.textContent = baseValue;
            container.prepend(newBase);
        }

        return container;
    }

    function getOrCreateBadge(container) {
        let badge = container.querySelector('.shinoa-ip-inline');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'shinoa-ip-inline';
            container.appendChild(badge);
        }
        return badge;
    }


    debug('Content script boot');
    injectNetworkInterceptor();
    installBridgeListener();
    setupRouteWatcher();

    function debug(...args) {
        console.log(DEBUG_PREFIX, ...args);
    }

    function isExtensionContextUnavailable(error) {
        const message = (error?.message || error || '').toString().toLowerCase();
        return message.includes('extension context unavailable');
    }

    function notifyExtensionContextUnavailableOnce() {
        if (window.__shinoaExtCtxWarned) return;
        window.__shinoaExtCtxWarned = true;
        alert('Расширение недоступно. Проверьте, что Arizona Logs & Player Helper включён и имеет доступ к logs.shinoa.tech, затем обновите страницу.');
    }

    function isLogsAuthError(error, contextUrl = '') {
        const message = (error?.message || error || '').toString().toLowerCase();
        const url = (contextUrl || '').toString().toLowerCase();

        const mentionsLogs = message.includes('logsparser') || url.includes('logsparser');
        const corsHints = message.includes('access-control-allow-origin') ||
            message.includes('cors') ||
            message.includes('failed to fetch') ||
            message.includes('blocked by client') ||
            message.includes('authenticator') ||
            message.includes('network error');
        const authStatusHints = message.includes('http 401') ||
            message.includes('http 403') ||
            message.includes('unauthorized') ||
            message.includes('forbidden');

        return mentionsLogs && (corsHints || authStatusHints);
    }

    function wrapLogsFetchError(error, contextUrl = '') {
        const normalizedError = error instanceof Error ? error : new Error(String(error || 'Unknown error'));

        if (isLogsAuthError(normalizedError, contextUrl)) {
            notifyLogsAuthRequired();
            const authError = new Error('Требуется авторизация на сайте логов');
            authError.code = 'LOGS_AUTH_REQUIRED';
            return authError;
        }

        return normalizedError;
    }

    function ensureNotificationStyles() {
        if (document.getElementById(NOTIFICATION_STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = NOTIFICATION_STYLE_ID;
        style.textContent = `
#${NOTIFICATION_CONTAINER_ID} {
    position: fixed;
    top: 18px;
    right: 18px;
    z-index: 100000;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
}

.shinoa-notify {
    position: relative;
    background: #1f2a3a;
    color: #fff;
    padding: 12px 14px 12px 16px;
    border-radius: 10px;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
    max-width: 360px;
    font-size: 13px;
    line-height: 1.45;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-left: 4px solid rgba(58, 187, 209, 0.9);
    opacity: 0;
    transform: translateY(-6px);
    transition: opacity 0.2s ease, transform 0.2s ease;
    pointer-events: auto;
}

.shinoa-notify--shown {
    opacity: 1;
    transform: translateY(0);
}

.shinoa-notify--hide {
    opacity: 0;
    transform: translateY(-6px);
}

.shinoa-notify--warn {
    border-left-color: rgba(255, 204, 0, 0.95);
}

.shinoa-notify--error {
    border-left-color: rgba(255, 82, 82, 0.95);
}

.shinoa-notify-title {
    font-weight: 700;
    margin-bottom: 4px;
    font-size: 14px;
}

.shinoa-notify-close {
    position: absolute;
    top: 6px;
    right: 8px;
    background: none;
    border: none;
    color: #fff;
    font-size: 16px;
    cursor: pointer;
    line-height: 1;
    opacity: 0.7;
}

.shinoa-notify-close:hover {
    opacity: 1;
}
        `.trim();

        (document.head || document.documentElement).appendChild(style);
    }

    function ensureNotificationHost() {
        if (!document.body) {
            return null;
        }

        let host = document.getElementById(NOTIFICATION_CONTAINER_ID);
        if (!host) {
            host = document.createElement('div');
            host.id = NOTIFICATION_CONTAINER_ID;
            host.setAttribute('role', 'status');
            document.body.appendChild(host);
        }
        return host;
    }

    function showNotification({ key, title, message, tone = 'info', timeoutMs = 6500, onClose = null }) {
        ensureNotificationStyles();
        const host = ensureNotificationHost();
        if (!host) {
            return null;
        }

        if (key) {
            const existing = host.querySelector(`[data-key="${key}"]`);
            if (existing) {
                existing.remove();
            }
        }

        const notice = document.createElement('div');
        notice.className = `shinoa-notify shinoa-notify--${tone}`;
        if (key) {
            notice.dataset.key = key;
        }

        const titleEl = document.createElement('div');
        titleEl.className = 'shinoa-notify-title';
        titleEl.textContent = title || 'Уведомление';

        const textEl = document.createElement('div');
        textEl.textContent = message || '';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'shinoa-notify-close';
        closeBtn.textContent = 'x';

        const hide = () => {
            if (!notice.isConnected) {
                return;
            }
            notice.classList.add('shinoa-notify--hide');
            setTimeout(() => {
                notice.remove();
                if (typeof onClose === 'function') {
                    onClose();
                }
            }, 200);
        };

        closeBtn.addEventListener('click', hide);

        notice.appendChild(closeBtn);
        notice.appendChild(titleEl);
        notice.appendChild(textEl);
        host.appendChild(notice);

        requestAnimationFrame(() => {
            notice.classList.add('shinoa-notify--shown');
        });

        if (timeoutMs > 0) {
            setTimeout(hide, timeoutMs);
        }

        return notice;
    }

    function notifyOnce(key, options) {
        if (notificationSeen.has(key)) {
            return null;
        }
        notificationSeen.add(key);
        return showNotification({ key, ...options });
    }

    function notifyLogsAuthRequired() {
        if (logsAuthNoticeShown) {
            return;
        }

        logsAuthNoticeShown = true;

        const notice = showNotification({
            key: 'logs-auth-required',
            tone: 'warn',
            title: 'Требуется авторизация для логов',
            message: 'Откройте arizonarp.logsparser.info в той же вкладке, подтвердите доступ и попробуйте снова.',
            timeoutMs: 7000,
            onClose: () => {
                logsAuthNoticeShown = false;
            }
        });

        if (!notice) {
            logsAuthNoticeShown = false;
        }
    }

    function injectNetworkInterceptor() {
        if (document.getElementById('shinoa-player-helper-interceptor')) {
            debug('Network interceptor already present');
            return;
        }

        const script = document.createElement('script');
        script.id = 'shinoa-player-helper-interceptor';
        script.type = 'text/javascript';
        script.src = chrome.runtime.getURL('shinoa-page-interceptor.js');
        script.onload = () => script.remove();
        script.onerror = (error) => console.error(DEBUG_PREFIX, 'Failed to load interceptor script', error);
        (document.head || document.documentElement).appendChild(script);
        debug('Network interceptor injected');
    }

    function installBridgeListener() {
        window.addEventListener(INTERCEPT_EVENT, async (event) => {
            const payload = event.detail;
            if (!payload) {
                return;
            }

            try {
                await processPlayerPayload(payload);
            } catch (error) {
                console.error(DEBUG_PREFIX, 'Failed to process payload', error);
            }
        });

        debug('Bridge listener ready');
    }

    async function processPlayerPayload(payload) {
        if (!isPlayerPage()) {
            debug('Ignoring payload outside player page');
            return;
        }

        const data = extractData(payload);
        if (!data || !data.info) {
            debug('Unsupported payload shape', payload);
            return;
        }

        const { info } = data;

        debug('API payload info:', info);

        const ipCandidates = [
            {
                label: 'Рег IP',
                value: info.reg_ip,
                lookupKeys: ['Reg IP', 'Рег IP', 'R-IP', 'Registration IP']
            },
            {
                label: 'Last IP',
                value: info.last_ip,
                lookupKeys: ['Last IP', 'Последний IP', 'L-IP', 'Last-IP']
            },
            {
                label: 'Tradeaccept IP',
                value: info.accept_ip,
                lookupKeys: ['Tradeaccept IP', 'Accept IP', 'A-IP']
            },
            {
                label: 'Old IP',
                value: info.old_ip,
                lookupKeys: ['Old IP', 'Old-IP', 'Предыдущий IP']
            }
        ];

        const uniqueIPs = ipCandidates
            .map((entry) => (entry.value ?? '').trim())
            .filter((value, index, array) => value && value !== '0.0.0.0' && array.indexOf(value) === index);

        let geoMap = {};
        if (uniqueIPs.length) {
            geoMap = await fetchGeolocation(uniqueIPs);
        }

        const regGeo = geoMap[info.reg_ip?.trim()];
        const lastGeo = geoMap[info.last_ip?.trim()];
        const distanceKm = computeDistanceKm(regGeo, lastGeo);

        rememberIPAnnotation(ipCandidates, geoMap, distanceKm);
        annotateRows(ipCandidates, geoMap, distanceKm);
        insertIPLogRow(); // Добавляем строку IP LOG

        const accountId = info.id?.toString() ||
                         info.player_id?.toString() ||
                         info.account_id?.toString() ||
                         null;

        const regDate = info.reg_date || info.registration_date || null;

        // Получаем serverId из URL или из формы на странице
        const serverId = getServerIdFromPage();

        const playerData = {
            accountId,
            serverId,
            regDate
        };

        debug('Extracted player data:', playerData);

        if (playerData.accountId && playerData.serverId) {
            lastPlayerData = playerData; // Сохраняем для переинициализации
            setupAttachmentButtonsWithData(playerData);
            setupIPLogButton(playerData); // Настраиваем кнопку IP LOG
            setupTableObserver(); // Настраиваем наблюдатель за изменениями таблицы
        } else {
            debug('Missing required player data fields (accountId or serverId)');
        }
    }

    function extractData(payload) {
        if (!payload) {
            return null;
        }
        if (payload.info) {
            return payload;
        }
        if (payload.data && payload.data.info) {
            return payload.data;
        }
        return null;
    }

    async function fetchGeolocation(ipList) {
        const result = {};
        const pending = [];

        ipList.forEach((ip) => {
            if (geoCache.has(ip)) {
                const value = geoCache.get(ip);
                if (value) {
                    result[ip] = value;
                }
            } else {
                pending.push(ip);
            }
        });

        if (pending.length) {
            const response = await requestGeoBatch(pending);
            if (response?.ok && Array.isArray(response.data)) {
                pending.forEach((ip, index) => {
                    const info = normalizeGeoResponse(response.data[index]);
                    geoCache.set(ip, info);
                    if (info) {
                        result[ip] = info;
                    }
                });
            } else {
                pending.forEach((ip) => geoCache.set(ip, null));
                if (response && response.error) {
                    console.error(DEBUG_PREFIX, 'Geo lookup failed:', response.error);
                }
            }
        }

        return result;
    }

    function requestGeoBatch(ips) {
        return sendMessageSafe({ type: 'geo-lookup', ips })
            .catch((error) => ({
                ok: false,
                error: error?.message || 'geo-lookup failed'
            }));
    }

    function normalizeGeoResponse(entry) {
        if (!entry || entry.status === 'fail') {
            return null;
        }

        const parts = [];
        if (entry.country) {
            parts.push(entry.country);
        }

        if (entry.city) {
            parts.push(entry.city);
        }

        const network = entry.as || entry.isp || entry.org;
        if (network) {
            parts.push(network);
        }

        const description = parts.join(' - ');

        return {
            text: description || 'Нет данных',
            lat: typeof entry.lat === 'number' ? entry.lat : null,
            lon: typeof entry.lon === 'number' ? entry.lon : null
        };
    }

    // Получает подсеть /24 из IP адреса (первые 3 октета)
    function getSubnet24(ip) {
        if (!ip || typeof ip !== 'string') {
            return null;
        }
        const parts = ip.split('.');
        if (parts.length !== 4) {
            return null;
        }
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
    }

    // Группирует IP адреса по подсетям /24, возвращает представителей каждой подсети
    function groupIPsBySubnet(ipList) {
        const subnetMap = new Map(); // subnet -> { representative: ip, ips: [ip1, ip2, ...] }

        for (const ip of ipList) {
            const subnet = getSubnet24(ip);
            if (!subnet) {
                continue;
            }

            if (!subnetMap.has(subnet)) {
                subnetMap.set(subnet, {
                    representative: ip,
                    ips: [ip]
                });
            } else {
                subnetMap.get(subnet).ips.push(ip);
            }
        }

        return subnetMap;
    }

    // Асинхронная загрузка геолокации batch по GEO_BATCH_SIZE с учетом подсетей
    async function fetchGeolocationBatch(ipList, onProgress = null) {
        const result = {};
        const pending = [];

        // Сначала проверяем кэш
        for (const ip of ipList) {
            if (geoCache.has(ip)) {
                const value = geoCache.get(ip);
                if (value) {
                    result[ip] = value;
                }
            } else {
                pending.push(ip);
            }
        }

        if (pending.length === 0) {
            return result;
        }

        // Группируем по подсетям для оптимизации
        const subnetMap = groupIPsBySubnet(pending);
        const representatives = [];
        const subnetToIPs = new Map();

        for (const [subnet, data] of subnetMap.entries()) {
            representatives.push(data.representative);
            subnetToIPs.set(subnet, data.ips);
        }

        debug(`Geo lookup: ${pending.length} IPs grouped into ${representatives.length} subnets`);

        // Разбиваем представителей на batch по GEO_BATCH_SIZE
        const batches = [];
        for (let i = 0; i < representatives.length; i += GEO_BATCH_SIZE) {
            batches.push(representatives.slice(i, i + GEO_BATCH_SIZE));
        }

        let processedBatches = 0;
        const totalBatches = batches.length;

        // Обрабатываем batch последовательно чтобы не перегрузить API
        for (const batch of batches) {
            try {
                const response = await requestGeoBatch(batch);

                if (response?.ok && Array.isArray(response.data)) {
                    batch.forEach((ip, index) => {
                        const info = normalizeGeoResponse(response.data[index]);
                        const subnet = getSubnet24(ip);

                        // Кэшируем и применяем результат ко всем IP в этой подсети
                        if (subnet && subnetToIPs.has(subnet)) {
                            for (const relatedIP of subnetToIPs.get(subnet)) {
                                geoCache.set(relatedIP, info);
                                if (info) {
                                    result[relatedIP] = info;
                                }
                            }
                        } else {
                            geoCache.set(ip, info);
                            if (info) {
                                result[ip] = info;
                            }
                        }
                    });
                } else {
                    // При ошибке помечаем IP как null в кэше
                    batch.forEach((ip) => {
                        const subnet = getSubnet24(ip);
                        if (subnet && subnetToIPs.has(subnet)) {
                            for (const relatedIP of subnetToIPs.get(subnet)) {
                                geoCache.set(relatedIP, null);
                            }
                        } else {
                            geoCache.set(ip, null);
                        }
                    });

                    if (response?.error) {
                        debug('Geo batch lookup failed:', response.error);
                    }
                }
            } catch (error) {
                debug('Error in geo batch:', error);
                batch.forEach((ip) => geoCache.set(ip, null));
            }

            processedBatches++;

            if (onProgress) {
                onProgress({
                    type: 'geo-batch',
                    processed: processedBatches,
                    total: totalBatches,
                    loadedIPs: Object.keys(result).length,
                    totalIPs: pending.length
                });
            }

            // Небольшая задержка между batch для предотвращения rate limiting
            if (processedBatches < totalBatches) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        return result;
    }

    function rememberIPAnnotation(candidates, geoMap, distanceKm) {
        const preparedCandidates = (candidates || []).map((entry) => {
            const rawValue = entry?.value;
            const normalizedValue = rawValue === null || rawValue === undefined ? '' : String(rawValue);

            return {
                label: entry?.label || '',
                value: normalizedValue,
                lookupKeys: Array.isArray(entry?.lookupKeys) ? [...entry.lookupKeys] : [entry?.label || '']
            };
        });

        lastIPAnnotation = {
            candidates: preparedCandidates,
            geoMap: { ...(geoMap || {}) },
            distanceKm
        };
    }

    function reapplyIPAnnotations() {
        if (!lastIPAnnotation) {
            return;
        }

        annotateRows(lastIPAnnotation.candidates, lastIPAnnotation.geoMap, lastIPAnnotation.distanceKm);
    }

    function needsIPAnnotation() {
        if (!lastIPAnnotation || !lastIPAnnotation.candidates?.length) {
            return false;
        }

        return lastIPAnnotation.candidates.some((entry) => {
            const ip = (entry.value ?? '').trim();
            if (!ip || ip === '0.0.0.0') {
                return false;
            }

            const row = findRowByLabels(entry.lookupKeys || [entry.label]);
            if (!row || !row.cells || row.cells.length < 2) {
                return false;
            }

            const cell = row.cells[1];
            return !cell.querySelector('.shinoa-ip-container');
        });
    }

    function scheduleIPAnnotation() {
        if (ipAnnotationScheduled) {
            return;
        }

        ipAnnotationScheduled = true;
        const scheduler = window.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
        scheduler(() => {
            ipAnnotationScheduled = false;

            if (!lastIPAnnotation) {
                return;
            }

            if (needsIPAnnotation()) {
                reapplyIPAnnotations();
            }
        });
    }

    function annotateRows(candidates, geoMap, distanceKm) {
        ensureInlineStyle();

        candidates.forEach((entry) => {
            const ip = (entry.value ?? '').trim();
            if (!ip || ip === '0.0.0.0') {
                return;
            }

            const row = findRowByLabels(entry.lookupKeys || [entry.label]);
            if (!row || !row.cells || row.cells.length < 2) {
                return;
            }

            const cell = row.cells[1];
            const container = getOrCreateCellContainer(cell, entry.value ?? '');
            const geo = geoMap[ip];
            const geoText = geo?.text || 'Нет данных';

            let suffix = `- ${geoText}`;
            if (entry.label === 'Last IP' && Number.isFinite(distanceKm)) {
                suffix += ` (~${Math.round(distanceKm)} км)`;
            }

            const badge = getOrCreateBadge(container);
            badge.textContent = suffix;
        });
    }

    function insertIPLogRow() {
        ensureAttachmentStyles(); // Загружаем стили для кнопки

        // Проверяем, не добавлена ли уже строка IP LOG
        const existingIPLogRow = findRowByLabels(['IP LOG']);
        if (existingIPLogRow) {
            debug('IP LOG row already exists');
            return;
        }

        // Находим строку Last IP
        const lastIPRow = findRowByLabels(['Last IP']);
        if (!lastIPRow) {
            debug('Last IP row not found');
            return;
        }

        // Создаем новую строку
        const newRow = document.createElement('tr');
        newRow.setAttribute('data-v-342764a4', '');
        newRow.setAttribute('data-v-13d1495b', '');

        // Создаем первую ячейку с текстом "IP LOG"
        const labelCell = document.createElement('td');
        labelCell.setAttribute('data-v-342764a4', '');
        labelCell.setAttribute('data-v-13d1495b', '');
        labelCell.className = 'text-right';
        labelCell.textContent = 'IP LOG';

        // Создаем вторую ячейку с кнопкой
        const dataCell = document.createElement('td');
        dataCell.setAttribute('data-v-342764a4', '');
        dataCell.setAttribute('data-v-13d1495b', '');

        const button = document.createElement('button');
        button.className = 'shinoa-ip-log-btn';
        button.type = 'button';
        button.textContent = 'Получить данные';

        dataCell.appendChild(button);
        newRow.appendChild(labelCell);
        newRow.appendChild(dataCell);

        // Вставляем новую строку после Last IP
        lastIPRow.parentNode.insertBefore(newRow, lastIPRow.nextSibling);

        debug('IP LOG row inserted');
    }

    function setupIPLogButton(playerData) {
        const { accountId, serverId, regDate } = playerData;

        if (!accountId || !serverId) {
            debug('Invalid player data for IP LOG', playerData);
            return;
        }

        // Находим строку IP LOG
        const ipLogRow = findRowByLabels(['IP LOG']);
        if (!ipLogRow) {
            debug('IP LOG row not found');
            return;
        }

        const button = ipLogRow.querySelector('.shinoa-ip-log-btn');
        if (!button) {
            debug('IP LOG button not found');
            return;
        }

        // Проверяем, не настроена ли кнопка уже
        if (button.dataset.accountId === accountId) {
            debug('IP LOG button already configured for this account');
            return;
        }

        // Помечаем кнопку accountId
        button.dataset.accountId = accountId;

        // Удаляем старые обработчики
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        // Храним загруженные данные для повторного показа
        let cachedIPLogData = null;
        let isGeoLoadingInProgress = false;

        // Добавляем новый обработчик
        newButton.addEventListener('click', async () => {
            // Если данные уже загружены, просто показываем popup
            if (cachedIPLogData) {
                const isGeoLoading = !cachedIPLogData.loadStatus.geoLoaded && isGeoLoadingInProgress;
                showIPLogPopup(newButton, cachedIPLogData.ips, isGeoLoading, playerData, cachedIPLogData);
                return;
            }

            newButton.disabled = true;
            newButton.textContent = 'Загрузка...';

            try {
                // Загружаем IP логи (без геолокации)
                const ipLogData = await getIPLogData(accountId, serverId, regDate, (progress) => {
                    if (progress.type === 'period-start') {
                        newButton.textContent = `Период ${progress.period}/${progress.total}`;
                    } else if (progress.type === 'period-complete') {
                        newButton.textContent = `Загружено ${progress.period}/${progress.total}`;
                    }
                });

                cachedIPLogData = ipLogData;
                newButton.textContent = `Показать (${ipLogData.ips.length})`;
                newButton.disabled = false;

                // Показываем popup сразу (геолокация ещё не загружена)
                const hasIPs = ipLogData.ips.length > 0;
                showIPLogPopup(newButton, ipLogData.ips, hasIPs, playerData, ipLogData);

                // Запускаем асинхронную загрузку геолокации
                if (hasIPs) {
                    isGeoLoadingInProgress = true;

                    loadIPLogGeolocation(ipLogData, (progress) => {
                        // Обновляем popup по мере загрузки геолокации
                        updateIPLogPopupGeo(ipLogData, progress, playerData);

                        if (progress.type === 'geo-complete' || progress.type === 'geo-error') {
                            isGeoLoadingInProgress = false;

                            // Кешируем данные только после полной загрузки
                            if (progress.type === 'geo-complete' && !ipLogData.loadStatus.hasErrors) {
                                ipLogCache.set(accountId, ipLogData);
                            }
                        }
                    });
                }

            } catch (error) {
                const isAuthError = error?.code === 'LOGS_AUTH_REQUIRED' || isLogsAuthError(error);

                newButton.textContent = isAuthError ? 'Нужна авторизация' : 'Ошибка';
                newButton.disabled = false;
                debug('Error loading IP log data:', error);

                if (isAuthError) {
                    notifyLogsAuthRequired();
                } else {
                    // Добавляем возможность повторить
                    setTimeout(() => {
                        newButton.textContent = 'Повторить';
                        cachedIPLogData = null; // Сбрасываем кеш для повторной попытки
                    }, 2000);
                }
                cachedIPLogData = null;
            }
        });

        debug('IP LOG button configured for account', accountId);
    }

    function findRowByLabels(labels) {
        if (!labels || !labels.length) {
            return null;
        }

        const lowerLabels = labels
            .map((label) => label && label.toString().trim().toLowerCase())
            .filter(Boolean);

        if (!lowerLabels.length) {
            return null;
        }

        const rows = document.querySelectorAll('tr');
        for (const row of rows) {
            const firstCell = row.cells && row.cells[0];
            if (!firstCell) {
                continue;
            }

            const text = firstCell.textContent.trim().toLowerCase();
            if (lowerLabels.includes(text)) {
                return row;
            }
        }

        return null;
    }

    function computeDistanceKm(a, b) {
        if (!a || !b || a.lat === null || a.lon === null || b.lat === null || b.lon === null) {
            return null;
        }

        const toRadians = (value) => value * Math.PI / 180;
        const R = 6371; // Земля, км

        const lat1 = toRadians(a.lat);
        const lat2 = toRadians(b.lat);
        const deltaLat = toRadians(b.lat - a.lat);
        const deltaLon = toRadians(b.lon - a.lon);

        const sinLat = Math.sin(deltaLat / 2);
        const sinLon = Math.sin(deltaLon / 2);

        const haver = sinLat * sinLat +
            Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

        const c = 2 * Math.atan2(Math.sqrt(haver), Math.sqrt(1 - haver));
        return R * c;
    }

    function ensureInlineStyle() {
        if (document.getElementById(INLINE_STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = INLINE_STYLE_ID;
        style.textContent = `
.shinoa-ip-container {
    display: flex;
    flex-direction: column;
    gap: 0px;
}

.shinoa-ip-base {
    font-size: inherit;
}

.shinoa-ip-inline {
    font-size: 12px;
    color: rgba(236, 241, 249, 0.65);
    word-break: break-word;
}
        `.trim();

        (document.head || document.documentElement).appendChild(style);
    }
    function setupRouteWatcher() {
        let lastPath = location.pathname;
        function handleRouteChange() {
            const currentPath = location.pathname;
            if (currentPath === lastPath) {
                return;
            }
            lastPath = currentPath;
            updateRouteState();
        }

        const originalPushState = history.pushState;
        history.pushState = function(...args) {
            const result = originalPushState.apply(this, args);
            queueMicrotask(handleRouteChange);
            return result;
        };

        const originalReplaceState = history.replaceState;
        history.replaceState = function(...args) {
            const result = originalReplaceState.apply(this, args);
            queueMicrotask(handleRouteChange);
            return result;
        };

        window.addEventListener('popstate', () => queueMicrotask(handleRouteChange));

        updateRouteState();
    }

    function updateRouteState() {
        const active = isPlayerPage();
        if (active !== isPlayerRouteActive) {
            isPlayerRouteActive = active;
            debug('Player route state changed:', active);

            if (!active) {
                // Очищаем данные при уходе со страницы игрока
                lastPlayerData = null;
                lastIPAnnotation = null;
                ipAnnotationScheduled = false;
                if (tableObserver) {
                    tableObserver.disconnect();
                    tableObserver = null;
                }
            }

            if (active) {
                ensureInlineStyle();
                scheduleAutoHydrateFromUrl();
            }
        }
    }

    function scheduleAutoHydrateFromUrl() {
        // Если перехват сети не успел (страница открыта напрямую по URL),
        // пробуем сами дернуть /api/v1/player по параметрам name/server.
        try {
            const params = new URLSearchParams(window.location.search);
            const name = (params.get('name') || params.get('player') || '').toString().trim();
            const server = (params.get('server') || params.get('server_id') || params.get('serverId') || '').toString().trim();

            if (!name || !server) {
                return;
            }

            const key = `${name}|${server}`;
            if (lastAutoHydrateKey === key && lastPlayerData?.accountId) {
                return;
            }

            // Если уже обработали эти параметры — ничего не делаем
            if (lastPlayerData?.accountId && lastPlayerData?.serverId && String(lastPlayerData.serverId) === server) {
                // accountId может отличаться от name (ник), поэтому проверяем только сервер+наличие данных
                // и даём шанс на повтор при смене name через key.
                if (lastAutoHydrateKey === key) {
                    return;
                }
            }

            lastAutoHydrateKey = key;

            const tryHydrate = async (attempt = 0) => {
                if (!isPlayerPage()) {
                    return;
                }

                // Если уже пришёл payload через interceptor — выходим
                if (lastPlayerData?.accountId && lastPlayerData?.serverId) {
                    return;
                }

                // Дождёмся meta csrf-token (иногда появляется не сразу)
                if (!document.querySelector('meta[name="csrf-token"]') && attempt < 10) {
                    setTimeout(() => tryHydrate(attempt + 1), 100);
                    return;
                }

                try {
                    debug('Auto-hydrate player payload from URL', { name, server });
                    const payload = await fetchShinoaPlayerPayload(name, Number(server));
                    await processPlayerPayload(payload);
                } catch (error) {
                    debug('Auto-hydrate failed', error);
                }
            };

            setTimeout(() => tryHydrate(0), 0);
        } catch (error) {
            debug('scheduleAutoHydrateFromUrl error', error);
        }
    }

    function isPlayerPage() {
        return location.pathname.startsWith(ROUTE_PREFIX);
    }

    function getServerIdFromPage() {
        // 1. Пробуем получить из Vuetify select (v-select__selection)
        const vSelectElement = document.querySelector('.v-select__selection');
        if (vSelectElement) {
            const text = vSelectElement.textContent.trim();
            // Формат: "[103] Mobile 3"
            const match = text.match(/\[(\d+)\]/);
            if (match) {
                debug('Server ID from v-select:', match[1]);
                return match[1];
            }
        }

        // 2. Пробуем получить из обычного select элемента
        const selectElement = document.querySelector('select[name="server"], input[name="server"], #input-146');
        if (selectElement && selectElement.value) {
            debug('Server ID from select:', selectElement.value);
            return selectElement.value;
        }

        // 3. Пробуем найти в ссылках на странице
        const links = document.querySelectorAll('a[href*="server_number="]');
        if (links.length > 0) {
            const match = links[0].href.match(/server_number=(\d+)/);
            if (match) {
                debug('Server ID from link:', match[1]);
                return match[1];
            }
        }

        // 4. Пробуем получить из URL если есть параметр
        const urlParams = new URLSearchParams(window.location.search);
        const serverParam = urlParams.get('server') || urlParams.get('server_number') || urlParams.get('server_id');
        if (serverParam) {
            debug('Server ID from URL:', serverParam);
            return serverParam;
        }

        // 5. По умолчанию используем сервер из текста select элемента
        const selectText = selectElement?.selectedOptions?.[0]?.textContent;
        if (selectText) {
            const match = selectText.match(/\[(\d+)\]/);
            if (match) {
                debug('Server ID from select text:', match[1]);
                return match[1];
            }
        }

        debug('Server ID not found on page');
        return null;
    }

    // ==================== ATTACHMENT HELPER ====================

    function parseDate(dateStr) {
        if (!dateStr) return null;
        const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2})(?::(\d{2})(?::(\d{2}))?)?)?/);
        if (!match) return null;

        const year = Number(match[1]);
        const monthIdx = Number(match[2]) - 1;
        const day = Number(match[3]);
        const hours = Number(match[4] ?? '0');
        const minutes = Number(match[5] ?? '0');
        const seconds = Number(match[6] ?? '0');

        return new Date(year, monthIdx, day, hours, minutes, seconds);
    }

    function formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    function addMonths(date, months) {
        const newDate = new Date(date);
        newDate.setMonth(newDate.getMonth() + months);
        return newDate;
    }

    function splitPeriod(startDate, endDate) {
        const periods = [];
        let currentStart = new Date(startDate);

        while (currentStart < endDate) {
            const currentEnd = addMonths(currentStart, MAX_SAFE_MONTHS);
            const periodEnd = currentEnd > endDate ? endDate : currentEnd;

            periods.push({
                start: new Date(currentStart),
                end: new Date(periodEnd)
            });

            currentStart = new Date(periodEnd);
        }

        return periods;
    }

    async function fetchAttachmentLogs(accountId, serverId, startDate, endDate, playerName = null) {
        const url = new URL('https://arizonarp.logsparser.info/');
        url.searchParams.set('server_number', serverId);
        url.searchParams.set('type[]', 'security_attach_deattach');
        url.searchParams.set('sort', 'desc');
        url.searchParams.set('min_period', formatDate(startDate));
        url.searchParams.set('max_period', formatDate(endDate));
        url.searchParams.set('player', accountId);

        debug('Fetching attachment logs', url.toString());

        let response;
        try {
            response = await sendMessageSafe({
                type: 'fetch-logs',
                url: url.toString()
            }, 2);
        } catch (error) {
            throw wrapLogsFetchError(error, url.toString());
        }

        if (!response) {
            throw wrapLogsFetchError(new Error('No response from service worker'), url.toString());
        }

        if (!response.ok) {
            throw wrapLogsFetchError(new Error(response.error || 'Unknown error'), url.toString());
        }

        return response.html;
    }

    async function fetchEmailLogs(accountId, serverId, startDate, endDate) {
        const url = new URL('https://arizonarp.logsparser.info/');
        url.searchParams.set('server_number', serverId);
        url.searchParams.set('type[]', 'mail');
        url.searchParams.set('sort', 'desc');
        url.searchParams.set('min_period', formatDate(startDate));
        url.searchParams.set('max_period', formatDate(endDate));
        url.searchParams.set('player', accountId);

        debug('Fetching email logs', url.toString());

        let response;
        try {
            response = await sendMessageSafe({
                type: 'fetch-logs',
                url: url.toString()
            }, 2);
        } catch (error) {
            throw wrapLogsFetchError(error, url.toString());
        }

        if (!response) {
            throw wrapLogsFetchError(new Error('No response from service worker'), url.toString());
        }

        if (!response.ok) {
            throw wrapLogsFetchError(new Error(response.error || 'Unknown error'), url.toString());
        }

        return response.html;
    }

    function parseAttachmentLogs(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const rows = doc.querySelectorAll('tbody tr');

        const events = [];

        for (const row of rows) {
            const cells = row.cells;
            if (!cells || cells.length < 2) continue;

            const dateCell = cells[0];
            const actionCell = cells[1];

            const dateText = dateCell.textContent.trim();
            const actionText = actionCell.textContent.trim();

            // Парсим дату
            const dateMatch = dateText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
            if (!dateMatch) continue;

            const date = dateMatch[1];

            // Определяем тип: VK или Telegram, привязка или отвязка
            let type = null;
            let action = null;
            let value = null;
            let displayText = null;

            // Проверяем VK
            if (actionText.includes('ВКонтакте') || actionText.includes('VK ID') || actionText.match(/\(id:\s*\d+\)/i)) {
                type = 'vk';

                if (actionText.includes('привязывает') || actionText.includes('привязал') || actionText.includes('attach')) {
                    action = 'attach';
                    // Извлекаем полный текст: "Имя Фамилия (VK ID: 123456)" или "Имя Фамилия (id: 123456)"
                    const vkFullMatch = actionText.match(/(?:страницу ВКонтакте|аккаунт)\s+(.+?\s*\((?:VK\s+)?id[:\s]+\d+\))/i);
                    if (vkFullMatch) {
                        displayText = vkFullMatch[1].trim();
                    }
                    // Извлекаем ID VK: "VK ID: 123456" или "id: 123456"
                    const vkMatch = actionText.match(/(?:VK\s+)?id[:\s]+(\d+)/i);
                    if (vkMatch) {
                        value = vkMatch[1];
                    }
                } else if (actionText.includes('отвязывает') || actionText.includes('отвязал') || actionText.includes('deattach')) {
                    action = 'deattach';
                }
            }
            // Проверяем Telegram
            else if (actionText.includes('Telegram') || actionText.includes('TG ID')) {
                type = 'telegram';

                if (actionText.includes('привязывает') || actionText.includes('привязал') || actionText.includes('attach')) {
                    action = 'attach';
                    // Извлекаем полный текст: "@username (TG ID: 357144599)"
                    const tgFullMatch = actionText.match(/аккаунт\s+(.+?\s*\(TG\s+ID[:\s]+\d+\))/i);
                    if (tgFullMatch) {
                        displayText = tgFullMatch[1].trim();
                    }
                    // Извлекаем ID Telegram: "TG ID: 357144599"
                    const tgMatch = actionText.match(/TG\s+ID[:\s]+(\d+)/i);
                    if (tgMatch) {
                        value = tgMatch[1];
                    }
                } else if (actionText.includes('отвязывает') || actionText.includes('отвязал') || actionText.includes('deattach')) {
                    action = 'deattach';
                }
            }

            if (type && action) {
                events.push({
                    date,
                    type,
                    action,
                    value,
                    displayText,
                    text: actionText
                });
                debug(`Found ${type} ${action}:`, { date, value, displayText, text: actionText });
            }
        }

        debug(`Total events parsed: ${events.length}`);
        return events;
    }

    function parseEmailLogs(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const rows = doc.querySelectorAll('tbody tr');

        const events = [];

        for (const row of rows) {
            const cells = row.cells;
            if (!cells || cells.length < 2) continue;

            const dateCell = cells[0];
            const actionCell = cells[1];

            const dateText = dateCell.textContent.trim();
            const actionText = actionCell.textContent.trim();

            // Парсим дату
            const dateMatch = dateText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
            if (!dateMatch) continue;

            const date = dateMatch[1];

            // Проверяем изменение почты: "Игрок XXX изменил почту YYY на ZZZ"
            if (actionText.includes('изменил почту') || actionText.includes('changed email')) {
                // Извлекаем старый и новый email
                // Паттерн: "изменил почту СТАРЫЙ на НОВЫЙ"
                const emailMatch = actionText.match(/изменил почту\s+(.+?)\s+на\s+(.+?)(?:\s|$)/i);
                if (emailMatch) {
                    const oldEmail = emailMatch[1].trim();
                    const newEmail = emailMatch[2].trim();

                    events.push({
                        date,
                        oldEmail,
                        newEmail,
                        text: actionText
                    });
                    debug(`Found email change:`, { date, oldEmail, newEmail });
                } else {
                    // Попытка альтернативного парсинга если первый не сработал
                    events.push({
                        date,
                        oldEmail: null,
                        newEmail: null,
                        text: actionText
                    });
                    debug(`Found email event (unparsed):`, { date, text: actionText });
                }
            }
        }

        debug(`Total email events parsed: ${events.length}`);
        return events;
    }

    function analyzeAttachments(events) {
        const vkHistory = [];
        const telegramHistory = [];

        events.forEach(event => {
            if (event.type === 'vk') {
                vkHistory.push(event);
            } else if (event.type === 'telegram') {
                telegramHistory.push(event);
            }
        });

        // Сортируем по дате (от новых к старым)
        vkHistory.sort((a, b) => new Date(b.date) - new Date(a.date));
        telegramHistory.sort((a, b) => new Date(b.date) - new Date(a.date));

        // Определяем текущее состояние (последнее по времени событие)
        const currentVK = vkHistory.length > 0 ? vkHistory[0] : null;
        const currentTelegram = telegramHistory.length > 0 ? telegramHistory[0] : null;

        return {
            vk: {
                current: currentVK && currentVK.action === 'attach' ? {
                    id: currentVK.value,
                    displayText: currentVK.displayText || currentVK.value
                } : null,
                history: vkHistory
            },
            telegram: {
                current: currentTelegram && currentTelegram.action === 'attach' ? {
                    id: currentTelegram.value,
                    displayText: currentTelegram.displayText || currentTelegram.value
                } : null,
                history: telegramHistory
            }
        };
    }

    function analyzeEmailHistory(events) {
        // Сортируем по дате (от новых к старым)
        const sortedEvents = [...events].sort((a, b) => new Date(b.date) - new Date(a.date));

        // Текущий email - это newEmail из последнего события
        const currentEmail = sortedEvents.length > 0 ? sortedEvents[0].newEmail : null;

        return {
            current: currentEmail,
            history: sortedEvents
        };
    }

    function parsePaginationInfo(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Ищем pagination контейнер
        const pagination = doc.querySelector('.pagination');
        if (!pagination) {
            debug('No pagination found, assuming single page');
            return { totalPages: 1, currentPage: 1 };
        }

        // Находим все элементы со страницами
        const pageItems = pagination.querySelectorAll('.page-item');
        let totalPages = 1;
        let currentPage = 1;

        for (const item of pageItems) {
            // Пропускаем кнопки "Назад" и "Вперед"
            if (item.getAttribute('aria-label')) {
                continue;
            }

            const link = item.querySelector('.page-link');
            if (!link) continue;

            const pageText = link.textContent.trim();
            const pageNum = parseInt(pageText, 10);

            if (!isNaN(pageNum)) {
                totalPages = Math.max(totalPages, pageNum);

                // Текущая страница имеет класс active
                if (item.classList.contains('active')) {
                    currentPage = pageNum;
                }
            }
        }

        debug('Pagination info:', { totalPages, currentPage });
        return { totalPages, currentPage };
    }

    function isIgnoredIP(ip) {
        return ip === '0.0.0.0' || ip === '255.255.255.255';
    }

    function parseIPLoginLogs(html) {
        const ipEntries = [];

        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            const rows = doc.querySelectorAll('table.table tbody tr');
            debug(`parseIPLoginLogs: Found ${rows.length} table rows in DOM`);

            rows.forEach((row, index) => {
                const cells = row.querySelectorAll('td');
                if (cells.length === 0) {
                    return;
                }

                const dateText = cells[0].textContent
                    .replace(/\s+/g, ' ')
                    .trim();

                const ipContainer = row.querySelector('.table-ip') || cells[cells.length - 1];

                let lastIp = null;

                if (ipContainer) {
                    const ipLinks = ipContainer.querySelectorAll('a');
                    if (ipLinks.length > 0) {
                        lastIp = ipLinks[0].textContent.trim();
                    }

                    if (!lastIp) {
                        const badge = ipContainer.querySelector('.badge, span');
                        if (badge) {
                            lastIp = badge.textContent.trim();
                        }
                    }

                    if (!lastIp) {
                        const ipMatch = ipContainer.textContent.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
                        if (ipMatch) {
                            lastIp = ipMatch[0];
                        }
                    }
                }

                if (!lastIp) {
                    const fallbackMatch = row.textContent.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
                    if (fallbackMatch) {
                        lastIp = fallbackMatch[0];
                    }
                }

                if (!lastIp || isIgnoredIP(lastIp) || !dateText) {
                    return;
                }

                ipEntries.push({
                    ip: lastIp,
                    date: dateText
                });
            });
        } catch (error) {
            console.error(DEBUG_PREFIX, 'parseIPLoginLogs DOM parse failed', error);
        }

        if (ipEntries.length === 0) {
            // Фолбэк на старый парсер, ориентированный на data-ip
            const dataIpMatches = html.match(/data-ip="([^"]+)"/g);
            debug(`parseIPLoginLogs fallback: Found ${dataIpMatches ? dataIpMatches.length : 0} data-ip attributes`);

            if (dataIpMatches && dataIpMatches.length > 0) {
                const trPattern = /<tr[^>]*data-ip="([^"]+)"[^>]*>(.*?)<\/tr>/gs;

                let match;
                while ((match = trPattern.exec(html)) !== null) {
                    const ip = match[1];
                    const trContent = match[2];

                    if (isIgnoredIP(ip)) {
                        continue;
                    }

                    const datePattern = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/;
                    const dateMatch = trContent.match(datePattern);

                    if (dateMatch) {
                        const date = dateMatch[1];
                        ipEntries.push({
                            ip: ip.trim(),
                            date
                        });
                    }
                }
            }
        }

        debug(`Parsed ${ipEntries.length} IP entries from HTML`);

        if (ipEntries.length > 0) {
            debug(`First IP entry: ${ipEntries[0].ip} at ${ipEntries[0].date}`);
            debug(`Last IP entry: ${ipEntries[ipEntries.length - 1].ip} at ${ipEntries[ipEntries.length - 1].date}`);
        }

        return ipEntries;
    }

    async function fetchIPLoginLogs(accountId, serverId, startDate, endDate, page = 1) {
        const url = new URL('https://arizonarp.logsparser.info/');
        url.searchParams.set('server_number', serverId);
        url.searchParams.set('type[]', 'login');
        url.searchParams.set('sort', 'desc');
        url.searchParams.set('min_period', formatDate(startDate));
        url.searchParams.set('max_period', formatDate(endDate));
        url.searchParams.set('player', accountId);
        url.searchParams.set('limit', '1000');

        if (page > 1) {
            url.searchParams.set('page', page.toString());
        }

        debug('Fetching IP login logs', { page, url: url.toString() });

        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                {
                    type: 'fetch-logs',
                    url: url.toString()
                },
                (response) => {
                    if (chrome.runtime.lastError) {
                        reject(wrapLogsFetchError(new Error(chrome.runtime.lastError.message), url.toString()));
                        return;
                    }

                    if (!response) {
                        reject(wrapLogsFetchError(new Error('No response from service worker'), url.toString()));
                        return;
                    }

                    if (!response.ok) {
                        reject(wrapLogsFetchError(new Error(response.error || 'Unknown error'), url.toString()));
                        return;
                    }

                    resolve(response.html);
                }
            );
        });
    }

    async function fetchPeriodWithPagination(accountId, serverId, period, onProgress = null) {
        debug('Fetching period with pagination:', period);

        // Шаг 1: Загружаем первую страницу
        const firstPageHTML = await fetchIPLoginLogs(accountId, serverId, period.start, period.end, 1);

        // Парсим pagination
        const { totalPages } = parsePaginationInfo(firstPageHTML);

        // Парсим IP из первой страницы
        const firstPageIPs = parseIPLoginLogs(firstPageHTML);

        debug(`Period has ${totalPages} pages, first page has ${firstPageIPs.length} IPs`);

        // Если только одна страница, возвращаем результат
        if (totalPages === 1) {
            return firstPageIPs;
        }

        // Шаг 2: Загружаем остальные страницы параллельно
        const pagePromises = [];
        for (let page = 2; page <= totalPages; page++) {
            pagePromises.push(
                fetchIPLoginLogs(accountId, serverId, period.start, period.end, page)
                    .then(html => parseIPLoginLogs(html))
                    .catch(error => {
                        const wrappedError = wrapLogsFetchError(error);
                        if (wrappedError?.code === 'LOGS_AUTH_REQUIRED') {
                            throw wrappedError;
                        }
                        debug('Error fetching page', page, wrappedError);
                        return []; // Возвращаем пустой массив при ошибке
                    })
            );
        }

        const otherPagesResults = await Promise.all(pagePromises);

        // Собираем все IP адреса
        const allIPs = [...firstPageIPs];
        otherPagesResults.forEach(pageIPs => {
            allIPs.push(...pageIPs);
        });

        debug(`Period total: ${allIPs.length} IP entries across ${totalPages} pages`);
        return allIPs;
    }

    async function getIPLogData(accountId, serverId, regDate, onProgress = null) {
        if (ipLogCache.has(accountId)) {
            debug('Using cached IP log data');
            return ipLogCache.get(accountId);
        }

        const startDate = parseDate(regDate) || new Date('2020-01-01');
        const endDate = new Date();

        const periods = splitPeriod(startDate, endDate);
        debug('Split IP log periods:', periods.length);

        const allIPEntries = [];
        let completedPeriods = 0;
        let successCount = 0;
        let failedCount = 0;
        let authError = null;

        // ВАЖНО: Загружаем периоды ПОСЛЕДОВАТЕЛЬНО
        for (const period of periods) {
            try {
                if (onProgress) {
                    onProgress({
                        type: 'period-start',
                        period: completedPeriods + 1,
                        total: periods.length
                    });
                }

                const periodIPs = await fetchPeriodWithPagination(
                    accountId,
                    serverId,
                    period,
                    onProgress
                );

                allIPEntries.push(...periodIPs);
                successCount++;

                debug(`Period ${completedPeriods + 1}/${periods.length}: ${periodIPs.length} IPs`);
            } catch (error) {
                const wrappedError = wrapLogsFetchError(error);
                if (wrappedError?.code === 'LOGS_AUTH_REQUIRED') {
                    authError = wrappedError;
                    break;
                }
                failedCount++;
                debug('Error fetching period', period, wrappedError);
            }

            completedPeriods++;

            if (onProgress) {
                onProgress({
                    type: 'period-complete',
                    period: completedPeriods,
                    total: periods.length
                });
            }
        }

        if (authError) {
            throw authError;
        }

        // Создаем карту уникальных IP с метаданными
        const ipMap = new Map();

        for (const entry of allIPEntries) {
            const ip = entry.ip;
            const entryDate = new Date(entry.date);

            if (!ipMap.has(ip)) {
                ipMap.set(ip, {
                    ip,
                    firstSeen: entry.date,
                    lastSeen: entry.date,
                    count: 1
                });
            } else {
                const existing = ipMap.get(ip);
                existing.count++;

                // Обновляем firstSeen и lastSeen
                const existingFirst = new Date(existing.firstSeen);
                const existingLast = new Date(existing.lastSeen);

                if (entryDate < existingFirst) {
                    existing.firstSeen = entry.date;
                }
                if (entryDate > existingLast) {
                    existing.lastSeen = entry.date;
                }
            }
        }

        // Преобразуем Map в массив и сортируем по lastSeen (новые сверху) БЕЗ геолокации
        const uniqueIPs = Array.from(ipMap.values()).map((entry) => ({
            ...entry,
            geo: null // Геолокация будет загружена асинхронно
        })).sort((a, b) => {
            return new Date(b.lastSeen) - new Date(a.lastSeen);
        });

        const resultWithStatus = {
            ips: uniqueIPs,
            ipMap: ipMap, // Сохраняем для обновления геолокации
            loadStatus: {
                total: periods.length,
                success: successCount,
                failed: failedCount,
                hasErrors: failedCount > 0,
                geoLoaded: false,
                geoErrorMessage: null
            }
        };

        debug(`IP Log complete: ${uniqueIPs.length} unique IPs from ${allIPEntries.length} total entries (geo pending)`);
        return resultWithStatus;
    }

    // Асинхронная загрузка геолокации для IP лога с callback для обновления UI
    async function loadIPLogGeolocation(ipLogData, onGeoUpdate = null) {
        const ipList = ipLogData.ips.map(entry => entry.ip);

        if (ipList.length === 0) {
            return;
        }

        if (ipLogData.loadStatus) {
            ipLogData.loadStatus.geoErrorMessage = null;
        }

        try {
            const ipGeoMap = await fetchGeolocationBatch(ipList, (progress) => {
                if (onGeoUpdate && progress.type === 'geo-batch') {
                    // Обновляем UI после каждого batch
                    for (const entry of ipLogData.ips) {
                        if (geoCache.has(entry.ip)) {
                            entry.geo = geoCache.get(entry.ip);
                        }
                    }
                    onGeoUpdate({
                        type: 'geo-progress',
                        ...progress
                    });
                }
            });

            // Финальное обновление всех IP
            for (const entry of ipLogData.ips) {
                entry.geo = ipGeoMap[entry.ip] || null;
            }

            ipLogData.loadStatus.geoLoaded = true;

            if (onGeoUpdate) {
                onGeoUpdate({
                    type: 'geo-complete',
                    geoMap: ipGeoMap
                });
            }

            debug('IP Log geo loading complete');
        } catch (error) {
            if (ipLogData.loadStatus) {
                ipLogData.loadStatus.geoErrorMessage = error?.message || 'Неизвестная ошибка';
            }
            debug('IP log geo loading failed:', error);
            if (onGeoUpdate) {
                onGeoUpdate({
                    type: 'geo-error',
                    error: error.message
                });
            }
        }
    }

    async function getAttachmentData(accountId, serverId, regDate, onProgress = null) {
        if (attachmentCache.has(accountId)) {
            debug('Using cached attachment data');
            return attachmentCache.get(accountId);
        }

        const startDate = parseDate(regDate) || new Date('2020-01-01');
        const endDate = new Date();

        const periods = splitPeriod(startDate, endDate);
        debug('Split into periods:', periods.length);

        // Инициализируем прогресс
        if (onProgress) {
            onProgress(0, periods.length);
        }

        const allEvents = [];
        let completed = 0;
        let successCount = 0;
        let failedCount = 0;

        // Загружаем все периоды параллельно
        const promises = periods.map((period, index) =>
            fetchAttachmentLogs(accountId, serverId, period.start, period.end)
                .then(html => {
                    const events = parseAttachmentLogs(html);
                    completed++;
                    successCount++;
                    if (onProgress) {
                        onProgress(completed, periods.length);
                    }
                    debug(`Period ${formatDate(period.start)} - ${formatDate(period.end)}: ${events.length} events (${completed}/${periods.length})`);
                    return { success: true, events };
                })
                .catch(error => {
                    const wrappedError = wrapLogsFetchError(error);
                    if (wrappedError?.code === 'LOGS_AUTH_REQUIRED') {
                        throw wrappedError;
                    }
                    completed++;
                    failedCount++;
                    if (onProgress) {
                        onProgress(completed, periods.length);
                    }
                    debug('Error fetching period', period, wrappedError);
                    return { success: false, events: [], error: wrappedError };
                })
        );

        const results = await Promise.all(promises);
        results.forEach(result => {
            if (result.success) {
                allEvents.push(...result.events);
            }
        });

        const analysisResult = analyzeAttachments(allEvents);

        // Добавляем информацию о статусе загрузки
        const resultWithStatus = {
            ...analysisResult,
            loadStatus: {
                total: periods.length,
                success: successCount,
                failed: failedCount,
                hasErrors: failedCount > 0
            }
        };

        // Кешируем только если все загрузилось успешно
        if (failedCount === 0) {
            attachmentCache.set(accountId, resultWithStatus);
        }

        return resultWithStatus;
    }

    async function getEmailData(accountId, serverId, regDate, onProgress = null) {
        if (emailCache.has(accountId)) {
            debug('Using cached email data');
            return emailCache.get(accountId);
        }

        const startDate = parseDate(regDate) || new Date('2020-01-01');
        const endDate = new Date();

        const periods = splitPeriod(startDate, endDate);
        debug('Split email periods:', periods.length);

        // Инициализируем прогресс
        if (onProgress) {
            onProgress(0, periods.length);
        }

        const allEvents = [];
        let completed = 0;
        let successCount = 0;
        let failedCount = 0;

        // Загружаем все периоды параллельно
        const promises = periods.map((period, index) =>
            fetchEmailLogs(accountId, serverId, period.start, period.end)
                .then(html => {
                    const events = parseEmailLogs(html);
                    completed++;
                    successCount++;
                    if (onProgress) {
                        onProgress(completed, periods.length);
                    }
                    debug(`Email period ${formatDate(period.start)} - ${formatDate(period.end)}: ${events.length} events (${completed}/${periods.length})`);
                    return { success: true, events };
                })
                .catch(error => {
                    const wrappedError = wrapLogsFetchError(error);
                    if (wrappedError?.code === 'LOGS_AUTH_REQUIRED') {
                        throw wrappedError;
                    }
                    completed++;
                    failedCount++;
                    if (onProgress) {
                        onProgress(completed, periods.length);
                    }
                    debug('Error fetching email period', period, wrappedError);
                    return { success: false, events: [], error: wrappedError };
                })
        );

        const results = await Promise.all(promises);
        results.forEach(result => {
            if (result.success) {
                allEvents.push(...result.events);
            }
        });

        const analysisResult = analyzeEmailHistory(allEvents);

        // Добавляем информацию о статусе загрузки
        const resultWithStatus = {
            ...analysisResult,
            loadStatus: {
                total: periods.length,
                success: successCount,
                failed: failedCount,
                hasErrors: failedCount > 0
            }
        };

        // Кешируем только если все загрузилось успешно
        if (failedCount === 0) {
            emailCache.set(accountId, resultWithStatus);
        }

        return resultWithStatus;
    }

    function createAttachmentButton(type) {
        const button = document.createElement('button');
        button.className = 'shinoa-attachment-btn';
        button.textContent = 'Получить данные из логов';
        button.type = 'button';
        return button;
    }

    function showHistoryPopup(anchorElement, history) {
        // Удаляем существующий popup если есть
        const existingPopup = document.querySelector('.shinoa-history-popup');
        if (existingPopup) {
            existingPopup.remove();
            return; // Toggle behavior
        }

        const popup = document.createElement('div');
        popup.className = 'shinoa-history-popup';

        const header = document.createElement('div');
        header.className = 'shinoa-history-popup-header';
        header.textContent = 'История привязок';
        popup.appendChild(header);

        const list = document.createElement('div');
        list.className = 'shinoa-history-popup-list';

        history.forEach((event, index) => {
            const item = document.createElement('div');
            item.className = 'shinoa-history-popup-item';

            // Создаем контейнер для основного контента (дата + текст)
            const contentWrapper = document.createElement('div');
            contentWrapper.className = 'shinoa-history-popup-content';

            // Добавляем дату
            const dateDiv = document.createElement('div');
            dateDiv.className = 'shinoa-history-popup-date';
            dateDiv.textContent = event.date;
            contentWrapper.appendChild(dateDiv);

            const text = document.createElement('div');
            text.className = 'shinoa-history-popup-text';

            // Если это VK и есть ID, делаем его кликабельным
            if (event.type === 'vk' && event.value) {
                const vkId = event.value;
                // Поддерживаем оба формата: "VK ID: 123" и "id: 123"
                const vkIdPattern = new RegExp(`((?:VK\\s+)?id[:\\s]+)(${vkId})`, 'i');
                const match = event.text.match(vkIdPattern);

                if (match) {
                    const beforeId = event.text.substring(0, match.index + match[1].length);
                    const afterId = event.text.substring(match.index + match[0].length);

                    text.innerHTML = '';
                    text.appendChild(document.createTextNode(beforeId));

                    const link = document.createElement('a');
                    link.href = `https://vk.com/id${vkId}`;
                    link.target = '_blank';
                    link.className = 'shinoa-history-popup-link';
                    link.textContent = vkId;
                    link.addEventListener('click', (e) => {
                        e.stopPropagation();
                    });

                    text.appendChild(link);
                    text.appendChild(document.createTextNode(afterId));
                } else {
                    text.textContent = event.text;
                }
            } else {
                text.textContent = event.text;
            }

            contentWrapper.appendChild(text);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'shinoa-history-popup-copy';
            copyBtn.textContent = 'Скопировать';
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(event.text).then(() => {
                    copyBtn.textContent = 'Скопировано!';
                    setTimeout(() => {
                        copyBtn.textContent = 'Скопировать';
                    }, 2000);
                }).catch(err => {
                    debug('Failed to copy:', err);
                });
            });

            item.appendChild(contentWrapper);
            item.appendChild(copyBtn);
            list.appendChild(item);
        });

        popup.appendChild(list);

        // Функция для обновления позиции popup
        function updatePosition() {
            const rect = anchorElement.getBoundingClientRect();
            popup.style.top = `${rect.bottom + 5}px`;
            popup.style.left = `${rect.left}px`;
        }

        // Обработчик скролла для перемещения popup
        function handleScroll() {
            updatePosition();
        }

        // Закрытие при клике вне popup
        function closePopup(e) {
            if (!popup.contains(e.target)) {
                popup.remove();
                document.removeEventListener('click', closePopup);
                window.removeEventListener('scroll', handleScroll, true);
            }
        }

        setTimeout(() => {
            document.addEventListener('click', closePopup);
        }, 0);

        // Добавляем обработчик скролла
        window.addEventListener('scroll', handleScroll, true);

        // Позиционирование popup
        document.body.appendChild(popup);

        popup.style.position = 'fixed';
        updatePosition();
    }

    function getIPLogGeoMissingReason(ipLogMeta) {
        const geoError = ipLogMeta?.loadStatus?.geoErrorMessage;
        if (geoError) {
            return `Не удалось загрузить геолокацию: ${geoError}`;
        }
        if (ipLogMeta?.loadStatus?.geoLoaded) {
            return 'Сервис геолокации не вернул данные для части IP.';
        }
        return 'Геолокация пока недоступна.';
    }

    function applyIPLogGeoMissingInfo(popup, ipLogMeta, playerContext) {
        if (!popup || !ipLogMeta || !Array.isArray(ipLogMeta.ips)) {
            return;
        }

        const missingCount = ipLogMeta.ips.filter((entry) => !entry.geo?.text).length;
        if (!missingCount) {
            return;
        }

        const reason = getIPLogGeoMissingReason(ipLogMeta);
        const cells = popup.querySelectorAll('.shinoa-iplog-geo');
        cells.forEach((cell) => {
            if ((cell.textContent || '').trim() === 'Нет данных') {
                cell.title = reason;
                cell.classList.add('shinoa-iplog-geo--missing');
            }
        });

        const accountKey = playerContext?.accountId || 'unknown';
        notifyOnce(`iplog-geo-missing-${accountKey}`, {
            tone: 'warn',
            title: 'Геолокация недоступна',
            message: reason,
            timeoutMs: 7000
        });
    }

    function showIPLogPopup(anchorElement, ipData, isGeoLoading = false, playerContext = null, ipLogMeta = null) {
        // Удаляем существующий popup если есть
        const existingPopup = document.querySelector('.shinoa-iplog-popup');
        if (existingPopup) {
            existingPopup.remove();
            return null; // Toggle behavior
        }

        const popup = document.createElement('div');
        popup.className = 'shinoa-iplog-popup';

        const mainPanel = document.createElement('div');
        mainPanel.className = 'shinoa-iplog-main';

        const compareContainer = document.createElement('div');
        compareContainer.className = 'shinoa-iplog-compare-container';
        compareContainer.style.display = 'none';

        popup.appendChild(mainPanel);
        popup.appendChild(compareContainer);

        const header = document.createElement('div');
        header.className = 'shinoa-iplog-popup-header';

        const headerText = document.createElement('span');
        headerText.textContent = `История IP адресов (${ipData.length})`;
        header.appendChild(headerText);
        headerText.style.flex = '1 1 auto';

        // Индикатор загрузки геолокации
        const geoStatus = document.createElement('span');
        geoStatus.className = 'shinoa-iplog-geo-status';
        if (isGeoLoading) {
            geoStatus.textContent = ' - Загрузка геолокации...';
            geoStatus.style.color = '#ffcc00';
        }
        header.appendChild(geoStatus);

        const compareBtn = document.createElement('button');
        compareBtn.type = 'button';
        compareBtn.className = 'shinoa-iplog-compare-btn shinoa-iplog-compare-btn--attention';
        compareBtn.textContent = '+';
        compareBtn.title = 'Сопоставить IP LOG с другим игроком';


        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'shinoa-iplog-export-btn';
        exportBtn.textContent = 'Экспорт TSV';
        exportBtn.title = 'Скопировать IP\tМестоположение\tКол-во входов';
        exportBtn.addEventListener('click', async (e) => {
            e.stopPropagation();

            const sanitizeTSVCell = (value) => {
                if (value === null || value === undefined) return '';
                return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
            };

            const lines = [];
            for (const entry of ipData) {
                const ip = sanitizeTSVCell(entry.ip);
                const location = sanitizeTSVCell(entry.geo?.text ?? '');
                const count = sanitizeTSVCell(entry.count ?? '');
                lines.push([ip, location, count].join('\t'));
            }
            const tsv = lines.length ? (lines.join('\r\n') + '\r\n') : '';

            const copyToClipboard = async (text) => {
                try {
                    if (navigator.clipboard?.writeText) {
                        await navigator.clipboard.writeText(text);
                        return true;
                    }
                } catch {}

                try {
                    const textarea = document.createElement('textarea');
                    textarea.value = text;
                    textarea.style.position = 'fixed';
                    textarea.style.left = '-9999px';
                    textarea.style.top = '0';
                    document.body.appendChild(textarea);
                    textarea.focus();
                    textarea.select();
                    const ok = document.execCommand && document.execCommand('copy');
                    textarea.remove();
                    return !!ok;
                } catch {
                    return false;
                }
            };

            const originalText = exportBtn.textContent;
            exportBtn.disabled = true;
            exportBtn.textContent = 'Копирую...';

            const copied = await copyToClipboard(tsv);
            if (copied) {
                exportBtn.textContent = 'Скопировано';
            } else {
                exportBtn.textContent = 'Не удалось';
                try {
                    window.prompt('Не удалось скопировать автоматически. Скопируйте TSV вручную:', tsv);
                } catch {}
            }

            setTimeout(() => {
                exportBtn.disabled = false;
                exportBtn.textContent = originalText;
            }, 2000);
        });
        header.appendChild(exportBtn);

        mainPanel.appendChild(header);
        mainPanel.appendChild(compareBtn);

        const comparePanel = document.createElement('div');
        comparePanel.className = 'shinoa-iplog-compare-panel';
        comparePanel.style.display = 'none';

        const compareRow = document.createElement('div');
        compareRow.className = 'shinoa-iplog-compare-row';

        const modeLabel = document.createElement('label');
        modeLabel.className = 'shinoa-iplog-compare-label';
        modeLabel.textContent = 'Режим:';

        const modeSelect = document.createElement('select');
        modeSelect.className = 'shinoa-iplog-compare-select';

        const modeOptions = [
            { value: 'exact', label: '1:1' },
            { value: '24', label: '81.56.209.X' },
            { value: '16', label: '81.56.X.X' }
        ];

        modeOptions.forEach((opt) => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            modeSelect.appendChild(option);
        });

        const defaultServerId =
            (playerContext && playerContext.serverId) ||
            getServerIdFromPage() ||
            '';

        const compareWindowStates = [];

        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'shinoa-iplog-compare-run-btn';
        runBtn.textContent = 'Сопоставить';

        const status = document.createElement('div');
        status.className = 'shinoa-iplog-compare-status';

        compareRow.appendChild(modeLabel);
        compareRow.appendChild(modeSelect);
        compareRow.appendChild(runBtn);
        comparePanel.appendChild(compareRow);
        comparePanel.appendChild(status);

        const compareResult = document.createElement('div');
        compareResult.className = 'shinoa-iplog-compare-result';
        comparePanel.appendChild(compareResult);

        const compareWindows = document.createElement('div');
        compareWindows.className = 'shinoa-iplog-compare-windows';

        compareContainer.appendChild(comparePanel);
        compareContainer.appendChild(compareWindows);

        const createCompareWindow = () => {
            if (compareWindowStates.length >= 4) {
                status.textContent = 'Ограничение: максимум 4 окна.';
                status.dataset.type = 'error';
                return null;
            }

            const win = document.createElement('div');
            win.className = 'shinoa-iplog-compare-window';
            win.dataset.hasMatches = '0';

            const winHeader = document.createElement('div');
            winHeader.className = 'shinoa-iplog-compare-window-header';

            const title = document.createElement('span');
            title.className = 'shinoa-iplog-compare-window-title';
            title.textContent = 'Сравнение';
            title.style.flex = '1 1 auto';
            winHeader.appendChild(title);

            const geoStatusEl = document.createElement('span');
            geoStatusEl.className = 'shinoa-iplog-compare-geo-status';
            winHeader.appendChild(geoStatusEl);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'shinoa-iplog-compare-remove-btn';
            removeBtn.textContent = '×';
            removeBtn.title = 'Удалить окно';
            winHeader.appendChild(removeBtn);

            const controls = document.createElement('div');
            controls.className = 'shinoa-iplog-compare-window-controls';

            const nameInput = document.createElement('input');
            nameInput.className = 'shinoa-iplog-compare-input shinoa-iplog-compare-name';
            nameInput.type = 'text';
            nameInput.placeholder = 'Ник или ID';
            nameInput.autocomplete = 'off';

            const serverInput = document.createElement('input');
            serverInput.className = 'shinoa-iplog-compare-input shinoa-iplog-compare-server';
            serverInput.type = 'number';
            serverInput.inputMode = 'numeric';
            serverInput.min = '1';
            serverInput.max = '999';
            serverInput.placeholder = '103';
            if (defaultServerId) {
                serverInput.value = String(defaultServerId);
            }

            controls.appendChild(nameInput);
            controls.appendChild(serverInput);

            const tableHost = document.createElement('div');
            tableHost.className = 'shinoa-iplog-table-container shinoa-iplog-table-container--compare-window';
            tableHost.textContent = 'Пусто';

            win.appendChild(winHeader);
            win.appendChild(controls);
            win.appendChild(tableHost);
            compareWindows.appendChild(win);
            setTimeout(() => {
                try {
                    win.scrollIntoView({ block: 'end', inline: 'nearest' });
                } catch {}
            }, 0);

            const state = {
                root: win,
                title,
                geoStatusEl,
                nameInput,
                serverInput,
                tableHost,
                player: null,
                ipLogData: null,
                matchKeys: null
            };
            compareWindowStates.push(state);

            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = compareWindowStates.indexOf(state);
                if (index >= 0) {
                    compareWindowStates.splice(index, 1);
                }
                win.remove();
                clearMatchHighlights();
                renderCompareResult(null);

                if (!compareWindowStates.length) {
                    compareContainer.style.display = 'none';
                    comparePanel.style.display = 'none';
                    popup.classList.remove('shinoa-iplog-popup--split');
                }

                setTimeout(() => updatePosition(), 0);
            });

            return state;
        };

        const renderCompareWindowTable = (state, entries, geoLoading) => {
            state.tableHost.textContent = '';

            const table = document.createElement('table');
            table.className = 'shinoa-iplog-table';

            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');
            ['IP адрес', 'Местоположение', 'Первое появление', 'Последнее появление', 'Кол-во входов'].forEach((text) => {
                const th = document.createElement('th');
                th.textContent = text;
                headerRow.appendChild(th);
            });
            thead.appendChild(headerRow);
            table.appendChild(thead);

            const tbodyLocal = document.createElement('tbody');
            (entries || []).forEach((entry) => {
                const row = document.createElement('tr');
                row.className = 'shinoa-iplog-row';
                row.dataset.ip = entry.ip;

                const ipCell = document.createElement('td');
                ipCell.className = 'shinoa-iplog-ip';

                const ipSpan = document.createElement('span');
                ipSpan.textContent = entry.ip;
                ipCell.appendChild(ipSpan);

                const copyBtn = document.createElement('button');
                copyBtn.className = 'shinoa-iplog-copy-btn';
                copyBtn.textContent = '📋';
                copyBtn.title = 'Скопировать IP';
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(entry.ip).then(() => {
                        copyBtn.textContent = '✓';
                        setTimeout(() => {
                            copyBtn.textContent = '📋';
                        }, 2000);
                    }).catch(err => {
                        debug('Failed to copy IP:', err);
                    });
                });
                ipCell.appendChild(copyBtn);
                row.appendChild(ipCell);

                const geoCell = document.createElement('td');
                geoCell.className = 'shinoa-iplog-geo';
                if (entry.geo?.text) {
                    geoCell.textContent = entry.geo.text;
                } else if (geoLoading) {
                    geoCell.textContent = 'Загрузка...';
                    geoCell.style.color = 'rgba(236, 241, 249, 0.5)';
                } else {
                    geoCell.textContent = 'Нет данных';
                }
                row.appendChild(geoCell);

                const firstSeenCell = document.createElement('td');
                firstSeenCell.className = 'shinoa-iplog-date';
                firstSeenCell.textContent = entry.firstSeen || '';
                row.appendChild(firstSeenCell);

                const lastSeenCell = document.createElement('td');
                lastSeenCell.className = 'shinoa-iplog-date';
                lastSeenCell.textContent = entry.lastSeen || '';
                row.appendChild(lastSeenCell);

                const countCell = document.createElement('td');
                countCell.className = 'shinoa-iplog-count';
                countCell.textContent = entry.count ?? '';
                row.appendChild(countCell);

                tbodyLocal.appendChild(row);
            });

            table.appendChild(tbodyLocal);
            state.tableHost.appendChild(table);
        };

        const tableContainer = document.createElement('div');
        tableContainer.className = 'shinoa-iplog-table-container';

        const table = document.createElement('table');
        table.className = 'shinoa-iplog-table';

        // Заголовок таблицы
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        ['IP адрес', 'Местоположение', 'Первое появление', 'Последнее появление', 'Кол-во входов'].forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Тело таблицы
        const tbody = document.createElement('tbody');

        ipData.forEach((entry) => {
            const row = document.createElement('tr');
            row.className = 'shinoa-iplog-row';
            row.dataset.ip = entry.ip; // Для обновления геолокации

            // IP адрес
            const ipCell = document.createElement('td');
            ipCell.className = 'shinoa-iplog-ip';

            const ipSpan = document.createElement('span');
            ipSpan.textContent = entry.ip;
            ipCell.appendChild(ipSpan);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'shinoa-iplog-copy-btn';
            copyBtn.textContent = '📋';
            copyBtn.title = 'Копировать IP';
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(entry.ip).then(() => {
                    copyBtn.textContent = '✓';
                    setTimeout(() => {
                        copyBtn.textContent = '📋';
                    }, 2000);
                }).catch(err => {
                    debug('Failed to copy IP:', err);
                });
            });
            ipCell.appendChild(copyBtn);

            row.appendChild(ipCell);

            // Геолокация
            const geoCell = document.createElement('td');
            geoCell.className = 'shinoa-iplog-geo';
            if (entry.geo?.text) {
                geoCell.textContent = entry.geo.text;
            } else if (isGeoLoading) {
                geoCell.textContent = 'Загрузка...';
                geoCell.style.color = 'rgba(236, 241, 249, 0.5)';
            } else {
                geoCell.textContent = 'Нет данных';
            }
            row.appendChild(geoCell);

            // Первое появление
            const firstSeenCell = document.createElement('td');
            firstSeenCell.className = 'shinoa-iplog-date';
            firstSeenCell.textContent = entry.firstSeen;
            row.appendChild(firstSeenCell);

            // Последнее появление
            const lastSeenCell = document.createElement('td');
            lastSeenCell.className = 'shinoa-iplog-date';
            lastSeenCell.textContent = entry.lastSeen;
            row.appendChild(lastSeenCell);

            // Количество входов
            const countCell = document.createElement('td');
            countCell.className = 'shinoa-iplog-count';
            countCell.textContent = entry.count;
            row.appendChild(countCell);

            tbody.appendChild(row);
        });

        table.appendChild(tbody);
        tableContainer.appendChild(table);
        mainPanel.appendChild(tableContainer);

        if (!isGeoLoading) {
            applyIPLogGeoMissingInfo(popup, ipLogMeta, playerContext);
        }

        const clearMatchHighlights = () => {
            const rows = popup.querySelectorAll('tr.shinoa-iplog-row.shinoa-iplog-match');
            rows.forEach((row) => row.classList.remove('shinoa-iplog-match'));
        };

        const renderCompareResult = (result) => {
            compareResult.textContent = '';

            if (!result) {
                return;
            }

            const summary = document.createElement('div');
            summary.className = 'shinoa-iplog-compare-summary';
            summary.textContent = `Совпадений: ${result.matches.length} (режим: ${result.modeLabel}, игроков: ${result.playersCount})`;
            compareResult.appendChild(summary);

            if (!result.matches.length) {
                const empty = document.createElement('div');
                empty.className = 'shinoa-iplog-compare-empty';
                empty.textContent = 'Совпадающих IP не найдено.';
                compareResult.appendChild(empty);
                return;
            }

            const details = document.createElement('details');
            details.className = 'shinoa-iplog-compare-details';

            const detailsSummary = document.createElement('summary');
            detailsSummary.className = 'shinoa-iplog-compare-details-summary';
            detailsSummary.textContent = 'Показать список совпадений';
            details.appendChild(detailsSummary);

            const matchTable = document.createElement('table');
            matchTable.className = 'shinoa-iplog-compare-table';

            const matchHead = document.createElement('thead');
            const matchHeadRow = document.createElement('tr');
            ['Совпадение', 'Кол-во (текущий)', 'Игроки', 'Кол-во (все)', 'Последний (текущий)', 'Последний (все)'].forEach((text) => {
                const th = document.createElement('th');
                th.textContent = text;
                matchHeadRow.appendChild(th);
            });
            matchHead.appendChild(matchHeadRow);
            matchTable.appendChild(matchHead);

            const matchBody = document.createElement('tbody');
            result.matches.forEach((match) => {
                const tr = document.createElement('tr');

                const ipTd = document.createElement('td');
                ipTd.className = 'shinoa-iplog-ip';
                ipTd.textContent = match.key;
                tr.appendChild(ipTd);

                const aCountTd = document.createElement('td');
                aCountTd.textContent = String(match.primary.count ?? '');
                tr.appendChild(aCountTd);

                const playersTd = document.createElement('td');
                playersTd.textContent = match.players
                    .map((player) => `${player.label} (${player.count})`)
                    .join(', ');
                tr.appendChild(playersTd);

                const totalTd = document.createElement('td');
                totalTd.textContent = String(match.secondaryTotal.count ?? '');
                tr.appendChild(totalTd);

                const aLastTd = document.createElement('td');
                aLastTd.textContent = match.primary.lastSeen || '';
                tr.appendChild(aLastTd);

                const allLastTd = document.createElement('td');
                allLastTd.textContent = match.secondaryTotal.lastSeen || '';
                tr.appendChild(allLastTd);

                matchBody.appendChild(tr);
            });

            matchTable.appendChild(matchBody);
            details.appendChild(matchTable);
            compareResult.appendChild(details);
        };

        const updateCompareWindowGeo = (windowRoot, entries, progress = null) => {
            const geoStatusEl = windowRoot.querySelector('.shinoa-iplog-compare-geo-status');
            if (geoStatusEl && progress) {
                if (progress.type === 'geo-progress') {
                    geoStatusEl.textContent = ` - Гео: ${progress.loadedIPs}/${progress.totalIPs}`;
                    geoStatusEl.style.color = '#ffcc00';
                } else if (progress.type === 'geo-complete') {
                    geoStatusEl.textContent = ' - Готово';
                    geoStatusEl.style.color = '#00ff00';
                    setTimeout(() => {
                        geoStatusEl.textContent = '';
                    }, 2000);
                } else if (progress.type === 'geo-error') {
                    geoStatusEl.textContent = ' - Ошибка гео';
                    geoStatusEl.style.color = '#ff4444';
                }
            }

            const tbody = windowRoot.querySelector('tbody');
            if (!tbody) {
                return;
            }

            for (const entry of entries) {
                const row = tbody.querySelector(`tr[data-ip="${entry.ip}"]`);
                if (row) {
                    const geoCell = row.querySelector('.shinoa-iplog-geo');
                    if (geoCell && entry.geo?.text) {
                        geoCell.textContent = entry.geo.text;
                        geoCell.style.color = '';
                    }
                }
            }
        };

        compareBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            compareBtn.classList.remove('shinoa-iplog-compare-btn--attention');
            if (comparePanel.style.display === 'none') {
                compareContainer.style.display = '';
                comparePanel.style.display = '';
                popup.classList.add('shinoa-iplog-popup--split');
                if (!compareWindowStates.length) {
                    const win = createCompareWindow();
                    if (win) {
                        win.nameInput.focus();
                    }
                } else {
                    compareWindowStates[0].nameInput.focus();
                }
                setTimeout(() => updatePosition(), 0);
                return;
            }

            // Если уже открыто — "+" добавляет новое окно
            const win = createCompareWindow();
            if (win) {
                win.nameInput.focus();
            }
            setTimeout(() => updatePosition(), 0);
        });

        runBtn.addEventListener('click', async (e) => {
            e.stopPropagation();

            const mode = (modeSelect.value || 'exact').toString();

            const requested = compareWindowStates
                .map((state) => {
                    const name = (state.nameInput?.value || '').trim();
                    const serverRaw = (state.serverInput?.value || '').toString().trim();
                    const serverId = Number(serverRaw);
                    return { state, name, serverId };
                })
                .filter((entry) => entry.name);

            if (!requested.length) {
                status.textContent = 'Добавьте хотя бы одного игрока.';
                status.dataset.type = 'error';
                return;
            }

            const badServer = requested.find((entry) => !Number.isFinite(entry.serverId) || entry.serverId <= 0);
            if (badServer) {
                status.textContent = `Укажите корректный сервер для: ${badServer.name}`;
                status.dataset.type = 'error';
                return;
            }

            status.textContent = `Загрузка игроков: 0/${requested.length}...`;
            status.dataset.type = 'loading';
            renderCompareResult(null);
            clearMatchHighlights();

            compareWindowStates.forEach((state) => {
                state.matchKeys = null;
                state.player = null;
                state.ipLogData = null;
                state.root.dataset.hasMatches = '0';
                if (state.geoStatusEl) {
                    state.geoStatusEl.textContent = '';
                    state.geoStatusEl.style.color = '';
                }
                if (state.tableHost) {
                    state.tableHost.textContent = 'Пусто';
                }
            });

            compareWindowStates.forEach((state) => {
                if (state.nameInput) state.nameInput.disabled = true;
                if (state.serverInput) state.serverInput.disabled = true;
            });
            modeSelect.disabled = true;
            runBtn.disabled = true;

            try {
                const players = [];

                for (let index = 0; index < requested.length; index++) {
                    const currentState = requested[index].state;
                    const currentName = requested[index].name;
                    const currentServer = requested[index].serverId;

                    status.textContent = `Загрузка игрока ${index + 1}/${requested.length}: ${currentName} [${currentServer}]...`;
                    status.dataset.type = 'loading';

                    const player = await fetchShinoaPlayerData(currentName, currentServer);
                    if (!player?.accountId) {
                        throw new Error(`Не удалось получить accountId игрока: ${currentName}`);
                    }

                    status.textContent = `Загрузка IP LOG ${index + 1}/${requested.length}: ${currentName} [${currentServer}] (${player.accountId})...`;
                    status.dataset.type = 'loading';

                    const ipLog = await getIPLogData(
                        player.accountId,
                        String(currentServer),
                        player.regDate,
                        null
                    );

                    currentState.title.textContent = `[${currentServer}] ${currentName} (${player.accountId})`;
                    currentState.ipLogData = ipLog;

                    const geoLoading = ipLog.ips.length > 0 && !ipLog.loadStatus.geoLoaded;
                    renderCompareWindowTable(currentState, ipLog.ips, geoLoading);

                    if (geoLoading) {
                        currentState.geoStatusEl.textContent = ' - Гео...';
                        currentState.geoStatusEl.style.color = '#ffcc00';
                        loadIPLogGeolocation(ipLog, (progress) => {
                            updateCompareWindowGeo(currentState.root, ipLog.ips, progress);
                            if (progress.type === 'geo-complete' && !ipLog.loadStatus.hasErrors) {
                                ipLogCache.set(player.accountId, ipLog);
                            }
                        });
                    }

                    currentState.player = {
                        name: `[${currentServer}] ${currentName}`,
                        accountId: player.accountId,
                        serverId: String(currentServer),
                        ips: ipLog.ips,
                        ipLogData: ipLog
                    };
                    players.push(currentState.player);
                }

                const result = compareIPLogsByMode(ipData, players, mode);

                // Подсвечиваем совпавшие IP/подсети в основной таблице
                const rows = tbody.querySelectorAll('tr.shinoa-iplog-row');
                rows.forEach((row) => {
                    const ip = row.dataset.ip;
                    const key = ipToMatchKey(ip, mode);
                    if (key && result.matchKeys.has(key)) {
                        row.classList.add('shinoa-iplog-match');
                    }
                });

                compareWindowStates.forEach((state) => {
                    if (!state.player) return;

                    const one = compareIPLogsByMode(ipData, [state.player], mode);
                    state.matchKeys = one.matchKeys;
                    state.root.dataset.hasMatches = one.matches.length ? '1' : '0';

                    const winRows = state.root.querySelectorAll('tr.shinoa-iplog-row');
                    winRows.forEach((row) => {
                        const ip = row.dataset.ip;
                        const key = ipToMatchKey(ip, mode);
                        if (key && one.matchKeys.has(key)) {
                            row.classList.add('shinoa-iplog-match');
                        }
                    });
                });

                renderCompareResult(result);
                status.textContent = `Готово. Совпадений: ${result.matches.length}`;
                status.dataset.type = 'ok';
            } catch (error) {
                const isAuthError = error?.code === 'LOGS_AUTH_REQUIRED' || isLogsAuthError(error);

                status.textContent = isAuthError
                    ? 'Нужна авторизация на arizonarp.logsparser.info для IP LOG'
                    : (error?.message || 'Ошибка сопоставления');
                status.dataset.type = 'error';

                if (isAuthError) {
                    notifyLogsAuthRequired();
                }
            } finally {
                compareWindowStates.forEach((state) => {
                    if (state.nameInput) state.nameInput.disabled = false;
                    if (state.serverInput) state.serverInput.disabled = false;
                });
                modeSelect.disabled = false;
                runBtn.disabled = false;
            }
        });

        // Функция для обновления позиции popup
        function updatePosition() {
            const rect = anchorElement.getBoundingClientRect();

            const margin = 12;
            const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
            const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;

            const popupW = popup.offsetWidth || 0;
            const popupH = popup.offsetHeight || 0;

            let top = rect.bottom + 5;
            let left = rect.left + (rect.width / 2) - (popupW / 2);

            // Если не помещается снизу — пробуем сверху
            if (top + popupH + margin > viewportH) {
                top = rect.top - popupH - 5;
            }

            // Клампим в пределах экрана
            top = Math.max(margin, Math.min(top, viewportH - popupH - margin));
            left = Math.max(margin, Math.min(left, viewportW - popupW - margin));

            popup.style.top = `${top}px`;
            popup.style.left = `${left}px`;
        }

        // Обработчик скролла для перемещения popup
        function handleScroll() {
            updatePosition();
        }

        // Закрытие при клике вне popup
        function closePopup(e) {
            if (!popup.contains(e.target)) {
                popup.remove();
                document.removeEventListener('click', closePopup);
                window.removeEventListener('scroll', handleScroll, true);
            }
        }

        setTimeout(() => {
            document.addEventListener('click', closePopup);
        }, 0);

        // Добавляем обработчик скролла
        window.addEventListener('scroll', handleScroll, true);

        // Позиционирование popup
        document.body.appendChild(popup);

        popup.style.position = 'fixed';
        updatePosition();

        return popup; // Возвращаем popup для обновления
    }

    function parseIPv4(ip) {
        const value = (ip || '').toString().trim();
        const parts = value.split('.');
        if (parts.length !== 4) return null;
        const nums = parts.map((p) => Number(p));
        if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        return nums;
    }

    function ipToMatchKey(ip, mode) {
        const nums = parseIPv4(ip);
        if (!nums) return null;

        if (mode === '16') {
            return `${nums[0]}.${nums[1]}.X.X`;
        }
        if (mode === '24') {
            return `${nums[0]}.${nums[1]}.${nums[2]}.X`;
        }
        return `${nums[0]}.${nums[1]}.${nums[2]}.${nums[3]}`;
    }

    function modeToLabel(mode) {
        if (mode === '16') return '81.56.X.X';
        if (mode === '24') return '81.56.209.X';
        return '1:1';
    }

    function aggregateByKey(entries, mode) {
        const map = new Map();
        (entries || []).forEach((entry) => {
            const key = ipToMatchKey(entry?.ip, mode);
            if (!key) return;

            if (!map.has(key)) {
                map.set(key, {
                    key,
                    count: 0,
                    lastSeen: entry?.lastSeen || entry?.date || null
                });
            }

            const agg = map.get(key);
            const increment = Number.isFinite(Number(entry?.count))
                ? Number(entry.count)
                : 1;
            agg.count += increment;

            const toTs = (value) => {
                if (!value) return 0;
                const ts = new Date(value).getTime();
                return Number.isFinite(ts) ? ts : 0;
            };

            const currentLast = toTs(agg.lastSeen);
            const entryLast = toTs(entry?.lastSeen || entry?.date);
            if (entryLast > currentLast) {
                agg.lastSeen = entry.lastSeen || entry.date;
            }
        });
        return map;
    }

    function compareIPLogsByMode(primaryEntries, secondaryPlayers, mode) {
        const primaryMap = aggregateByKey(primaryEntries, mode);
        const players = (secondaryPlayers || []).map((player) => ({
            ...player,
            keyMap: aggregateByKey(player.ips, mode)
        }));

        const matches = [];
        const matchKeys = new Set();

        for (const [key, primaryAgg] of primaryMap.entries()) {
            const hitPlayers = [];
            let totalCount = 0;
            let totalLastSeen = null;

            for (const player of players) {
                const agg = player.keyMap.get(key);
                if (!agg) continue;

                hitPlayers.push({
                    label: player.name,
                    accountId: player.accountId,
                    count: agg.count,
                    lastSeen: agg.lastSeen
                });

                totalCount += agg.count;
                const cur = totalLastSeen ? new Date(totalLastSeen).getTime() : 0;
                const nxt = agg.lastSeen ? new Date(agg.lastSeen).getTime() : 0;
                if (nxt > cur) {
                    totalLastSeen = agg.lastSeen;
                }
            }

            if (!hitPlayers.length) continue;

            matchKeys.add(key);
            matches.push({
                key,
                primary: primaryAgg,
                players: hitPlayers,
                secondaryTotal: {
                    count: totalCount,
                    lastSeen: totalLastSeen
                }
            });
        }

        const toTs = (value) => {
            if (!value) return 0;
            const ts = new Date(value).getTime();
            return Number.isFinite(ts) ? ts : 0;
        };

        matches.sort((m1, m2) => {
            const d1 = Math.max(toTs(m1.primary.lastSeen), toTs(m1.secondaryTotal.lastSeen));
            const d2 = Math.max(toTs(m2.primary.lastSeen), toTs(m2.secondaryTotal.lastSeen));
            return d2 - d1;
        });

        return {
            matches,
            matchKeys,
            modeLabel: modeToLabel(mode),
            playersCount: players.length
        };
    }

    function getMetaCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        if (!meta) {
            return null;
        }
        const value = meta.getAttribute('content') || meta.getAttribute('value') || meta.content || meta.value;
        return value ? value.toString().trim() : null;
    }

    function getCookieValue(name) {
        try {
            const cookieString = document.cookie || '';
            const parts = cookieString.split(';');
            for (const part of parts) {
                const [rawKey, ...rest] = part.split('=');
                const key = (rawKey || '').trim();
                if (key === name) {
                    return rest.join('=').trim();
                }
            }
        } catch {}
        return null;
    }

    async function fetchShinoaPlayerData(name, serverId) {
        const payload = await fetchShinoaPlayerPayload(name, serverId);
        const data = extractData(payload);
        if (!data || !data.info) {
            throw new Error('Shinoa API: неожиданный формат ответа');
        }

        const info = data.info;
        const accountId = info.id?.toString() ||
            info.player_id?.toString() ||
            info.account_id?.toString() ||
            null;

        const regDate = info.reg_date || info.registration_date || null;

        return {
            accountId,
            serverId: String(serverId),
            regDate
        };
    }

    async function fetchShinoaPlayerPayload(name, serverId) {
        const csrf = getMetaCsrfToken();
        const xsrfCookie = getCookieValue('XSRF-TOKEN');
        let xsrf = xsrfCookie;
        try {
            if (xsrfCookie) {
                xsrf = decodeURIComponent(xsrfCookie);
            }
        } catch {}

        const headers = {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-requested-with': 'XMLHttpRequest'
        };

        if (csrf) {
            headers['x-csrf-token'] = csrf;
        }
        if (xsrf) {
            headers['x-xsrf-token'] = xsrf;
        }

        const response = await fetch('/api/v1/player', {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({
                name: String(name),
                server: Number(serverId)
            })
        });

        if (!response.ok) {
            const error = new Error(`Shinoa API error: ${response.status}`);
            error.status = response.status;
            throw error;
        }

        return await response.json();
    }

    // Обновляет геолокацию в открытом popup
    function updateIPLogPopupGeo(ipData, progress = null) {
        const popup = document.querySelector('.shinoa-iplog-popup');
        if (!popup) {
            return;
        }

        const tbody = popup.querySelector('tbody');
        if (!tbody) {
            return;
        }

        // Обновляем статус в заголовке
        const geoStatus = popup.querySelector('.shinoa-iplog-geo-status');
        if (geoStatus && progress) {
            if (progress.type === 'geo-progress') {
                geoStatus.textContent = ` - Геолокация: ${progress.loadedIPs}/${progress.totalIPs}`;
                geoStatus.style.color = '#ffcc00';
            } else if (progress.type === 'geo-complete') {
                geoStatus.textContent = ' - Готово';
                geoStatus.style.color = '#00ff00';
                setTimeout(() => {
                    geoStatus.textContent = '';
                }, 2000);
            } else if (progress.type === 'geo-error') {
                geoStatus.textContent = ' - Ошибка загрузки';
                geoStatus.style.color = '#ff4444';
            }
        }

        // Обновляем геолокацию в строках
        for (const entry of ipData) {
            const row = tbody.querySelector(`tr[data-ip="${entry.ip}"]`);
            if (row) {
                const geoCell = row.querySelector('.shinoa-iplog-geo');
                if (geoCell && entry.geo?.text) {
                    geoCell.textContent = entry.geo.text;
                    geoCell.style.color = ''; // Убираем стиль загрузки
                }
            }
        }
    }

    function updateIPLogPopupGeo(ipLogMeta, progress = null, playerContext = null) {
        const popup = document.querySelector('.shinoa-iplog-popup');
        if (!popup) {
            return;
        }

        const tbody = popup.querySelector('tbody');
        if (!tbody) {
            return;
        }

        const entries = Array.isArray(ipLogMeta?.ips)
            ? ipLogMeta.ips
            : (Array.isArray(ipLogMeta) ? ipLogMeta : []);

        const geoStatus = popup.querySelector('.shinoa-iplog-geo-status');
        if (geoStatus && progress) {
            if (progress.type === 'geo-progress') {
                geoStatus.textContent = ` - Геолокация: ${progress.loadedIPs}/${progress.totalIPs}`;
                geoStatus.style.color = '#ffcc00';
            } else if (progress.type === 'geo-complete') {
                geoStatus.textContent = ' - Готово';
                geoStatus.style.color = '#00ff00';
                setTimeout(() => {
                    geoStatus.textContent = '';
                }, 2000);
                applyIPLogGeoMissingInfo(popup, ipLogMeta, playerContext);
            } else if (progress.type === 'geo-error') {
                geoStatus.textContent = ' - Ошибка загрузки';
                geoStatus.style.color = '#ff4444';
                applyIPLogGeoMissingInfo(popup, ipLogMeta, playerContext);
            }
        }

        for (const entry of entries) {
            const row = tbody.querySelector(`tr[data-ip="${entry.ip}"]`);
            if (row) {
                const geoCell = row.querySelector('.shinoa-iplog-geo');
                if (geoCell && entry.geo?.text) {
                    geoCell.textContent = entry.geo.text;
                    geoCell.style.color = '';
                }
            }
        }

        if (progress && (progress.type === 'geo-complete' || progress.type === 'geo-error')) {
            for (const entry of entries) {
                if (entry.geo?.text) {
                    continue;
                }
                const row = tbody.querySelector(`tr[data-ip="${entry.ip}"]`);
                if (!row) {
                    continue;
                }
                const geoCell = row.querySelector('.shinoa-iplog-geo');
                if (geoCell) {
                    geoCell.textContent = 'Нет данных';
                    geoCell.style.color = '';
                }
            }
        }
    }

    function displayAttachmentData(cell, data, type, playerData = null) {
        // Убираем кнопку
        const button = cell.querySelector('.shinoa-attachment-btn');
        if (button) {
            button.remove();
        }

        const container = document.createElement('div');
        container.className = 'shinoa-attachment-container';

        // Помечаем accountId для идентификации данных
        if (playerData?.accountId) {
            container.dataset.accountId = playerData.accountId;
        }

        if (data.current) {
            const currentDiv = document.createElement('div');
            currentDiv.className = 'shinoa-attachment-current';

            if (type === 'vk') {
                // Для VK делаем ID кликабельным
                const displayText = data.current.displayText;
                const vkId = data.current.id;

                // Пытаемся найти ID в displayText и сделать его ссылкой
                if (displayText && vkId) {
                    // Поддерживаем оба формата: "VK ID: 123" и "id: 123"
                    const vkIdPattern = new RegExp(`((?:VK\\s+)?id[:\\s]+)(${vkId})`, 'i');
                    const match = displayText.match(vkIdPattern);

                    if (match) {
                        const beforeId = displayText.substring(0, match.index + match[1].length);
                        const afterId = displayText.substring(match.index + match[0].length);

                        currentDiv.textContent = 'Привязан: ' + beforeId;

                        const link = document.createElement('a');
                        link.href = `https://vk.com/id${vkId}`;
                        link.target = '_blank';
                        link.textContent = vkId;
                        currentDiv.appendChild(link);
                        currentDiv.appendChild(document.createTextNode(afterId));
                    } else {
                        currentDiv.textContent = `Привязан: ${displayText}`;
                    }
                } else {
                    currentDiv.textContent = `Привязан: ${displayText || vkId || 'Неизвестно'}`;
                }
            } else {
                // Для Telegram просто показываем текст
                const displayText = data.current.displayText;
                currentDiv.textContent = `Привязан: ${displayText || data.current.id || 'Неизвестно'}`;
            }

            container.appendChild(currentDiv);
        } else {
            const noneDiv = document.createElement('div');
            noneDiv.className = 'shinoa-attachment-none';
            noneDiv.textContent = 'Не привязан';
            container.appendChild(noneDiv);
        }

        if (data.history && data.history.length > 0) {
            const historyDiv = document.createElement('div');
            historyDiv.className = 'shinoa-attachment-history';
            historyDiv.textContent = `(История: ${data.history.length} событий)`;
            historyDiv.style.cursor = 'pointer';

            // Создаем popup для истории
            historyDiv.addEventListener('click', (e) => {
                e.stopPropagation();
                showHistoryPopup(historyDiv, data.history);
            });

            container.appendChild(historyDiv);
        }

        // Показываем предупреждение об ошибках если они были
        if (data.loadStatus && data.loadStatus.hasErrors) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'shinoa-attachment-error';
            errorDiv.textContent = `⚠ Загружено ${data.loadStatus.success} из ${data.loadStatus.total}`;
            container.appendChild(errorDiv);

            // Добавляем кнопку повтора
            if (playerData) {
                const retryBtn = document.createElement('button');
                retryBtn.className = 'shinoa-attachment-retry';
                retryBtn.textContent = 'Повторить попытку';
                retryBtn.addEventListener('click', async () => {
                    retryBtn.disabled = true;
                    retryBtn.textContent = 'Загрузка...';

                    // Очищаем кеш чтобы загрузить заново
                    attachmentCache.delete(playerData.accountId);

                    // Находим обе ячейки
                    const rows = document.querySelectorAll('tr');
                    let vkCell = null;
                    let telegramCell = null;

                    for (const row of rows) {
                        const firstCell = row.cells && row.cells[0];
                        if (!firstCell) continue;
                        const text = firstCell.textContent.trim();
                        if (text === 'ID ВКонтакте') vkCell = row.cells[1];
                        else if (text === 'ID Telegram') telegramCell = row.cells[1];
                    }

                    try {
                        const newData = await getAttachmentData(
                            playerData.accountId,
                            playerData.serverId,
                            playerData.regDate,
                            (completed, total) => {
                                retryBtn.textContent = `Загрузка ${completed}/${total}`;
                            }
                        );

                        // Обновляем обе ячейки
                        if (vkCell) {
                            vkCell.innerHTML = '';
                            displayAttachmentData(vkCell, newData.vk, 'vk', playerData);
                        }
                        if (telegramCell) {
                            telegramCell.innerHTML = '';
                            displayAttachmentData(telegramCell, newData.telegram, 'telegram', playerData);
                        }
                    } catch (error) {
                        retryBtn.textContent = 'Ошибка повтора';
                        debug('Retry failed:', error);
                    }
                });
                container.appendChild(retryBtn);
            }
        }

        cell.appendChild(container);
    }

    function displayEmailData(cell, data, playerData = null) {
        // Убираем старую кнопку если есть
        const existingButton = cell.querySelector('.shinoa-email-history-btn');
        if (existingButton) {
            existingButton.remove();
        }

        // Если нет истории, не показываем ничего
        if (!data.history || data.history.length === 0) {
            debug('No email history to display');
            return;
        }

        // Создаем кнопку "Показать историю"
        const historyBtn = document.createElement('button');
        historyBtn.className = 'shinoa-email-history-btn';
        historyBtn.textContent = `Показать историю (${data.history.length})`;
        historyBtn.type = 'button';

        // Помечаем accountId для идентификации данных
        if (playerData?.accountId) {
            historyBtn.dataset.accountId = playerData.accountId;
        }

        historyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showEmailHistoryPopup(historyBtn, data.history);
        });

        // Добавляем кнопку после текущего содержимого ячейки
        cell.appendChild(historyBtn);

        // Показываем предупреждение об ошибках если они были
        if (data.loadStatus && data.loadStatus.hasErrors) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'shinoa-attachment-error';
            errorDiv.textContent = `⚠ Загружено ${data.loadStatus.success} из ${data.loadStatus.total}`;
            errorDiv.style.marginLeft = '8px';
            errorDiv.style.display = 'inline-block';
            cell.appendChild(errorDiv);

            // Добавляем кнопку повтора
            if (playerData) {
                const retryBtn = document.createElement('button');
                retryBtn.className = 'shinoa-attachment-retry';
                retryBtn.textContent = 'Повторить';
                retryBtn.style.marginLeft = '8px';
                retryBtn.addEventListener('click', async () => {
                    retryBtn.disabled = true;
                    retryBtn.textContent = 'Загрузка...';

                    // Очищаем кеш чтобы загрузить заново
                    emailCache.delete(playerData.accountId);

                    // Находим ячейку Email
                    const rows = document.querySelectorAll('tr');
                    let emailCell = null;

                    for (const row of rows) {
                        const firstCell = row.cells && row.cells[0];
                        if (!firstCell) continue;
                        const text = firstCell.textContent.trim();
                        if (text === 'E-Mail') {
                            emailCell = row.cells[1];
                            break;
                        }
                    }

                    try {
                        const newData = await getEmailData(
                            playerData.accountId,
                            playerData.serverId,
                            playerData.regDate,
                            (completed, total) => {
                                retryBtn.textContent = `Загрузка ${completed}/${total}`;
                            }
                        );

                        // Убираем старые элементы
                        if (emailCell) {
                            const oldBtn = emailCell.querySelector('.shinoa-email-history-btn');
                            const oldError = emailCell.querySelector('.shinoa-attachment-error');
                            const oldRetry = emailCell.querySelector('.shinoa-attachment-retry');
                            if (oldBtn) oldBtn.remove();
                            if (oldError) oldError.remove();
                            if (oldRetry) oldRetry.remove();

                            // Отображаем новые данные
                            displayEmailData(emailCell, newData, playerData);
                        }
                    } catch (error) {
                        retryBtn.textContent = 'Ошибка';
                        retryBtn.disabled = false;
                        debug('Retry failed:', error);
                    }
                });
                cell.appendChild(retryBtn);
            }
        }
    }

    function showEmailHistoryPopup(anchorElement, history) {
        // Удаляем существующий popup если есть
        const existingPopup = document.querySelector('.shinoa-history-popup');
        if (existingPopup) {
            existingPopup.remove();
            return; // Toggle behavior
        }

        const popup = document.createElement('div');
        popup.className = 'shinoa-history-popup';

        const header = document.createElement('div');
        header.className = 'shinoa-history-popup-header';
        header.textContent = 'История изменений Email';
        popup.appendChild(header);

        const list = document.createElement('div');
        list.className = 'shinoa-history-popup-list';

        history.forEach((event, index) => {
            const item = document.createElement('div');
            item.className = 'shinoa-history-popup-item';

            // Создаем контейнер для основного контента (дата + текст)
            const contentWrapper = document.createElement('div');
            contentWrapper.className = 'shinoa-history-popup-content';

            // Добавляем дату
            const dateDiv = document.createElement('div');
            dateDiv.className = 'shinoa-history-popup-date';
            dateDiv.textContent = event.date;
            contentWrapper.appendChild(dateDiv);

            const text = document.createElement('div');
            text.className = 'shinoa-history-popup-text';
            text.textContent = event.text;

            contentWrapper.appendChild(text);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'shinoa-history-popup-copy';
            copyBtn.textContent = 'Скопировать';
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(event.text).then(() => {
                    copyBtn.textContent = 'Скопировано!';
                    setTimeout(() => {
                        copyBtn.textContent = 'Скопировать';
                    }, 2000);
                }).catch(err => {
                    debug('Failed to copy:', err);
                });
            });

            item.appendChild(contentWrapper);
            item.appendChild(copyBtn);
            list.appendChild(item);
        });

        popup.appendChild(list);

        // Функция для обновления позиции popup
        function updatePosition() {
            const rect = anchorElement.getBoundingClientRect();
            popup.style.top = `${rect.bottom + 5}px`;
            popup.style.left = `${rect.left}px`;
        }

        // Обработчик скролла для перемещения popup
        function handleScroll() {
            updatePosition();
        }

        // Закрытие при клике вне popup
        function closePopup(e) {
            if (!popup.contains(e.target)) {
                popup.remove();
                document.removeEventListener('click', closePopup);
                window.removeEventListener('scroll', handleScroll, true);
            }
        }

        setTimeout(() => {
            document.addEventListener('click', closePopup);
        }, 0);

        // Добавляем обработчик скролла
        window.addEventListener('scroll', handleScroll, true);

        // Позиционирование popup
        document.body.appendChild(popup);

        popup.style.position = 'fixed';
        updatePosition();
    }

    function setupTableObserver() {
        // Отключаем старый observer если есть
        if (tableObserver) {
            tableObserver.disconnect();
        }

        // Находим контейнер с таблицей
        const tableContainer = document.querySelector('.app-content-body, main, .content');
        if (!tableContainer) {
            debug('Table container not found for observer');
            return;
        }

        // Создаем observer для отслеживания изменений в таблице
        tableObserver = new MutationObserver((mutations) => {
            if (lastIPAnnotation && needsIPAnnotation()) {
                scheduleIPAnnotation();
            }

            // Проверяем, появились ли строки "ID ВКонтакте", "ID Telegram" или "E-Mail"
            const hasVKRow = Array.from(document.querySelectorAll('tr')).some(row => {
                const firstCell = row.cells?.[0];
                return firstCell?.textContent.trim() === 'ID ВКонтакте';
            });

            const hasTGRow = Array.from(document.querySelectorAll('tr')).some(row => {
                const firstCell = row.cells?.[0];
                return firstCell?.textContent.trim() === 'ID Telegram';
            });

            const hasEmailRow = Array.from(document.querySelectorAll('tr')).some(row => {
                const firstCell = row.cells?.[0];
                return firstCell?.textContent.trim() === 'E-Mail';
            });

            // Если строки есть и нет кнопок, добавляем их
            if ((hasVKRow || hasTGRow || hasEmailRow) && lastPlayerData) {
                const vkRow = Array.from(document.querySelectorAll('tr')).find(row =>
                    row.cells?.[0]?.textContent.trim() === 'ID ВКонтакте'
                );
                const tgRow = Array.from(document.querySelectorAll('tr')).find(row =>
                    row.cells?.[0]?.textContent.trim() === 'ID Telegram'
                );
                const emailRow = Array.from(document.querySelectorAll('tr')).find(row =>
                    row.cells?.[0]?.textContent.trim() === 'E-Mail'
                );

                const vkCell = vkRow?.cells[1];
                const tgCell = tgRow?.cells[1];
                const emailCell = emailRow?.cells[1];

                const needsVKButton = vkCell && !vkCell.querySelector('.shinoa-attachment-btn, .shinoa-attachment-container');
                const needsTGButton = tgCell && !tgCell.querySelector('.shinoa-attachment-btn, .shinoa-attachment-container');
                const needsEmailButton = emailCell && !emailCell.querySelector('.shinoa-email-history-btn');

                if (needsVKButton || needsTGButton || needsEmailButton) {
                    setupAttachmentButtonsWithData(lastPlayerData);
                }
            }

            // Гарантируем, что строка IP LOG появляется, даже если таблица обновилась позже
            if (lastPlayerData) {
                const lastIPRow = findRowByLabels(['Last IP']);
                let ipLogRow = findRowByLabels(['IP LOG']);

                // Добавляем строку IP LOG, если появилась строка Last IP
                if (lastIPRow && !ipLogRow) {
                    insertIPLogRow();
                    ipLogRow = findRowByLabels(['IP LOG']);
                }

                // Настраиваем кнопку, если строка есть, но кнопка ещё не привязана к аккаунту
                const ipLogButton = ipLogRow?.querySelector('.shinoa-ip-log-btn');
                if (ipLogButton && ipLogButton.dataset.accountId !== lastPlayerData.accountId) {
                    setupIPLogButton(lastPlayerData);
                }
            }
        });

        // Наблюдаем за изменениями в контейнере
        tableObserver.observe(tableContainer, {
            childList: true,
            subtree: true
        });

        if (lastIPAnnotation && needsIPAnnotation()) {
            scheduleIPAnnotation();
        }
    }

    function setupAttachmentButtonsWithData(playerData) {
        if (!isPlayerPage()) {
            return;
        }

        ensureAttachmentStyles();

        const { accountId, serverId, regDate } = playerData;

        if (!accountId || !serverId) {
            debug('Invalid player data', playerData);
            return;
        }

        // Ищем строки с ID ВКонтакте, ID Telegram и E-Mail
        const rows = document.querySelectorAll('tr');
        let vkRow = null;
        let telegramRow = null;
        let emailRow = null;

        for (const row of rows) {
            const firstCell = row.cells && row.cells[0];
            if (!firstCell) continue;

            const text = firstCell.textContent.trim();

            if (text === 'ID ВКонтакте') {
                vkRow = row;
            } else if (text === 'ID Telegram') {
                telegramRow = row;
            } else if (text === 'E-Mail') {
                emailRow = row;
            }
        }

        const vkCell = vkRow?.cells[1];
        const telegramCell = telegramRow?.cells[1];
        const emailCell = emailRow?.cells[1];

        // Очищаем старые кнопки/данные если accountId не совпадает
        let needsCacheClear = false;

        if (vkCell) {
            const existingBtn = vkCell.querySelector('.shinoa-attachment-btn');
            const existingContainer = vkCell.querySelector('.shinoa-attachment-container');
            const existingAccountId = existingBtn?.dataset.accountId || existingContainer?.dataset.accountId;

            if (existingAccountId && existingAccountId !== accountId) {
                if (existingBtn) existingBtn.remove();
                if (existingContainer) existingContainer.remove();
                needsCacheClear = true;
            }
        }

        if (telegramCell) {
            const existingBtn = telegramCell.querySelector('.shinoa-attachment-btn');
            const existingContainer = telegramCell.querySelector('.shinoa-attachment-container');
            const existingAccountId = existingBtn?.dataset.accountId || existingContainer?.dataset.accountId;

            if (existingAccountId && existingAccountId !== accountId) {
                if (existingBtn) existingBtn.remove();
                if (existingContainer) existingContainer.remove();
                needsCacheClear = true;
            }
        }

        if (emailCell) {
            const existingBtn = emailCell.querySelector('.shinoa-email-history-btn');
            const existingAccountId = existingBtn?.dataset.accountId;

            if (existingAccountId && existingAccountId !== accountId) {
                if (existingBtn) existingBtn.remove();
                const existingError = emailCell.querySelector('.shinoa-attachment-error');
                const existingRetry = emailCell.querySelector('.shinoa-attachment-retry');
                if (existingError) existingError.remove();
                if (existingRetry) existingRetry.remove();
                needsCacheClear = true;
            }
        }

        // Очищаем кеш для старого игрока
        if (needsCacheClear) {
            // Удаляем все записи кроме текущего accountId
            for (const [cachedId, cachedData] of attachmentCache.entries()) {
                if (cachedId !== accountId) {
                    attachmentCache.delete(cachedId);
                    debug('Cleared cache for old account:', cachedId);
                }
            }
            for (const [cachedId, cachedData] of emailCache.entries()) {
                if (cachedId !== accountId) {
                    emailCache.delete(cachedId);
                    debug('Cleared email cache for old account:', cachedId);
                }
            }
        }

        // Общая функция для загрузки данных обеих привязок
        const fetchAndDisplayBoth = async (clickedButton) => {
            // Находим обе кнопки
            const vkButton = vkCell?.querySelector('.shinoa-attachment-btn');
            const telegramButton = telegramCell?.querySelector('.shinoa-attachment-btn');

            // Отключаем обе кнопки
            if (vkButton) {
                vkButton.disabled = true;
                vkButton.textContent = 'Загрузка 0/0';
            }
            if (telegramButton) {
                telegramButton.disabled = true;
                telegramButton.textContent = 'Загрузка 0/0';
            }

            try {
                // Делаем один запрос, получаем данные для обоих типов
                // С коллбэком для обновления прогресса
                const data = await getAttachmentData(accountId, serverId, regDate, (completed, total) => {
                    const progressText = `Загрузка ${completed}/${total}`;
                    if (vkButton && !vkButton.classList.contains('shinoa-btn-removed')) {
                        vkButton.textContent = progressText;
                    }
                    if (telegramButton && !telegramButton.classList.contains('shinoa-btn-removed')) {
                        telegramButton.textContent = progressText;
                    }
                });

                // Обновляем обе строки
                if (vkCell) {
                    displayAttachmentData(vkCell, data.vk, 'vk', playerData);
                }
                if (telegramCell) {
                    displayAttachmentData(telegramCell, data.telegram, 'telegram', playerData);
                }
            } catch (error) {
                const isExtCtxError = isExtensionContextUnavailable(error);
                const isAuthError = error?.code === 'LOGS_AUTH_REQUIRED' || isLogsAuthError(error);

                if (vkButton) {
                    vkButton.textContent = isExtCtxError
                        ? 'Расширение выключено'
                        : (isAuthError ? 'Нужна авторизация' : 'Ошибка');
                    vkButton.disabled = false;
                }
                if (telegramButton) {
                    telegramButton.textContent = isExtCtxError
                        ? 'Расширение выключено'
                        : (isAuthError ? 'Нужна авторизация' : 'Ошибка');
                    telegramButton.disabled = false;
                }

                if (isAuthError) {
                    notifyLogsAuthRequired();
                }

                if (isExtCtxError) {
                    notifyExtensionContextUnavailableOnce();
                }

                debug('Error loading attachment data:', error);
            }
        };

        // Добавляем кнопки
        if (vkCell && !vkCell.querySelector('.shinoa-attachment-btn')) {
            const button = createAttachmentButton('vk');
            button.dataset.accountId = accountId; // Помечаем accountId
            button.addEventListener('click', () => fetchAndDisplayBoth(button));
            vkCell.appendChild(button);
        }

        if (telegramCell && !telegramCell.querySelector('.shinoa-attachment-btn')) {
            const button = createAttachmentButton('telegram');
            button.dataset.accountId = accountId; // Помечаем accountId
            button.addEventListener('click', () => fetchAndDisplayBoth(button));
            telegramCell.appendChild(button);
        }

        // Добавляем кнопку для Email
        if (emailCell && !emailCell.querySelector('.shinoa-email-history-btn')) {
            const emailButton = document.createElement('button');
            emailButton.className = 'shinoa-email-history-btn';
            emailButton.textContent = 'Получить историю';
            emailButton.type = 'button';
            emailButton.style.marginLeft = '8px';
            emailButton.dataset.accountId = accountId;

            const fetchAndDisplayEmail = async () => {
                if (emailButton.dataset.loading === 'true') return;
                emailButton.dataset.loading = 'true';
                emailButton.disabled = true;
                emailButton.textContent = 'Загрузка 0/0';

                try {
                    const emailData = await getEmailData(accountId, serverId, regDate, (completed, total) => {
                        emailButton.textContent = `Загрузка ${completed}/${total}`;
                    });

                    // Отображаем данные (кнопка будет заменена на кнопку истории)
                    displayEmailData(emailCell, emailData, playerData);
                } catch (error) {
                    const isExtCtxError = isExtensionContextUnavailable(error);
                    const isAuthError = error?.code === 'LOGS_AUTH_REQUIRED' || isLogsAuthError(error);

                    emailButton.textContent = isExtCtxError
                        ? 'Расширение выключено'
                        : (isAuthError ? 'Нужна авторизация' : 'Ошибка, повторить');
                    emailButton.disabled = false;
                    delete emailButton.dataset.loading;

                    if (isAuthError) {
                        notifyLogsAuthRequired();
                    }

                    if (isExtCtxError) {
                        notifyExtensionContextUnavailableOnce();
                    }

                    debug('Error loading email data:', error);
                }
            };

            emailButton.addEventListener('click', fetchAndDisplayEmail);
            emailCell.appendChild(emailButton);
        }
    }

    function ensureAttachmentStyles() {
        if (document.getElementById(ATTACHMENT_STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = ATTACHMENT_STYLE_ID;
        style.textContent = `
.shinoa-attachment-btn {
    padding: 4px 12px;
    margin-left: 8px;
    background: #fff;
    color: #000;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    transition: background 0.2s ease;
}

.shinoa-attachment-btn:hover {
    background: #3abbd1;
}

.shinoa-attachment-btn:disabled {
    background: #666;
    color: #aaa;
    cursor: not-allowed;
}

.shinoa-attachment-container {
    display: inline-flex;
    flex-direction: column;
    gap: 4px;
    margin-left: 8px;
}

.shinoa-attachment-current {
    font-size: 13px;
    color: #fff;
    font-weight: 600;
}

.shinoa-attachment-current a {
    color: #fff;
    text-decoration: none;
}

.shinoa-attachment-current a:hover {
    text-decoration: underline;
}

.shinoa-attachment-none {
    font-size: 13px;
    color: rgba(236, 241, 249, 0.5);
    font-style: italic;
}

.shinoa-attachment-history {
    font-size: 11px;
    color: rgba(236, 241, 249, 0.65);
    cursor: pointer;
    text-decoration: underline;
}

.shinoa-attachment-history:hover {
    color: #fff;
}

.shinoa-attachment-error {
    font-size: 11px;
    color: #ff9800;
    font-weight: 600;
    margin-top: 2px;
}

.shinoa-attachment-retry {
    padding: 3px 10px;
    margin-top: 4px;
    background: #ff9800;
    color: #000;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    transition: background 0.2s ease;
}

.shinoa-attachment-retry:hover {
    background: #fb8c00;
}

.shinoa-attachment-retry:disabled {
    background: #666;
    color: #aaa;
    cursor: not-allowed;
}

.shinoa-email-history-btn {
    padding: 4px 12px;
    margin-left: 8px;
    background: #fff;
    color: #000;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    transition: background 0.2s ease;
    display: inline-block;
}

.shinoa-email-history-btn:hover {
    background: #3abbd1;
}

.shinoa-email-history-btn:disabled {
    background: #666;
    color: #aaa;
    cursor: not-allowed;
}

.shinoa-history-popup {
    position: fixed;
    background: #1c1f23;
    border: 1px solid #fff;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    z-index: 10000;
    min-width: 400px;
    max-width: 700px;
    max-height: 500px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.shinoa-history-popup-header {
    padding: 12px 16px;
    background: #252a30;
    border-bottom: 1px solid #fff;
    color: #fff;
    font-weight: 600;
    font-size: 14px;
}

.shinoa-history-popup-list {
    padding: 8px;
    overflow-y: auto;
    flex: 1;
}

.shinoa-history-popup-item {
    padding: 10px;
    margin-bottom: 8px;
    background: #252a30;
    border-radius: 4px;
    border: 1px solid #3a3f45;
    display: flex;
    gap: 10px;
    align-items: flex-start;
}

.shinoa-history-popup-item:last-child {
    margin-bottom: 0;
}

.shinoa-history-popup-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.shinoa-history-popup-date {
    font-size: 11px;
    color: #fff;
    font-weight: 600;
    font-family: monospace;
}

.shinoa-history-popup-text {
    font-size: 12px;
    color: rgba(236, 241, 249, 0.85);
    word-break: break-word;
    line-height: 1.4;
}

.shinoa-history-popup-link {
    color: #fff;
    text-decoration: none;
    font-weight: 600;
    border-bottom: 1px solid transparent;
    transition: all 0.2s ease;
}

.shinoa-history-popup-link:hover {
    color: #3abbd1;
    border-bottom-color: #3abbd1;
}

.shinoa-history-popup-copy {
    padding: 4px 10px;
    background: #fff;
    color: #000;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    transition: background 0.2s ease;
}

.shinoa-history-popup-copy:hover {
    background: #3abbd1;
}

.shinoa-history-popup-copy:active {
    transform: scale(0.95);
}

.shinoa-ip-log-btn {
    padding: 4px 12px;
    background: #fff;
    color: #000;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    transition: background 0.2s ease;
    display: inline-block;
}

.shinoa-ip-log-btn:hover {
    background: #3abbd1;
}

.shinoa-ip-log-btn:disabled {
    background: #666;
    color: #aaa;
    cursor: not-allowed;
}

.shinoa-iplog-popup {
    position: fixed;
    background: #1c1f23;
    border: 1px solid #fff;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    z-index: 10000;
    font-size: 14px;
    min-width: min(700px, calc(100vw - 24px));
    max-width: min(900px, calc(100vw - 24px));
    max-height: min(600px, calc(100vh - 24px));
    display: flex;
    flex-direction: column;
}

.shinoa-iplog-popup--split {
    flex-direction: row;
    align-items: stretch;
    --shinoa-iplog-panel-w: clamp(520px, calc((100vw - 26px) / 2), 900px);
    width: min(calc(var(--shinoa-iplog-panel-w) * 2 + 1px), calc(100vw - 24px));
    max-width: calc(100vw - 24px);
}

.shinoa-iplog-main {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    align-self: stretch;
    min-height: 0;
}

.shinoa-iplog-popup--split .shinoa-iplog-main {
    flex: 0 0 auto;
    width: var(--shinoa-iplog-panel-w);
}

.shinoa-iplog-compare-container {
    flex: 1 1 auto;
    min-width: 320px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-left: 1px solid #333;
    min-height: 0;
    overflow: auto;
}

.shinoa-iplog-popup--split .shinoa-iplog-compare-container {
    flex: 0 0 auto;
    width: var(--shinoa-iplog-panel-w);
    min-width: var(--shinoa-iplog-panel-w);
}

.shinoa-iplog-compare-windows {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 10px;
    padding: 0 10px 10px 10px;
    overflow: auto;
    min-height: 0;
}

.shinoa-iplog-compare-window {
    border: 1px solid #333;
    border-radius: 6px;
    background: rgba(28, 31, 35, 0.9);
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.shinoa-iplog-compare-window[data-has-matches="1"] {
    border-color: rgba(58, 187, 209, 0.9);
}

.shinoa-iplog-compare-window-header {
    padding: 10px 10px;
    background: rgba(44, 47, 51, 0.8);
    border-bottom: 1px solid #333;
    border-radius: 6px 6px 0 0;
    font-weight: 600;
    font-size: 14px;
    color: #fff;
    display: flex;
    align-items: center;
    gap: 8px;
}

.shinoa-iplog-compare-window-controls {
    padding: 8px 10px;
    border-bottom: 1px solid #333;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.shinoa-iplog-compare-window-controls .shinoa-iplog-compare-name {
    width: 260px;
}

.shinoa-iplog-compare-window-controls .shinoa-iplog-compare-server {
    width: 90px;
}

.shinoa-iplog-compare-window-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.shinoa-iplog-compare-geo-status {
    font-weight: 500;
    font-size: 12px;
    color: rgba(236, 241, 249, 0.7);
    white-space: nowrap;
}

.shinoa-iplog-table-container--compare-window {
    padding: 8px;
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
}

.shinoa-iplog-popup-header {
    padding: 12px 16px;
    background: #2c2f33;
    border-bottom: 1px solid #444;
    border-radius: 6px 6px 0 0;
    font-weight: 600;
    font-size: 16px;
    color: #fff;
    display: flex;
    align-items: center;
    gap: 10px;
}

.shinoa-iplog-geo-status {
    font-weight: 500;
    font-size: 12px;
    color: rgba(236, 241, 249, 0.7);
    white-space: nowrap;
}

.shinoa-iplog-geo--missing {
    border-bottom: 1px dashed rgba(236, 241, 249, 0.5);
    cursor: help;
}

.shinoa-iplog-export-btn {
    padding: 4px 10px;
    background: transparent;
    border: 1px solid #444;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    transition: all 0.2s ease;
    white-space: nowrap;
    flex: 0 0 auto;
}

.shinoa-iplog-export-btn:hover {
    background: #3abbd1;
    border-color: #3abbd1;
}

.shinoa-iplog-export-btn:disabled {
    opacity: 0.7;
    cursor: not-allowed;
}

.shinoa-iplog-compare-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: 1px solid #444;
    border-radius: 50%;
    cursor: pointer;
    font-size: 18px;
    font-weight: 700;
    line-height: 1;
    color: #fff;
    transition: all 0.2s ease;
    flex: 0 0 auto;
}

.shinoa-iplog-compare-btn--attention {
    background: linear-gradient(120deg, rgba(58, 187, 209, 0.35), rgba(255, 204, 0, 0.75), rgba(58, 187, 209, 0.35));
    border-color: rgba(255, 204, 0, 0.7);
    box-shadow: 0 0 0 0 rgba(255, 204, 0, 0.5);
    background-size: 200% 200%;
    animation: shinoa-iplog-compare-glow 2.8s ease-in-out infinite;
}

@keyframes shinoa-iplog-compare-glow {
    0% {
        background-position: 0% 50%;
        box-shadow: 0 0 0 0 rgba(255, 204, 0, 0.35);
    }
    50% {
        background-position: 100% 50%;
        box-shadow: 0 0 12px 2px rgba(255, 204, 0, 0.45);
    }
    100% {
        background-position: 0% 50%;
        box-shadow: 0 0 0 0 rgba(255, 204, 0, 0.35);
    }
}

@media (prefers-reduced-motion: reduce) {
    .shinoa-iplog-compare-btn--attention {
        animation: none;
    }
}

.shinoa-iplog-main .shinoa-iplog-compare-btn {
    position: absolute;
    right: 0;
    top: 50%;
    transform: translate(50%, -50%);
    background: #1c1f23;
    z-index: 2;
}

.shinoa-iplog-compare-btn:hover {
    background: #3abbd1;
    border-color: #3abbd1;
}

.shinoa-iplog-compare-panel {
    padding: 10px 16px 12px 16px;
    background: rgba(44, 47, 51, 0.65);
    border-bottom: 1px solid #333;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 240px;
    overflow: auto;
}

.shinoa-iplog-compare-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.shinoa-iplog-compare-label {
    font-size: 12px;
    font-weight: 600;
    color: rgba(236, 241, 249, 0.85);
}

.shinoa-iplog-compare-input {
    height: 28px;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid #444;
    background: #1c1f23;
    color: #ecf1f9;
    outline: none;
    font-size: 14px;
}

.shinoa-iplog-compare-rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.shinoa-iplog-compare-player-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.shinoa-iplog-compare-player-row[data-has-matches="1"] .shinoa-iplog-compare-input {
    border-color: rgba(58, 187, 209, 0.9);
    box-shadow: 0 0 0 1px rgba(58, 187, 209, 0.35);
}

.shinoa-iplog-compare-name {
    width: 320px;
}

.shinoa-iplog-compare-server {
    width: 90px;
}

.shinoa-iplog-compare-select {
    height: 28px;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid #444;
    background: #1c1f23;
    color: #ecf1f9;
    outline: none;
    font-size: 14px;
}

.shinoa-iplog-compare-select:disabled {
    opacity: 0.7;
    cursor: not-allowed;
}

.shinoa-iplog-compare-run-btn {
    height: 28px;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid #444;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    transition: all 0.2s ease;
    white-space: nowrap;
}

.shinoa-iplog-compare-run-btn:hover {
    background: #3abbd1;
    border-color: #3abbd1;
}

.shinoa-iplog-compare-remove-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: 1px solid #444;
    border-radius: 4px;
    cursor: pointer;
    font-size: 18px;
    font-weight: 700;
    line-height: 1;
    color: #fff;
    transition: all 0.2s ease;
}

.shinoa-iplog-compare-remove-btn:hover {
    background: rgba(255, 68, 68, 0.18);
    border-color: #ff4444;
}

.shinoa-iplog-compare-remove-btn:disabled {
    opacity: 0.7;
    cursor: not-allowed;
}

.shinoa-iplog-compare-run-btn:disabled,
.shinoa-iplog-compare-input:disabled {
    opacity: 0.7;
    cursor: not-allowed;
}

.shinoa-iplog-compare-status {
    font-size: 13px;
    color: rgba(236, 241, 249, 0.75);
}

.shinoa-iplog-compare-status[data-type="loading"] {
    color: #ffcc00;
}

.shinoa-iplog-compare-status[data-type="error"] {
    color: #ff4444;
}

.shinoa-iplog-compare-status[data-type="ok"] {
    color: #00ff00;
}

.shinoa-iplog-compare-summary {
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    margin-bottom: 6px;
}

.shinoa-iplog-compare-details {
    border: 1px solid #333;
    border-radius: 6px;
    overflow: hidden;
}

.shinoa-iplog-compare-details-summary {
    cursor: pointer;
    user-select: none;
    padding: 8px 10px;
    background: rgba(28, 31, 35, 0.9);
    color: rgba(236, 241, 249, 0.95);
    font-size: 13px;
    font-weight: 600;
}

.shinoa-iplog-compare-details[open] .shinoa-iplog-compare-details-summary {
    border-bottom: 1px solid #333;
}

.shinoa-iplog-compare-empty {
    font-size: 13px;
    color: rgba(236, 241, 249, 0.75);
}

.shinoa-iplog-compare-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
}

.shinoa-iplog-compare-table th {
    padding: 8px 10px;
    text-align: left;
    font-weight: 600;
    color: #fff;
    border-bottom: 2px solid #444;
}

.shinoa-iplog-compare-table td {
    padding: 6px 10px;
    color: #ecf1f9;
    border-bottom: 1px solid #333;
}

.shinoa-iplog-compare-table .shinoa-iplog-ip {
    display: inline;
    font-family: monospace;
    font-weight: 600;
}

.shinoa-iplog-match {
    background: rgba(58, 187, 209, 0.12);
}

.shinoa-iplog-table-container {
    overflow-y: auto;
    max-height: 550px;
    padding: 8px;
    flex: 1 1 auto;
    min-height: 0;
}

.shinoa-iplog-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
}

.shinoa-iplog-table thead {
    position: sticky;
    top: 0;
    background: #2c2f33;
    z-index: 1;
}

.shinoa-iplog-table th {
    padding: 10px 12px;
    text-align: left;
    font-weight: 600;
    color: #fff;
    border-bottom: 2px solid #444;
}

.shinoa-iplog-table tbody tr {
    border-bottom: 1px solid #333;
}

.shinoa-iplog-table tbody tr:hover {
    background: #252830;
}

.shinoa-iplog-table td {
    padding: 8px 12px;
    color: #ecf1f9;
}

.shinoa-iplog-ip {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: monospace;
    font-weight: 600;
}

.shinoa-iplog-copy-btn {
    padding: 2px 6px;
    background: transparent;
    border: 1px solid #444;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s ease;
    color: #fff;
}

.shinoa-iplog-copy-btn:hover {
    background: #3abbd1;
    border-color: #3abbd1;
}

.shinoa-iplog-date {
    font-size: 12px;
    color: rgba(236, 241, 249, 0.8);
}

.shinoa-iplog-count {
    text-align: center;
    font-weight: 600;
    color: #3abbd1;
}
        `.trim();

        (document.head || document.documentElement).appendChild(style);
    }
})();

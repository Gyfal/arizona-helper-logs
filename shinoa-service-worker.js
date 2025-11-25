(function() {
    'use strict';

    const GEO_ENDPOINT = 'http://ip-api.com/batch';
    const GEO_FIELDS = 'status,message,country,countryCode,regionName,city,isp,org,as,lat,lon,query';
    const GEO_LANG = 'ru';

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) {
            return;
        }

        if (message.type === 'geo-lookup') {
            handleGeoLookup(message.ips ?? [])
                .then((data) => sendResponse({ ok: true, data }))
                .catch((error) => sendResponse({
                    ok: false,
                    error: error instanceof Error ? error.message : String(error)
                }));
            return true;
        }

        if (message.type === 'fetch-logs') {
            handleLogsFetch(message.url)
                .then((html) => sendResponse({ ok: true, html }))
                .catch((error) => sendResponse({
                    ok: false,
                    error: error instanceof Error ? error.message : String(error)
                }));
            return true;
        }

        if (message.type === 'save-html-debug') {
            handleSaveHtmlDebug(message.filename, message.html)
                .then(() => sendResponse({ ok: true }))
                .catch((error) => sendResponse({
                    ok: false,
                    error: error instanceof Error ? error.message : String(error)
                }));
            return true;
        }
    });

    async function handleGeoLookup(ips) {
        if (!Array.isArray(ips) || ips.length === 0) {
            return [];
        }

        const payload = ips.map((ip) => ({
            query: ip,
            fields: GEO_FIELDS,
            lang: GEO_LANG
        }));

        const response = await fetch(GEO_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`ip-api status ${response.status}`);
        }

        const data = await response.json();
        if (!Array.isArray(data)) {
            throw new Error('Unexpected ip-api payload');
        }

        return data;
    }

    async function handleLogsFetch(url) {
        if (!url) {
            throw new Error('URL is required');
        }

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const html = await response.text();

        // Отладка: проверяем, что получили
        console.log('[Service Worker] Fetched HTML length:', html.length);
        console.log('[Service Worker] Content-Type:', response.headers.get('content-type'));

        // Проверяем наличие data-ip в полученном HTML
        const dataIpCount = (html.match(/data-ip="/g) || []).length;
        console.log('[Service Worker] Found data-ip attributes:', dataIpCount);

        // Показываем первые 500 символов
        console.log('[Service Worker] HTML preview:', html.substring(0, 500));

        return html;
    }

    async function handleSaveHtmlDebug(filename, html) {
        if (!filename || !html) {
            throw new Error('Filename and HTML are required');
        }

        if (!chrome.downloads || typeof chrome.downloads.download !== 'function') {
            throw new Error('Downloads API is not available');
        }

        const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

        await new Promise((resolve, reject) => {
            chrome.downloads.download(
                {
                    url,
                    filename,
                    saveAs: false,
                    conflictAction: 'overwrite'
                },
                (downloadId) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }

                    if (typeof downloadId !== 'number') {
                        reject(new Error('Failed to create debug download'));
                        return;
                    }

                    resolve(downloadId);
                }
            );
        });
    }
})();

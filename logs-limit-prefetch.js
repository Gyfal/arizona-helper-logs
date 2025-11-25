(function() {
    'use strict';

    if (window.top !== window.self) {
        return;
    }
    if (/^\/admins\/?$/i.test(window.location.pathname)) {
        return;
    }

    const LOGS_LIMIT_STORAGE_KEY = 'logsPreferredLimit';
    const LOGS_LIMIT_DEFAULT = 100;
    const LOGS_LIMIT_ALLOWED = [100, 500, 1000];

    function parseLogsLimit(value) {
        if (value === null || value === undefined) {
            return null;
        }
        const num = Number(value);
        if (!Number.isFinite(num)) {
            return null;
        }
        return LOGS_LIMIT_ALLOWED.includes(num) ? num : null;
    }

    function readLimitFromLocalStorage() {
        try {
            return parseLogsLimit(localStorage.getItem(LOGS_LIMIT_STORAGE_KEY));
        } catch (_error) {
            return null;
        }
    }

    function redirectToPreferredLimit(limit) {
        const normalized = parseLogsLimit(limit);
        if (normalized === null || normalized <= LOGS_LIMIT_DEFAULT) {
            return false;
        }

        const currentUrl = new URL(window.location.href);
        const currentLimit = parseLogsLimit(currentUrl.searchParams.get('limit'));

        if (currentLimit !== null) {
            return false;
        }

        currentUrl.searchParams.set('limit', String(normalized));
        window.location.replace(currentUrl.toString());
        return true;
    }

    const urlLimit = parseLogsLimit(new URLSearchParams(window.location.search).get('limit'));
    if (urlLimit !== null) {
        return;
    }

    if (redirectToPreferredLimit(readLimitFromLocalStorage())) {
        return;
    }

    try {
        chrome?.storage?.local?.get?.({ [LOGS_LIMIT_STORAGE_KEY]: null }, (result) => {
            redirectToPreferredLimit(result?.[LOGS_LIMIT_STORAGE_KEY]);
        });
    } catch (_error) {
        // Ignore early lookup errors
    }
})();

(function() {
    'use strict';

    if (window.__shinoaHelperInterceptorInstalled) {
        return;
    }
    window.__shinoaHelperInterceptorInstalled = true;

    const TARGET_ENDPOINT = '/api/v1/player';
    const EVENT_NAME = 'shinoa-player-helper';
    const DEBUG_PREFIX = '[ShinoaHelper]';

    function emitPayload(payload) {
        try {
            window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: payload }));
        } catch (error) {
            console.error(DEBUG_PREFIX, 'Failed to dispatch payload', error);
        }
    }

    function isTarget(url) {
        if (!url) {
            return false;
        }

        try {
            return url.includes(TARGET_ENDPOINT);
        } catch (error) {
            console.error(DEBUG_PREFIX, 'Failed to inspect URL', error);
            return false;
        }
    }

    const nativeFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await nativeFetch.apply(this, args);

        try {
            const rawRequest = args[0];
            const requestUrl = typeof rawRequest === 'string'
                ? rawRequest
                : (rawRequest && typeof rawRequest.url === 'string' ? rawRequest.url : '');

            if (isTarget(requestUrl)) {
                const cloned = response.clone();
                cloned.json()
                    .then((payload) => emitPayload(payload))
                    .catch((error) => console.error(DEBUG_PREFIX, 'Failed to parse fetch JSON', error));
            }
        } catch (error) {
            console.error(DEBUG_PREFIX, 'Fetch interception error', error);
        }

        return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__shinoaHelperUrl = url;
        return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function(...sendArgs) {
        if (isTarget(this.__shinoaHelperUrl)) {
            this.addEventListener('load', function() {
                try {
                    const payload = JSON.parse(this.responseText);
                    emitPayload(payload);
                } catch (error) {
                    console.info(DEBUG_PREFIX, 'Failed to parse XHR JSON', error);
                }
            });
        }

        return originalSend.apply(this, sendArgs);
    };
})();


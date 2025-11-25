(() => {
    'use strict';

    const FORUM_BASE = 'https://forum.arizona-rp.com';
    const MAX_PAGES = 50;
    const MEDALS = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    const LOG_PREFIX = '[ForumReport]';
    const DEBUG_MAX_ENTRIES = 400;
    const FORUM_CONFIG_PATH = 'forum-config.json';
    const FORUM_CONFIG_STORAGE_KEY = 'forumConfig';
    const DEFAULT_FORUM_CONFIG_RAW = {
        serverTitle: 'Arizona Mobile 3',
        groups: [
            {
                key: 'sostNesost',
                title: 'Сост / Несост',
                forums: [
                    { id: 2389, title: 'Жалобы на игроков состоящих в гос.организациях' },
                    { id: 2388, title: 'Жалобы на игроков не сост. в организациях' }
                ]
            },
            {
                key: 'mafiasBands',
                title: 'Мафии / Банды',
                forums: [
                    { id: 2391, title: 'Жалобы на мафии' },
                    { id: 2392, title: 'Жалобы на бандитов' }
                ]
            },
            {
                key: 'slets',
                title: 'Слёты',
                forums: [
                    { id: 2395, title: 'Опровержения на слёты' }
                ]
            }
        ]
    };
    const DEFAULT_FORUM_CONFIG = normalizeForumConfig(DEFAULT_FORUM_CONFIG_RAW);
    const forumConfigState = {
        value: DEFAULT_FORUM_CONFIG,
        promise: null
    };

    function parseForumId(value) {
        const match = String(value || '').match(/\d+/);
        if (!match) return null;
        const parsed = Number(match[0]);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function isExtensionContextInvalidated(error) {
        const message = String(error?.message || error || '');
        return message.includes('Extension context invalidated');
    }

    function normalizeForumConfig(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const fallback = DEFAULT_FORUM_CONFIG_RAW;
        const serverTitle = typeof source.serverTitle === 'string' && source.serverTitle.trim()
            ? source.serverTitle.trim()
            : fallback.serverTitle;
        const groupsInput = Array.isArray(source.groups) && source.groups.length
            ? source.groups
            : fallback.groups;

        const groups = [];
        const forums = [];
        const seenForumIds = new Set();
        const seenGroupKeys = new Set();

        groupsInput.forEach((group) => {
            const key = String(group?.key || '').trim();
            if (!key || seenGroupKeys.has(key)) return;
            seenGroupKeys.add(key);

            const title = String(group?.title || '').trim() || key;
            const groupForums = [];
            const forumIds = [];
            const forumsInput = Array.isArray(group?.forums) ? group.forums : [];

            forumsInput.forEach((forum) => {
                const id = parseForumId(forum?.id);
                if (!id || forumIds.includes(id)) return;
                const forumTitle = String(forum?.title || '').trim() || `Форум ${id}`;
                const entry = { id, title: forumTitle };
                forumIds.push(id);
                groupForums.push(entry);
                if (!seenForumIds.has(id)) {
                    seenForumIds.add(id);
                    forums.push(entry);
                }
            });

            groups.push({
                key,
                title,
                forums: groupForums,
                forumIds
            });
        });

        return { serverTitle, groups, forums };
    }

    function readForumConfigFromLocalStorage() {
        try {
            const raw = localStorage.getItem(FORUM_CONFIG_STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_error) {
            return null;
        }
    }

    function readForumConfigFromStorage() {
        if (!chrome?.storage?.local) {
            return Promise.resolve(readForumConfigFromLocalStorage());
        }
        return new Promise((resolve) => {
            try {
                chrome.storage.local.get({ [FORUM_CONFIG_STORAGE_KEY]: null }, (result) => {
                    resolve(result?.[FORUM_CONFIG_STORAGE_KEY] || readForumConfigFromLocalStorage());
                });
            } catch (_error) {
                resolve(readForumConfigFromLocalStorage());
            }
        });
    }

    function getForumConfig() {
        return forumConfigState.value;
    }

    async function loadForumConfig(options = {}) {
        const force = Boolean(options?.force);
        if (forumConfigState.promise && !force) {
            return forumConfigState.promise;
        }
        if (force) {
            forumConfigState.promise = null;
        }
        forumConfigState.promise = (async () => {
            try {
                const stored = await readForumConfigFromStorage();
                if (stored) {
                    forumConfigState.value = normalizeForumConfig(stored);
                    return forumConfigState.value;
                }
                if (!chrome?.runtime?.getURL) {
                    return forumConfigState.value;
                }
                let url = '';
                try {
                    url = chrome.runtime.getURL(FORUM_CONFIG_PATH);
                } catch (err) {
                    if (!isExtensionContextInvalidated(err)) {
                        console.warn('[ForumConfig]', err);
                    }
                    return forumConfigState.value;
                }
                const response = await fetch(url, { cache: 'no-cache' });
                if (!response.ok) {
                    throw new Error(`config http ${response.status}`);
                }
                const payload = await response.json();
                forumConfigState.value = normalizeForumConfig(payload);
            } catch (err) {
                if (!isExtensionContextInvalidated(err)) {
                    console.warn('[ForumConfig]', err);
                }
            }
            return forumConfigState.value;
        })();

        return forumConfigState.promise;
    }

    function normalizeNickKey(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function parseTimeMs(timeEl) {
        if (!timeEl) return null;
        const dataTime = timeEl.getAttribute('data-time');
        if (dataTime) {
            const parsed = Number(dataTime);
            if (Number.isFinite(parsed)) {
                return parsed * 1000;
            }
        }
        const dateTime = timeEl.getAttribute('datetime');
        if (dateTime) {
            const parsed = new Date(dateTime);
            if (!Number.isNaN(parsed.getTime())) {
                return parsed.getTime();
            }
        }
        return null;
    }

    function extractStartTimeMs(threadEl) {
        const selectors = [
            '.structItem-startDate time[data-time]',
            '.structItem-cell--main .structItem-startDate time[data-time]',
            '.structItem-cell--meta time[data-time]',
            '.structItem-cell--main time[data-time]'
        ];
        for (const selector of selectors) {
            const timeEl = threadEl.querySelector(selector);
            const ts = parseTimeMs(timeEl);
            if (ts) return ts;
        }
        return null;
    }

    function extractLastTimeMs(threadEl) {
        const selectors = [
            '.structItem-cell--latest time[data-time]',
            '.structItem-latestDate time[data-time]',
            '.structItem-cell--latest time',
            '.structItem-latestDate time'
        ];
        for (const selector of selectors) {
            const timeEl = threadEl.querySelector(selector);
            const ts = parseTimeMs(timeEl);
            if (ts) return ts;
        }
        return null;
    }

    function extractLastAuthor(threadEl) {
        const selectors = [
            '.structItem-cell--latest .structItem-latestMeta a.username',
            '.structItem-cell--latest .structItem-latestMeta a',
            '.structItem-latestMeta a.username',
            '.structItem-latestMeta a',
            '.structItem-cell--latest .username'
        ];
        for (const selector of selectors) {
            const el = threadEl.querySelector(selector);
            const name = String(el?.textContent || '').replace(/\s+/g, ' ').trim();
            if (name) return name;
        }
        return '';
    }

    function extractPrefixText(threadEl) {
        const el = threadEl.querySelector('.structItem-title .label, .structItem-title .label--prefix, .label--prefix');
        return String(el?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function extractThreadTitle(threadEl) {
        const link = threadEl.querySelector('.structItem-title a');
        return String(link?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function extractThreadUrl(threadEl, baseUrl) {
        const link = threadEl.querySelector('.structItem-title a');
        const href = link?.getAttribute('href');
        if (!href) return '';
        try {
            return new URL(href, baseUrl).toString();
        } catch (err) {
            return '';
        }
    }

    function hasLockedStatus(threadEl) {
        if (threadEl.classList.contains('structItem--locked')) return true;
        if (threadEl.querySelector('.structItem-status--locked, .structItem-status--closed')) return true;
        if (threadEl.querySelector('.structItem-icon--lock, .structItem-icon--locked')) return true;
        return false;
    }

    function hasStickyStatus(threadEl) {
        if (threadEl.classList.contains('structItem--sticky')) return true;
        if (threadEl.querySelector('.structItem-status--sticky')) return true;
        return false;
    }

    function extractThreads(doc) {
        const items = Array.from(doc.querySelectorAll('.structItem--thread, .structItem'));
        return items.filter((item) => item.querySelector('.structItem-title, .structItem-cell--main'));
    }

    function getNextPageUrl(doc, currentUrl) {
        const nextLink = doc.querySelector('a.pageNav-jump--next, a.pageNavSimple-el--next, a.pageNav-jump--next');
        const href = nextLink?.getAttribute('href');
        if (!href) return null;
        try {
            return new URL(href, currentUrl).toString();
        } catch (err) {
            return null;
        }
    }

    function isLoginPage(doc) {
        if (doc.querySelector('form[action*="login"]')) return true;
        if (doc.querySelector('input[name="login"]')) return true;
        if (doc.querySelector('.p-body-pageContent .blockMessage')) {
            const message = doc.querySelector('.p-body-pageContent .blockMessage')?.textContent || '';
            if (/login|войдите|авторизуйтесь/i.test(message)) return true;
        }
        return false;
    }

    function sendMessageAsync(message) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve(response);
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    async function fetchForumHtml(url) {
        if (chrome?.runtime?.sendMessage) {
            const response = await sendMessageAsync({ type: 'fetch-forum-html', url });
            if (response?.ok && response.html) {
                return response.html;
            }
            throw new Error(response?.error || 'forum fetch failed');
        }

        const response = await fetch(url, {
            credentials: 'include',
            cache: 'no-cache',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        if (!response.ok) {
            throw new Error(`forum http ${response.status}`);
        }
        return response.text();
    }

    function buildDisplayMap(displayByNick) {
        const map = new Map();
        if (!displayByNick) return map;
        displayByNick.forEach((value, key) => {
            const nickname = typeof value === 'string' ? value : value?.nickname;
            if (nickname) {
                map.set(String(key), nickname);
            }
        });
        return map;
    }

    function incrementCount(counts, nickKey, displayName) {
        const entry = counts.get(nickKey);
        if (entry) {
            entry.count += 1;
            if (!entry.display && displayName) {
                entry.display = displayName;
            }
            return;
        }
        counts.set(nickKey, { count: 1, display: displayName || nickKey });
    }

    function formatTopWithTies(counts, displayByNick) {
        const displayMap = buildDisplayMap(displayByNick);
        const entries = Array.from(counts.entries())
            .map(([key, data]) => ({
                key,
                count: data.count,
                display: displayMap.get(key) || data.display || key
            }))
            .sort((a, b) => {
                if (b.count !== a.count) return b.count - a.count;
                return a.display.localeCompare(b.display);
            });

        if (!entries.length) {
            return MEDALS.map((medal) => `${medal}None`);
        }

        const lines = [];
        const uniqueCounts = [];
        for (const entry of entries) {
            if (!uniqueCounts.includes(entry.count)) {
                uniqueCounts.push(entry.count);
            }
        }

        const maxRanks = Math.min(uniqueCounts.length, MEDALS.length);
        for (let i = 0; i < maxRanks; i += 1) {
            const medal = MEDALS[i];
            const count = uniqueCounts[i];
            entries
                .filter((entry) => entry.count === count)
                .forEach((entry) => {
                    lines.push(`${medal}${entry.display} ${entry.count}`);
                });
        }

        for (let i = maxRanks; i < MEDALS.length; i += 1) {
            lines.push(`${MEDALS[i]}None`);
        }

        return lines;
    }

    async function scanForum(forumId, bounds, adminSet, countsCreated, countsLast, stats, debugState) {
        let pageUrl = `${FORUM_BASE}/forums/${forumId}/`;
        let pagesScanned = 0;
        const visited = new Set();
        const parser = new DOMParser();
        let totalThreads = 0;
        let matchedCreatedTotal = 0;
        let matchedLastTotal = 0;

        console.log(LOG_PREFIX, `Start forum ${forumId}`);

        while (pageUrl && pagesScanned < MAX_PAGES) {
            if (visited.has(pageUrl)) break;
            visited.add(pageUrl);

            pagesScanned += 1;
            console.log(LOG_PREFIX, `Forum ${forumId} page ${pagesScanned}: ${pageUrl}`);

            const html = await fetchForumHtml(pageUrl);
            const doc = parser.parseFromString(html, 'text/html');
            if (isLoginPage(doc)) {
                console.error(LOG_PREFIX, `Forum ${forumId}: not authorized`);
                throw new Error('not authorized');
            }

            const threads = extractThreads(doc);
            if (!threads.length) {
                console.log(LOG_PREFIX, `Forum ${forumId} page ${pagesScanned}: no threads`);
                break;
            }

            totalThreads += threads.length;
            if (stats) {
                stats.pages = pagesScanned;
                stats.threads += threads.length;
            }

            let maxLastPostMs = 0;
            let matchedCreatedOnPage = 0;
            let matchedLastOnPage = 0;
            threads.forEach((thread) => {
                const startTimeMs = extractStartTimeMs(thread);
                const lastAuthor = extractLastAuthor(thread);
                const lastTimeMs = extractLastTimeMs(thread);
                const threadTitle = extractThreadTitle(thread);
                const threadUrl = extractThreadUrl(thread, pageUrl);
                const locked = hasLockedStatus(thread);
                const sticky = hasStickyStatus(thread);
                const prefixText = extractPrefixText(thread);
                const prefixLower = prefixText.toLowerCase().replace(/\s+/g, ' ').trim();

                if (lastTimeMs && lastTimeMs > maxLastPostMs) {
                    maxLastPostMs = lastTimeMs;
                }

                const key = normalizeNickKey(lastAuthor);
                const passesAdminFilter = !adminSet || (key && adminSet.has(key));
                const createdInPeriod = Boolean(startTimeMs && startTimeMs >= bounds.startMs && startTimeMs <= bounds.endMs);
                const lastInPeriod = Boolean(lastTimeMs && lastTimeMs >= bounds.startMs && lastTimeMs <= bounds.endMs);

                if (createdInPeriod && passesAdminFilter && key) {
                    incrementCount(countsCreated, key, lastAuthor);
                    matchedCreatedOnPage += 1;
                }

                if (lastInPeriod && passesAdminFilter && key) {
                    incrementCount(countsLast, key, lastAuthor);
                    matchedLastOnPage += 1;
                }

                if (stats && lastInPeriod) {
                    const isUnpinned = prefixLower.includes('не закреп');
                    const isPinned = !isUnpinned && prefixLower.includes('закреп');
                    const isOnReview = /на\s+рассмотр/i.test(prefixLower);

                    if (isOnReview && !locked) stats.onReview += 1;
                    if (isPinned || sticky) stats.pinned += 1;
                    if (isUnpinned) stats.unpinned += 1;

                    if (locked) {
                        stats.closed += 1;
                        if (key) {
                            const closerEntry = stats.closers.get(key);
                            if (closerEntry) {
                                closerEntry.count += 1;
                                if (!closerEntry.display && lastAuthor) {
                                    closerEntry.display = lastAuthor;
                                }
                            } else {
                                stats.closers.set(key, { count: 1, display: lastAuthor || key });
                            }
                        }

                        if (startTimeMs && lastTimeMs && lastTimeMs >= startTimeMs) {
                            stats.closeDurations.push(lastTimeMs - startTimeMs);
                        }
                    } else {
                        stats.open += 1;
                    }
                }

                if (debugState?.enabled && debugState.entries.length < DEBUG_MAX_ENTRIES) {
                    debugState.entries.push({
                        forumId,
                        page: pagesScanned,
                        title: threadTitle || '(без названия)',
                        url: threadUrl,
                        author: lastAuthor,
                        created: startTimeMs ? new Date(startTimeMs).toISOString() : null,
                        lastPost: lastTimeMs ? new Date(lastTimeMs).toISOString() : null,
                        locked,
                        sticky,
                        prefix: prefixText,
                        createdInPeriod,
                        lastInPeriod,
                        passedFilter: passesAdminFilter
                    });
                }
            });

            matchedCreatedTotal += matchedCreatedOnPage;
            matchedLastTotal += matchedLastOnPage;
            console.log(
                LOG_PREFIX,
                `Forum ${forumId} page ${pagesScanned}: threads ${threads.length}, created ${matchedCreatedOnPage}, last ${matchedLastOnPage}`
            );

            if (maxLastPostMs && maxLastPostMs < bounds.startMs) {
                console.log(LOG_PREFIX, `Forum ${forumId} stop: last post older than period start`);
                break;
            }

            pageUrl = getNextPageUrl(doc, pageUrl);
            if (!pageUrl) {
                console.log(LOG_PREFIX, `Forum ${forumId}: no next page`);
            }
        }

        if (pagesScanned >= MAX_PAGES) {
            console.log(LOG_PREFIX, `Forum ${forumId}: reached max pages (${MAX_PAGES})`);
        }

        console.log(
            LOG_PREFIX,
            `Done forum ${forumId}: pages ${pagesScanned}, threads ${totalThreads}, created ${matchedCreatedTotal}, last ${matchedLastTotal}`
        );
    }

    async function loadComplaintsSummary(options) {
        const period = options?.period;
        if (!period?.start || !period?.end) {
            return { ok: false, error: 'period required' };
        }
        const adminSet = options?.adminSet instanceof Set ? options.adminSet : null;
        const displayByNick = options?.displayByNick instanceof Map ? options.displayByNick : null;
        const debugState = {
            enabled: Boolean(options?.debug),
            entries: []
        };

        const forumConfig = await loadForumConfig({ force: true });
        const groups = Array.isArray(forumConfig?.groups) ? forumConfig.groups : [];

        const startMs = new Date(
            period.start.getFullYear(),
            period.start.getMonth(),
            period.start.getDate(),
            0,
            0,
            0,
            0
        ).getTime();
        const endMs = new Date(
            period.end.getFullYear(),
            period.end.getMonth(),
            period.end.getDate(),
            23,
            59,
            59,
            999
        ).getTime();

        const bounds = { startMs, endMs };
        const groupCountsCreated = {};
        const groupCountsLast = {};
        const statsByForum = {};

        groups.forEach((group) => {
            if (!group?.key) return;
            groupCountsCreated[group.key] = new Map();
            groupCountsLast[group.key] = new Map();
        });

        console.log(
            LOG_PREFIX,
            `Period ${new Date(startMs).toISOString().slice(0, 10)}..${new Date(endMs).toISOString().slice(0, 10)}`
        );

        for (const group of groups) {
            const groupKey = group?.key;
            if (!groupKey) continue;
            const ids = Array.isArray(group?.forumIds) ? group.forumIds : [];
            for (const forumId of ids) {
                const stats = {
                    forumId,
                    pages: 0,
                    threads: 0,
                    onReview: 0,
                    pinned: 0,
                    unpinned: 0,
                    closed: 0,
                    open: 0,
                    closeDurations: [],
                    closers: new Map()
                };
                await scanForum(
                    forumId,
                    bounds,
                    adminSet,
                    groupCountsCreated[groupKey],
                    groupCountsLast[groupKey],
                    stats,
                    debugState
                );

                if (stats.closeDurations.length) {
                    const total = stats.closeDurations.reduce((sum, value) => sum + value, 0);
                    stats.avgCloseSeconds = Math.round(total / stats.closeDurations.length / 1000);
                } else {
                    stats.avgCloseSeconds = 0;
                }

                stats.closeDurations = [];
                stats.closers = Array.from(stats.closers.entries()).map(([key, value]) => ({
                    key,
                    name: value.display || key,
                    count: value.count
                }));
                statsByForum[String(forumId)] = stats;
            }

            const createdTotal = Array.from(groupCountsCreated[groupKey].values()).reduce(
                (sum, entry) => sum + (entry?.count || 0),
                0
            );
            const lastTotal = Array.from(groupCountsLast[groupKey].values()).reduce(
                (sum, entry) => sum + (entry?.count || 0),
                0
            );
            console.log(
                LOG_PREFIX,
                `Group ${groupKey}: created ${createdTotal}, last ${lastTotal}, admins ${groupCountsCreated[groupKey].size}`
            );
        }

        if (debugState.enabled && debugState.entries.length) {
            console.log(LOG_PREFIX, `Debug entries: ${debugState.entries.length}`);
            console.table(debugState.entries);
        }

        const groupsCreated = {};
        const groupsLast = {};
        groups.forEach((group) => {
            const key = group?.key;
            if (!key) return;
            groupsCreated[key] = formatTopWithTies(groupCountsCreated[key] || new Map(), displayByNick);
            groupsLast[key] = formatTopWithTies(groupCountsLast[key] || new Map(), displayByNick);
        });

        return {
            ok: true,
            groupsCreated,
            groupsLast,
            statsByForum: statsByForum
        };
    }

    window.ArizonaForumReport = {
        loadComplaintsSummary
    };
})();

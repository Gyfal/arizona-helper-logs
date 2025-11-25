(() => {
    'use strict';

    if (!/^\/admins\/?$/.test(window.location.pathname)) {
        return;
    }

    const REPORT_BUTTON_ID = 'adminsWeeklyReportBtn';
    const REPORT_OVERLAY_ID = 'adminsWeeklyReportOverlay';
    const MAX_INCLUDED_LEVEL = 4;
    const MIN_ONLINE_HOURS = 20;
    const LONG_ONLINE_HOURS = 30;
    const REWARD_REPORTS_STEP = 500;
    const REWARD_AMOUNT_PER_STEP = 190;
    const ADMIN_LIST_URL = 'https://admin.arztools.tech/api/user/adminlist.php';
    const ADMIN_INFO_URL = 'https://admin.arztools.tech/api/user/getInfo.php';
    const INACTIVES_URL = 'https://admin.arztools.tech/api/inactives/get_list.php';
    const INACTIVES_LIMIT = 100;
    const DAILY_NORM_HOURS = 3;
    const MONTH_SECONDS = 30 * 86400;
    const FORUM_CONFIG_PATH = 'forum-config.json';
    const FORUM_CONFIG_STORAGE_KEY = 'forumConfig';
    const FORUM_CONFIG_BUTTON_ID = 'adminsForumConfigBtn';
    const FORUM_CONFIG_OVERLAY_ID = 'adminsForumConfigOverlay';
    const DEFAULT_FORUM_CONFIG_RAW = {
        serverTitle: 'Arizona Mobile 3',
        showRewards: false,
        rewardReportsStep: REWARD_REPORTS_STEP,
        rewardAmountPerStep: REWARD_AMOUNT_PER_STEP,
        dailyNormHours: DAILY_NORM_HOURS,
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

    let adminListCache = null;
    let notesCache = new Map();
    let inactivesCache = null;
    let notesLoaded = false;
    let forumReportState = {
        key: null,
        status: 'idle',
        data: null,
        error: null,
        promise: null
    };
    let currentReportModal = null;
    let currentConfigModal = null;
    const NOTES_PREFIX = '[AdminNotes]';

    function runWhenReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    function normalizeHeaderText(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function findColumnIndex(headers, keywords) {
        for (let i = 0; i < headers.length; i++) {
            const headerText = headers[i];
            if (!headerText) continue;
            if (keywords.some((keyword) => headerText.includes(keyword))) {
                return i;
            }
        }
        return -1;
    }

    function parseInteger(value) {
        const match = String(value || '').match(/\d+/);
        return match ? Number(match[0]) : 0;
    }

    function parseOptionalInteger(value) {
        const match = String(value || '').match(/\d+/);
        return match ? Number(match[0]) : null;
    }

    function parseForumId(value) {
        const parsed = parseInteger(value);
        return parsed > 0 ? parsed : null;
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
        const showRewards = typeof source.showRewards === 'boolean'
            ? source.showRewards
            : Boolean(fallback.showRewards);
        const rewardReportsStep = parseOptionalInteger(source.rewardReportsStep)
            ?? parseOptionalInteger(fallback.rewardReportsStep)
            ?? REWARD_REPORTS_STEP;
        const rewardAmountPerStep = parseOptionalInteger(source.rewardAmountPerStep)
            ?? parseOptionalInteger(fallback.rewardAmountPerStep)
            ?? REWARD_AMOUNT_PER_STEP;
        const dailyNormHours = parseOptionalInteger(source.dailyNormHours)
            ?? parseOptionalInteger(fallback.dailyNormHours)
            ?? DAILY_NORM_HOURS;

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

        return {
            serverTitle,
            showRewards,
            rewardReportsStep,
            rewardAmountPerStep,
            dailyNormHours,
            groups,
            forums
        };
    }

    function readForumConfigFromLocalStorage() {
        try {
            const raw = localStorage.getItem(FORUM_CONFIG_STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_error) {
            return null;
        }
    }

    function writeForumConfigToLocalStorage(config) {
        try {
            localStorage.setItem(FORUM_CONFIG_STORAGE_KEY, JSON.stringify(config));
        } catch (_error) {
        }
    }

    function clearForumConfigLocalStorage() {
        try {
            localStorage.removeItem(FORUM_CONFIG_STORAGE_KEY);
        } catch (_error) {
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

    function saveForumConfigToStorage(config) {
        if (!config || typeof config !== 'object') {
            return Promise.resolve(false);
        }
        writeForumConfigToLocalStorage(config);
        if (!chrome?.storage?.local) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            try {
                chrome.storage.local.set({ [FORUM_CONFIG_STORAGE_KEY]: config }, () => {
                    if (chrome.runtime?.lastError) {
                        resolve(false);
                        return;
                    }
                    resolve(true);
                });
            } catch (_error) {
                resolve(false);
            }
        });
    }

    function clearForumConfigStorage() {
        clearForumConfigLocalStorage();
        if (!chrome?.storage?.local) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            try {
                chrome.storage.local.remove([FORUM_CONFIG_STORAGE_KEY], () => {
                    resolve(true);
                });
            } catch (_error) {
                resolve(false);
            }
        });
    }

    function getForumConfig() {
        return forumConfigState.value;
    }

    function getDailyNormHours() {
        const config = getForumConfig();
        const value = parseOptionalInteger(config?.dailyNormHours);
        return value && value > 0 ? value : DAILY_NORM_HOURS;
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

    function parseDurationToSeconds(value) {
        const raw = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!raw) return null;

        let total = 0;
        let matched = false;

        const monthMatch = raw.match(/(\d+)\s*(?:мес(?:яц|яца|яцев)?)/);
        if (monthMatch) {
            total += Number(monthMatch[1]) * MONTH_SECONDS;
            matched = true;
        }

        const weekMatch = raw.match(/(\d+)\s*(?:нед|неделя|недели|недель)/);
        if (weekMatch) {
            total += Number(weekMatch[1]) * 7 * 86400;
            matched = true;
        }

        const dayMatch = raw.match(/(\d+)\s*(?:д|дн|день|дней)/);
        if (dayMatch) {
            total += Number(dayMatch[1]) * 86400;
            matched = true;
        }

        const hourMatch = raw.match(/(\d+)\s*(?:ч|час|часов|часа)/);
        if (hourMatch) {
            total += Number(hourMatch[1]) * 3600;
            matched = true;
        }

        const minuteMatch = raw.match(/(\d+)\s*(?:м|мин|минут|минуты)/);
        if (minuteMatch) {
            total += Number(minuteMatch[1]) * 60;
            matched = true;
        }

        const secondMatch = raw.match(/(\d+)\s*(?:с|сек|секунд|секунды)/);
        if (secondMatch) {
            total += Number(secondMatch[1]);
            matched = true;
        }

        if (matched) return total;

        if (raw.includes(':')) {
            const parts = raw.split(':').map((part) => Number(part.trim()));
            if (parts.some((part) => Number.isNaN(part))) return null;
            if (parts.length === 4) {
                return parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
            }
            if (parts.length === 3) {
                return parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
            if (parts.length === 2) {
                return parts[0] * 3600 + parts[1] * 60;
            }
        }

        return null;
    }

    function formatHms(seconds) {
        const safeSeconds = Math.max(0, Math.floor(seconds || 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const secs = safeSeconds % 60;
        return `${hours} часов ${minutes} минут ${secs} секунд`;
    }

    function formatTotalHours(seconds) {
        const safeSeconds = Math.max(0, Math.floor(seconds || 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const secs = safeSeconds % 60;
        return `${hours}ч ${minutes}мин ${secs}сек`;
    }

    function formatHmsTotal(seconds) {
        const safeSeconds = Math.max(0, Math.floor(seconds || 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const secs = safeSeconds % 60;
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function formatAveragePerDay(seconds, days) {
        if (!Number.isFinite(seconds) || !Number.isFinite(days) || days <= 0) return '';
        const hoursPerDay = seconds / 3600 / days;
        if (!Number.isFinite(hoursPerDay)) return '';
        return `~${hoursPerDay.toFixed(1)} ч/д`;
    }

    function extractPeriodRange() {
        const infoRow = document.querySelector('.row.mb-3 .col-sm-3');
        if (infoRow) {
            const strongs = infoRow.querySelectorAll('strong');
            if (strongs.length >= 2) {
                const from = String(strongs[0].textContent || '').trim();
                const to = String(strongs[1].textContent || '').trim();
                return { from, to };
            }
            const text = infoRow.textContent || '';
            const matches = text.match(/\d{4}-\d{2}-\d{2}/g);
            if (matches && matches.length >= 2) {
                return { from: matches[0], to: matches[1] };
            }
        }

        const minInput = document.querySelector('input[name="min_period"]');
        const maxInput = document.querySelector('input[name="max_period"]');
        if (minInput?.value || maxInput?.value) {
            return { from: minInput.value, to: maxInput.value };
        }

        return null;
    }

    function formatDateShort(value) {
        const match = String(value || '').match(/(\d{4})-(\d{2})-(\d{2})/);
        if (!match) return '??.??';
        return `${match[3]}.${match[2]}`;
    }

    function formatLines(lines) {
        return lines.length ? lines.join('\n') : 'нет данных';
    }

    function normalizeNoteValue(value) {
        if (value === null || value === undefined) {
            return '';
        }
        const text = String(value).replace(/\s+/g, ' ').trim();
        if (!text) return '';
        const lower = text.toLowerCase();
        if (lower.startsWith('нет заметок') || lower.startsWith('нет данных')) {
            return '';
        }
        return text;
    }

    function formatNoteSuffix(entry, notesByNick) {
        if (!notesByNick) return '';
        const key = entry.nickname.toLowerCase();
        if (!notesByNick.has(key)) return '';
        const noteValue = normalizeNoteValue(notesByNick.get(key));
        if (!noteValue) return '';
        return ` | Заметки: ${noteValue}`;
    }

    function formatInactiveSuffix(inactiveDays) {
        if (!Number.isFinite(inactiveDays) || inactiveDays <= 0) {
            return '';
        }
        const hours = inactiveDays * getDailyNormHours();
        return ` | Неактив: ${inactiveDays} д. (${hours} ч.)`;
    }

    function getFilteredEntries(options = {}) {
        const resolvedOptions = options instanceof Set ? { allowedNicks: options } : options || {};
        const {
            allowedNicks = null,
            adminMetaByNick = null,
            includeMissing = false
        } = resolvedOptions;
        const table = document.querySelector('table.table');
        if (!table) {
            return { error: 'Таблица администраторов не найдена.', filteredEntries: [] };
        }

        const headerCells = Array.from(table.querySelectorAll('thead th'));
        const headers = headerCells.map((cell) => normalizeHeaderText(cell.textContent));
        const nicknameIndex = findColumnIndex(headers, ['???', 'nickname', '?????']);
        const levelIndex = findColumnIndex(headers, ['????', 'lvl', 'level']);
        const reportsIndex = findColumnIndex(headers, ['?????', '??????', 'report']);
        let onlineIndex = findColumnIndex(headers, ['??????', 'online', '?????']);
        if (onlineIndex < 0) {
            let lastIndex = headers.length - 1;
            while (lastIndex >= 0 && !headers[lastIndex]) {
                lastIndex -= 1;
            }
            onlineIndex = Math.max(0, lastIndex);
        }

        const fallbackNicknameIndex = nicknameIndex >= 0 ? nicknameIndex : 0;
        const fallbackLevelIndex = levelIndex >= 0 ? levelIndex : 2;
        const fallbackReportsIndex = reportsIndex >= 0 ? reportsIndex : Math.min(3, headers.length - 1);

        const rows = Array.from(table.querySelectorAll('tbody tr'));
        const entries = rows.map((row) => {
            const cells = row.querySelectorAll('td');
            if (!cells.length) return null;

            const nickname = String(cells[fallbackNicknameIndex]?.textContent || '').trim();
            if (!nickname) return null;

            const level = parseInteger(cells[fallbackLevelIndex]?.textContent);
            const reports = parseInteger(cells[fallbackReportsIndex]?.textContent);
            const onlineCell = cells[onlineIndex];
            const onlineText = String(onlineCell?.textContent || '').trim();
            let onlineSeconds = null;
            if (onlineCell?.dataset?.onlineSeconds !== undefined) {
                const parsedSeconds = Number(onlineCell.dataset.onlineSeconds);
                onlineSeconds = Number.isFinite(parsedSeconds) ? parsedSeconds : null;
            }
            if (onlineSeconds === null) {
                onlineSeconds = parseDurationToSeconds(onlineText);
            }

            return {
                nickname,
                level,
                reports,
                onlineSeconds
            };
        }).filter(Boolean);

        const eligibleEntries = entries.filter((entry) => entry.level > 0 && entry.level <= MAX_INCLUDED_LEVEL);
        let filteredEntries = allowedNicks
            ? eligibleEntries.filter((entry) => allowedNicks.has(entry.nickname.toLowerCase()))
            : eligibleEntries;

        if (includeMissing && allowedNicks) {
            const present = new Set(filteredEntries.map((entry) => entry.nickname.toLowerCase()));
            const missingEntries = [];

            allowedNicks.forEach((nick) => {
                if (present.has(nick)) return;

                const meta = adminMetaByNick?.get(nick);
                const level = Number.isFinite(meta?.level) ? meta.level : null;
                if (!Number.isFinite(level)) return;
                if (level <= 0 || level > MAX_INCLUDED_LEVEL) return;

                missingEntries.push({
                    nickname: meta?.nickname || nick,
                    level,
                    reports: 0,
                    onlineSeconds: 0
                });
            });

            if (missingEntries.length) {
                filteredEntries = filteredEntries.concat(missingEntries);
            }
        }

        return { error: null, filteredEntries };
    }

    function parseDateFromAny(value) {
        if (!value) return null;
        const isoMatch = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
        if (isoMatch) {
            const year = Number(isoMatch[1]);
            const month = Number(isoMatch[2]) - 1;
            const day = Number(isoMatch[3]);
            return new Date(year, month, day);
        }
        const ruMatch = String(value).match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (ruMatch) {
            const day = Number(ruMatch[1]);
            const month = Number(ruMatch[2]) - 1;
            const year = Number(ruMatch[3]);
            return new Date(year, month, day);
        }
        return null;
    }

    function getPeriodSummary() {
        const period = extractPeriodRange();
        if (!period) return null;
        const start = parseDateFromAny(period.from);
        const end = parseDateFromAny(period.to);
        if (!start || !end) return null;

        let periodStart = start;
        let periodEnd = end;
        if (periodEnd < periodStart) {
            [periodStart, periodEnd] = [periodEnd, periodStart];
        }

        const days = Math.floor((periodEnd - periodStart) / 86400000) + 1;
        return { start: periodStart, end: periodEnd, days };
    }

    function dateKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function getPeriodKey(periodSummary) {
        if (!periodSummary?.start || !periodSummary?.end) return null;
        return `${dateKey(periodSummary.start)}_${dateKey(periodSummary.end)}`;
    }

    function aggregateForumClosersByIds(forumIds, statsByForum) {
        const map = new Map();
        forumIds.forEach((forumId) => {
            const stats = statsByForum?.[String(forumId)];
            if (!stats?.closers) return;
            stats.closers.forEach((entry) => {
                const key = String(entry.key || entry.name || '').toLowerCase();
                if (!key) return;
                const existing = map.get(key);
                if (existing) {
                    existing.count += entry.count || 0;
                } else {
                    map.set(key, {
                        count: entry.count || 0,
                        name: entry.name || entry.key || key
                    });
                }
            });
        });
        return map;
    }

    function formatForumTopWithTies(countsMap) {
        const medals = ['🥇', '🥈', '🥉'];
        const entries = Array.from(countsMap.entries())
            .map(([key, value]) => ({
                key,
                name: value.name || key,
                count: value.count || 0
            }))
            .filter((entry) => entry.count > 0)
            .sort((a, b) => {
                if (b.count !== a.count) return b.count - a.count;
                return String(a.name || '').localeCompare(String(b.name || ''));
            });

        if (!entries.length) {
            return medals.map((medal) => `${medal}None`);
        }

        const lines = [];
        const uniqueCounts = [];
        for (const entry of entries) {
            if (!uniqueCounts.includes(entry.count)) {
                uniqueCounts.push(entry.count);
            }
        }

        const maxRanks = Math.min(uniqueCounts.length, medals.length);
        for (let i = 0; i < maxRanks; i += 1) {
            const medal = medals[i];
            const count = uniqueCounts[i];
            entries
                .filter((entry) => entry.count === count)
                .forEach((entry) => {
                    lines.push(`${medal}${entry.name} ${entry.count}`);
                });
        }

        for (let i = maxRanks; i < medals.length; i += 1) {
            lines.push(`${medals[i]}None`);
        }

        return lines;
    }

    function getForumSummaryLines() {
        const forumConfig = getForumConfig();
        const groups = Array.isArray(forumConfig?.groups) ? forumConfig.groups : [];
        const result = {};

        const fillGroups = (message) => {
            groups.forEach((group) => {
                if (!group?.key) return;
                result[group.key] = [message];
            });
            return result;
        };

        if (!groups.length) {
            return result;
        }

        if (forumReportState.status === 'error') {
            const message = forumReportState.error ? `ошибка форума: ${forumReportState.error}` : 'ошибка форума';
            return fillGroups(message);
        }
        if (forumReportState.status === 'loading') {
            return fillGroups('загрузка...');
        }
        if (forumReportState.status !== 'ready') {
            return fillGroups('??');
        }

        const statsByForum = forumReportState.data?.stats || {};
        groups.forEach((group) => {
            const ids = Array.isArray(group?.forumIds) ? group.forumIds : [];
            const counts = aggregateForumClosersByIds(ids, statsByForum);
            result[group.key] = formatForumTopWithTies(counts);
        });

        return result;
    }

    function formatDateTimeFull(date, endOfDay) {
        if (!date) return '????-??-?? ??:??:??';
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const time = endOfDay ? '23:59:59' : '00:00:00';
        return `${year}-${month}-${day} ${time}`;
    }

    function formatRankPrefix(index) {
        const labels = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
        return labels[index - 1] || `${index}.`;
    }

    function buildForumClosersLines(stats) {
        const entries = Array.isArray(stats?.closers) ? stats.closers.slice() : [];
        if (!entries.length) {
            return ['нет данных'];
        }

        const totalClosed = stats?.closed || 0;
        entries.sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return String(a.name || '').localeCompare(String(b.name || ''));
        });

        const limit = Math.min(entries.length, 10);
        const lines = [];
        for (let i = 0; i < limit; i += 1) {
            const entry = entries[i];
            const percent = totalClosed > 0 ? ((entry.count / totalClosed) * 100).toFixed(2) : '0.00';
            const name = entry.name || entry.key || 'Unknown';
            lines.push(`${formatRankPrefix(i + 1)} ${name} закрыл(-а) ${entry.count} жалоб [${percent}%]`);
        }

        return lines;
    }

    function buildForumStatsReport() {
        if (forumReportState.status === 'error') {
            return `ошибка форума: ${forumReportState.error || 'неизвестно'}`;
        }
        if (forumReportState.status === 'loading') {
            return 'загрузка...';
        }
        if (forumReportState.status !== 'ready') {
            return '??';
        }

        const statsByForum = forumReportState.data?.stats;
        if (!statsByForum) {
            return 'нет данных';
        }

        const periodSummary = getPeriodSummary();
        const rangeText = `${formatDateTimeFull(periodSummary?.start, false)} - ${formatDateTimeFull(periodSummary?.end, true)}`;
        const lines = [];
        const forumConfig = getForumConfig();
        const forums = Array.isArray(forumConfig?.forums) ? forumConfig.forums : [];
        const serverTitle = forumConfig?.serverTitle || 'Arizona Mobile';
        if (!forums.length) {
            return 'нет данных';
        }

        forums.forEach((forum, index) => {
            const stats = statsByForum[String(forum.id)];
            lines.push(`👻 Статистика за период ${rangeText} | ${serverTitle} | ${forum.title} 👻`);
            lines.push('');

            if (!stats) {
                lines.push('нет данных');
            } else {
                lines.push(`📁 На рассмотрении: ${stats.onReview}`);
                lines.push(`📌 Закреплено: ${stats.pinned}`);
                lines.push(`📌 Не закреплено: ${stats.unpinned}`);
                lines.push(`🔒 Закрыто: ${stats.closed}`);
                lines.push(`🔓 Открыто: ${stats.open}`);
                lines.push(`🔔 Среднее время закрытия: ${stats.closed ? formatHms(stats.avgCloseSeconds) : 'нет данных'}`);
                lines.push('');
                buildForumClosersLines(stats).forEach((line) => lines.push(line));
                lines.push('');
                lines.push(`📄 Страниц с жалобами: ${stats.pages}`);
            }

            if (index !== forums.length - 1) {
                lines.push('');
            }
        });

        return lines.join('\n');
    }

    async function loadForumReportForPeriod(periodSummary, modalRef) {
        const activeModal = modalRef || currentReportModal;
        const periodKey = getPeriodKey(periodSummary);
        if (!periodKey) {
            forumReportState = {
                key: null,
                status: 'error',
                data: null,
                error: 'период не найден',
                promise: null
            };
            console.error('[ForumReport] Period not found');
            if (activeModal?.headerStatus) {
                activeModal.headerStatus.textContent = 'Форум: период не найден';
            }
            if (activeModal?.reportTextarea) {
                activeModal.reportTextarea.value = buildReport({
                    allowedNicks: adminListCache?.allowedNicks,
                    adminMetaByNick: adminListCache?.metaByNick,
                    notesByNick: notesCache,
                    inactivesData: inactivesCache
                });
            }
            if (activeModal?.forumTextarea) {
                activeModal.forumTextarea.value = buildForumStatsReport();
            }
            return null;
        }

        if (forumReportState.key === periodKey) {
            if (forumReportState.status === 'ready') {
                return forumReportState.data;
            }
            if (forumReportState.status === 'loading') {
                return forumReportState.promise;
            }
        }

        forumReportState = {
            key: periodKey,
            status: 'loading',
            data: null,
            error: null,
            promise: null
        };

        if (activeModal?.headerStatus) {
            activeModal.headerStatus.textContent = 'Форум: загрузка...';
        }
        if (activeModal?.reportTextarea) {
            activeModal.reportTextarea.value = buildReport({
                allowedNicks: adminListCache?.allowedNicks,
                adminMetaByNick: adminListCache?.metaByNick,
                notesByNick: notesCache,
                inactivesData: inactivesCache
            });
        }
        if (activeModal?.forumTextarea) {
            activeModal.forumTextarea.value = buildForumStatsReport();
        }

        const loadPromise = (async () => {
            try {
                await loadForumConfig({ force: true });
                if (!window.ArizonaForumReport?.loadComplaintsSummary) {
                    throw new Error('модуль форума не найден');
                }

                const result = await window.ArizonaForumReport.loadComplaintsSummary({
                    period: { start: periodSummary.start, end: periodSummary.end },
                    debug: true
                });

                if (!result?.ok) {
                    throw new Error(result?.error || 'форум: ошибка данных');
                }

                forumReportState = {
                    key: periodKey,
                    status: 'ready',
                    data: {
                        created: result.groupsCreated,
                        last: result.groupsLast,
                        stats: result.statsByForum || {}
                    },
                    error: null,
                    promise: null
                };

                if (activeModal?.headerStatus) {
                    activeModal.headerStatus.textContent = 'Форум: готово';
                }
            } catch (err) {
                console.error('[ForumReport]', err);
                forumReportState = {
                    key: periodKey,
                    status: 'error',
                    data: null,
                    error: err instanceof Error ? err.message : String(err),
                    promise: null
                };

                if (activeModal?.headerStatus) {
                    activeModal.headerStatus.textContent = 'Форум: ошибка';
                }
            }

            if (activeModal?.reportTextarea && document.body.contains(activeModal.reportTextarea)) {
                const report = buildReport({
                    allowedNicks: adminListCache?.allowedNicks,
                    adminMetaByNick: adminListCache?.metaByNick,
                    notesByNick: notesCache,
                    inactivesData: inactivesCache
                });
                activeModal.reportTextarea.value = report;
            }
            if (activeModal?.forumTextarea && document.body.contains(activeModal.forumTextarea)) {
                activeModal.forumTextarea.value = buildForumStatsReport();
            }

            return forumReportState.data;
        })();

        forumReportState.promise = loadPromise;
        return loadPromise;
    }

    function stripHtml(text) {
        return String(text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }

    function getRequiredSeconds(baseRequiredSeconds, inactiveDays) {
        if (!Number.isFinite(baseRequiredSeconds)) return baseRequiredSeconds;
        const adjusted = baseRequiredSeconds - inactiveDays * getDailyNormHours() * 3600;
        return Math.max(0, adjusted);
    }

    function buildReport(options = {}) {
        const {
            allowedNicks = null,
            adminMetaByNick = null,
            notesByNick = null,
            inactivesData = null
        } = options;
        const { error, filteredEntries } = getFilteredEntries({
            allowedNicks,
            adminMetaByNick,
            includeMissing: true
        });
        if (error) {
            return error;
        }

        const periodSummary = getPeriodSummary();
        const baseRequiredSeconds = periodSummary
            ? periodSummary.days * getDailyNormHours() * 3600
            : MIN_ONLINE_HOURS * 3600;
        const inactivesByNick = inactivesData?.byNick || null;

        const shortOnline = filteredEntries
            .map((entry) => {
                const inactiveDays = inactivesByNick?.get(entry.nickname.toLowerCase())?.size ?? 0;
                const requiredSeconds = getRequiredSeconds(baseRequiredSeconds, inactiveDays);
                return { ...entry, requiredSeconds, inactiveDays };
            })
            .filter((entry) => entry.onlineSeconds !== null && entry.requiredSeconds > 0 && entry.onlineSeconds < entry.requiredSeconds)
            .sort((a, b) => a.onlineSeconds - b.onlineSeconds)
            .map((entry) => {
                const noteSuffix = formatNoteSuffix(entry, notesByNick);
                const inactiveSuffix = formatInactiveSuffix(entry.inactiveDays);
                return `${entry.nickname} - ${formatHms(entry.onlineSeconds)}${noteSuffix}${inactiveSuffix}`;
            });

        const topByLevel = new Map();
        filteredEntries
            .filter((entry) => entry.reports >= 100)
            .forEach((entry) => {
                if (!topByLevel.has(entry.level)) {
                    topByLevel.set(entry.level, []);
                }
                topByLevel.get(entry.level).push(entry);
            });

        const sortedLevels = Array.from(topByLevel.keys()).sort((a, b) => b - a);

        const topBlocks = sortedLevels.map((level) => {
            const admins = topByLevel.get(level) || [];
            admins.sort((a, b) => b.reports - a.reports);
            const lines = admins.slice(0, 3).map((entry) => `${entry.nickname} - ${entry.reports}`);
            return {
                level,
                lines,
                admins
            };
        });

        const forumConfig = getForumConfig();
        const rewardRecipients = [];
        if (forumConfig.showRewards) {
            const rewardStep = parseOptionalInteger(forumConfig.rewardReportsStep) ?? REWARD_REPORTS_STEP;
            const rewardAmount = parseOptionalInteger(forumConfig.rewardAmountPerStep) ?? REWARD_AMOUNT_PER_STEP;
            topBlocks.forEach((block) => {
                if (!block.admins.length) return;
                const topAdmin = block.admins[0];
                const rewardSteps = Math.floor(topAdmin.reports / rewardStep);
                const reward = rewardSteps * rewardAmount;
                if (reward > 0) {
                    rewardRecipients.push({
                        nickname: topAdmin.nickname,
                        reward
                    });
                }
            });
        }

        const longOnline = filteredEntries
            .filter((entry) => entry.onlineSeconds !== null && entry.onlineSeconds >= LONG_ONLINE_HOURS * 3600)
            .sort((a, b) => b.onlineSeconds - a.onlineSeconds)
            .map((entry) => `${entry.nickname} - ${formatTotalHours(entry.onlineSeconds)}`);

        const period = extractPeriodRange();
        const periodText = period
            ? `${formatDateShort(period.from)} по ${formatDateShort(period.to)}`
            : '??.?? по ??.??';

        const reportLines = [];
        reportLines.push(`# :date: Итоги недели в период с ${periodText}`);
        reportLines.push('');
        reportLines.push('### :warning: Преды за отсутствие нормы онлайна:');
        reportLines.push('```css');
        reportLines.push(formatLines(shortOnline));
        reportLines.push('```');
        reportLines.push('');
        reportLines.push('## :small_blue_diamond: Топ администраторов недели по ответам');

        if (topBlocks.length === 0) {
            reportLines.push('- ***Нет данных***');
        } else {
            topBlocks.forEach((block) => {
                reportLines.push(`- ***${block.level}** LVL*`);
                reportLines.push('```cs');
                reportLines.push(formatLines(block.lines));
                reportLines.push('```');
            });
        }

        reportLines.push('');
        reportLines.push('## :clock3: Администраторы с онлайном 30+ часов');
        reportLines.push('```css');
        reportLines.push(formatLines(longOnline));
        reportLines.push('```');
        reportLines.push('');
        reportLines.push('## :small_orange_diamond: Итоги недели по жалобам');
        const forumGroups = getForumSummaryLines();
        if (!forumConfig.groups.length) {
            reportLines.push('```cs');
            reportLines.push('нет данных');
            reportLines.push('```');
        } else {
            forumConfig.groups.forEach((group) => {
                const title = group?.title || group?.key || 'Группа';
                reportLines.push(`- ***${title}***`);
                reportLines.push('```cs');
                reportLines.push(formatLines(forumGroups[group.key] || []));
                reportLines.push('```');
            });
        }
        if (forumConfig.showRewards) {
            reportLines.push('Денежное вознаграждение получают:');
            if (rewardRecipients.length) {
                rewardRecipients.forEach((entry) => {
                    reportLines.push(`${entry.nickname} - ${entry.reward} рублей 💸`);
                });
            } else {
                reportLines.push('нет данных');
            }
        }
        reportLines.push('-# @everyone');

        return reportLines.join('\n');
    }

    function ensureReportStyles() {
        const styleId = 'adminsWeeklyReportStyles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            #${REPORT_OVERLAY_ID} {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.55);
                z-index: 10001;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .admins-weekly-report-modal {
                width: min(1380px, 96vw);
                max-height: 92vh;
                background: #1c1f23;
                border: 1px solid #3a3f45;
                border-radius: 10px;
                box-shadow: 0 16px 36px rgba(0, 0, 0, 0.55);
                display: flex;
                flex-direction: column;
            }
            .admins-weekly-report-header {
                padding: 16px 20px;
                font-weight: 600;
                font-size: 15px;
                color: #ffffff;
                border-bottom: 1px solid #2a2f35;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
            }
            .admins-weekly-report-body {
                padding: 16px 20px;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .admins-weekly-report-tabs {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
            }
            .admins-weekly-report-tab {
                padding: 6px 12px;
                border-radius: 6px;
                border: 1px solid #3a3f45;
                background: #2a2f35;
                color: #ffffff;
                cursor: pointer;
                font-weight: 600;
                font-size: 12px;
            }
            .admins-weekly-report-tab.active {
                background: #4dd0e1;
                color: #111;
                border-color: transparent;
            }
            .admins-weekly-report-textarea {
                width: 100%;
                min-height: 420px;
                max-height: 68vh;
                resize: vertical;
                background: #121212;
                color: #f5f5f5;
                border: 1px solid #3a3f45;
                border-radius: 6px;
                padding: 12px;
                font-family: "Consolas", "Courier New", monospace;
                font-size: 13px;
                line-height: 1.45;
            }
            .admins-weekly-report-actions {
                display: flex;
                gap: 10px;
                justify-content: flex-end;
                padding: 0 20px 16px;
            }
            .admins-weekly-report-status {
                font-size: 12px;
                color: rgba(236, 241, 249, 0.7);
            }
            .admins-weekly-report-status.notes-loaded {
                color: #7bd88f;
            }
            .admins-weekly-report-btn {
                padding: 8px 16px;
                border-radius: 6px;
                border: none;
                cursor: pointer;
                font-weight: 600;
                font-size: 13px;
            }
            .admins-weekly-report-btn.copy {
                background: #4dd0e1;
                color: #111;
            }
            .admins-weekly-report-btn.sync {
                background: #ffc107;
                color: #111;
            }
            .admins-weekly-report-btn.notes {
                background: #6c757d;
                color: #fff;
            }
            .admins-weekly-report-btn.notes.loaded {
                background: #28a745;
                color: #fff;
            }
            .admins-weekly-report-btn.forum {
                background: #17a2b8;
                color: #111;
            }
            .admins-weekly-report-btn.inactives {
                background: #495057;
                color: #fff;
            }
            .admins-weekly-report-btn.close {
                background: #2a2f35;
                color: #fff;
            }
            .admins-report-actions {
                margin-top: 10px;
                display: flex;
                flex-direction: column;
                gap: 8px;
                width: 100%;
                max-width: 320px;
            }
            .admins-report-action-btn {
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
                transition: transform 0.08s ease, box-shadow 0.08s ease;
            }
            .admins-report-action-btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 12px rgba(0, 0, 0, 0.25);
            }
        `;
        document.head.appendChild(style);
    }

    function showReportModal(reportText) {
        ensureReportStyles();

        const existing = document.getElementById(REPORT_OVERLAY_ID);
        if (existing) {
            const reportArea = existing.querySelector('textarea[data-tab="report"]');
            if (reportArea) {
                reportArea.value = reportText;
            }
            const forumArea = existing.querySelector('textarea[data-tab="forum"]');
            if (forumArea) {
                forumArea.value = buildForumStatsReport();
            }
            return currentReportModal;
        }

        const overlay = document.createElement('div');
        overlay.id = REPORT_OVERLAY_ID;

        const modal = document.createElement('div');
        modal.className = 'admins-weekly-report-modal';

        const header = document.createElement('div');
        header.className = 'admins-weekly-report-header';

        const headerTitle = document.createElement('span');
        headerTitle.textContent = 'Отчет по администраторам';

        const headerStatus = document.createElement('span');
        headerStatus.className = 'admins-weekly-report-status';
        headerStatus.textContent = 'Без синхронизации';

        header.appendChild(headerTitle);
        header.appendChild(headerStatus);

        const body = document.createElement('div');
        body.className = 'admins-weekly-report-body';

        const tabs = document.createElement('div');
        tabs.className = 'admins-weekly-report-tabs';

        const reportTab = document.createElement('button');
        reportTab.type = 'button';
        reportTab.className = 'admins-weekly-report-tab active';
        reportTab.textContent = 'Отчет';

        const forumTab = document.createElement('button');
        forumTab.type = 'button';
        forumTab.className = 'admins-weekly-report-tab';
        forumTab.textContent = 'Форум статистика';

        const reportTextarea = document.createElement('textarea');
        reportTextarea.className = 'admins-weekly-report-textarea';
        reportTextarea.dataset.tab = 'report';
        reportTextarea.value = reportText;

        const forumTextarea = document.createElement('textarea');
        forumTextarea.className = 'admins-weekly-report-textarea';
        forumTextarea.dataset.tab = 'forum';
        forumTextarea.value = buildForumStatsReport();
        forumTextarea.style.display = 'none';

        const actions = document.createElement('div');
        actions.className = 'admins-weekly-report-actions';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'admins-weekly-report-btn copy';
        copyBtn.textContent = 'Скопировать';

        const syncBtn = document.createElement('button');
        syncBtn.type = 'button';
        syncBtn.className = 'admins-weekly-report-btn sync';
        syncBtn.textContent = 'Синхр. админов';

        const notesBtn = document.createElement('button');
        notesBtn.type = 'button';
        notesBtn.className = 'admins-weekly-report-btn notes';
        notesBtn.textContent = 'Заметки';

        const forumBtn = document.createElement('button');
        forumBtn.type = 'button';
        forumBtn.className = 'admins-weekly-report-btn forum';
        forumBtn.textContent = 'Синхр. форум';

        const inactivesBtn = document.createElement('button');
        inactivesBtn.type = 'button';
        inactivesBtn.className = 'admins-weekly-report-btn inactives';
        inactivesBtn.textContent = 'Неактивы';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'admins-weekly-report-btn close';
        closeBtn.textContent = 'Закрыть';

        let activeTextarea = reportTextarea;
        function setActiveTab(tabKey) {
            const isReport = tabKey === 'report';
            activeTextarea = isReport ? reportTextarea : forumTextarea;
            reportTab.classList.toggle('active', isReport);
            forumTab.classList.toggle('active', !isReport);
            reportTextarea.style.display = isReport ? 'block' : 'none';
            forumTextarea.style.display = isReport ? 'none' : 'block';
            activeTextarea.focus();
            activeTextarea.select();
        }

        reportTab.addEventListener('click', () => setActiveTab('report'));
        forumTab.addEventListener('click', () => setActiveTab('forum'));

        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(activeTextarea.value);
                copyBtn.textContent = 'Скопировано!';
                setTimeout(() => {
                    copyBtn.textContent = 'Скопировать';
                }, 1200);
            } catch (err) {
                activeTextarea.select();
                document.execCommand('copy');
                copyBtn.textContent = 'Скопировано!';
                setTimeout(() => {
                    copyBtn.textContent = 'Скопировать';
                }, 1200);
            }
        });

        syncBtn.addEventListener('click', async () => {
            syncBtn.disabled = true;
            syncBtn.textContent = 'Синхронизация...';
            headerStatus.textContent = 'Синхронизация...';

            try {
                const admins = await fetchAdminList();
                adminListCache = admins;
                const report = buildReport({
                    allowedNicks: adminListCache?.allowedNicks,
                    adminMetaByNick: adminListCache?.metaByNick,
                    notesByNick: notesCache,
                    inactivesData: inactivesCache
                });
                reportTextarea.value = report;
                headerStatus.textContent = `Синхр.: ${adminListCache?.allowedNicks?.size ?? 0}`;
            } catch (err) {
                console.error(err);
                headerStatus.textContent = 'Ошибка синхронизации';
                alert('Не удалось получить список администраторов.');
            } finally {
                syncBtn.disabled = false;
                syncBtn.textContent = 'Синхр. админов';
            }
        });

        notesBtn.addEventListener('click', async () => {
            notesBtn.disabled = true;
            notesBtn.textContent = 'Загрузка...';
            headerStatus.textContent = 'Загрузка заметок...';
            notesBtn.classList.remove('loaded');
            headerStatus.classList.remove('notes-loaded');

            try {
                if (!adminListCache?.vkByNick) {
                    const admins = await fetchAdminList();
                    adminListCache = admins;
                }

                await loadNotesForShortOnline(adminListCache?.allowedNicks, adminListCache?.vkByNick);
                const report = buildReport({
                    allowedNicks: adminListCache?.allowedNicks,
                    adminMetaByNick: adminListCache?.metaByNick,
                    notesByNick: notesCache,
                    inactivesData: inactivesCache
                });
                reportTextarea.value = report;
                notesLoaded = true;
                headerStatus.textContent = 'Заметки загружены';
                headerStatus.classList.add('notes-loaded');
            } catch (err) {
                console.error(err);
                headerStatus.textContent = 'Ошибка заметок';
                alert('Не удалось загрузить заметки.');
            } finally {
                notesBtn.disabled = false;
                notesBtn.textContent = notesLoaded ? 'Заметки ✓' : 'Заметки';
                if (notesLoaded) {
                    notesBtn.classList.add('loaded');
                }
            }
        });

        forumBtn.addEventListener('click', async () => {
            forumBtn.disabled = true;
            forumBtn.textContent = 'Загрузка...';
            headerStatus.textContent = 'Форум: загрузка...';

            try {
                const periodSummary = getPeriodSummary();
                if (!periodSummary) {
                    headerStatus.textContent = 'Форум: период не найден';
                    alert('Не удалось определить период. Проверь фильтр дат.');
                    return;
                }

                await loadForumReportForPeriod(periodSummary, { overlay, reportTextarea, forumTextarea, headerStatus });
            } catch (err) {
                console.error('[ForumReport]', err);
                headerStatus.textContent = 'Форум: ошибка';
                alert('Не удалось загрузить данные форума.');
            } finally {
                forumBtn.disabled = false;
                forumBtn.textContent = 'Синхр. форум';
            }
        });

        inactivesBtn.addEventListener('click', async () => {
            inactivesBtn.disabled = true;
            inactivesBtn.textContent = 'Загрузка...';
            headerStatus.textContent = 'Загрузка неактивов...';

            try {
                const periodSummary = getPeriodSummary();
                if (!periodSummary) {
                    headerStatus.textContent = 'Не найден период';
                    alert('Не удалось определить период. Проверь фильтр дат.');
                    return;
                }

                inactivesCache = await fetchInactivesForPeriod(periodSummary);
                const report = buildReport({
                    allowedNicks: adminListCache?.allowedNicks,
                    adminMetaByNick: adminListCache?.metaByNick,
                    notesByNick: notesCache,
                    inactivesData: inactivesCache
                });
                reportTextarea.value = report;
                headerStatus.textContent = `Неактивы: ${inactivesCache?.entries?.length ?? 0}`;
            } catch (err) {
                console.error(err);
                headerStatus.textContent = 'Ошибка неактивов';
                alert('Не удалось загрузить список неактивов.');
            } finally {
                inactivesBtn.disabled = false;
                inactivesBtn.textContent = 'Неактивы';
            }
        });

        function closeModal() {
            overlay.remove();
            if (currentReportModal?.overlay === overlay) {
                currentReportModal = null;
            }
        }

        closeBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });

        actions.appendChild(copyBtn);
        actions.appendChild(syncBtn);
        actions.appendChild(notesBtn);
        actions.appendChild(forumBtn);
        actions.appendChild(inactivesBtn);
        actions.appendChild(closeBtn);
        tabs.appendChild(reportTab);
        tabs.appendChild(forumTab);
        body.appendChild(tabs);
        body.appendChild(reportTextarea);
        body.appendChild(forumTextarea);
        modal.appendChild(header);
        modal.appendChild(body);
        modal.appendChild(actions);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        currentReportModal = { overlay, reportTextarea, forumTextarea, headerStatus };
        reportTextarea.focus();
        reportTextarea.select();

        return currentReportModal;
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

    async function fetchAdminListPayload() {
        if (chrome?.runtime?.sendMessage) {
            const response = await sendMessageAsync({
                type: 'fetch-adminlist',
                url: ADMIN_LIST_URL
            });

            if (response?.ok && response.data) {
                return response.data;
            }

            throw new Error(response?.error || 'adminlist fetch failed');
        }

        const response = await fetch(ADMIN_LIST_URL, { cache: 'no-cache', credentials: 'omit' });
        if (!response.ok) {
            throw new Error(`adminlist http ${response.status}`);
        }

        return response.json();
    }

    function extractAdminLevel(admin) {
        if (!admin || typeof admin !== 'object') return null;

        const directCandidates = [
            admin.level,
            admin.lvl,
            admin.admin_level,
            admin.adminLevel,
            admin.admin_lvl,
            admin.rank,
            admin.rank_id,
            admin.level_id
        ];

        for (const candidate of directCandidates) {
            const parsed = parseOptionalInteger(candidate);
            if (parsed !== null) return parsed;
        }

        for (const [key, value] of Object.entries(admin)) {
            if (!/lvl|level|rank/i.test(key)) continue;
            const parsed = parseOptionalInteger(value);
            if (parsed !== null) return parsed;
        }

        return null;
    }

    async function fetchAdminList() {
        const payload = await fetchAdminListPayload();
        if (payload?.error || !Array.isArray(payload?.admins)) {
            throw new Error('adminlist invalid response');
        }

        const allowedNicks = new Set();
        const vkByNick = new Map();
        const metaByNick = new Map();
        payload.admins.forEach((admin) => {
            const nick = String(admin?.nick || admin?.nickname || '').trim();
            if (!nick) return;
            const normalizedNick = nick.toLowerCase();
            allowedNicks.add(normalizedNick);

            const vkid = String(admin?.vk ?? admin?.vkid ?? admin?.vk_id ?? '').trim();
            if (vkid) {
                vkByNick.set(normalizedNick, vkid);
            }

            const level = extractAdminLevel(admin);
            metaByNick.set(normalizedNick, {
                nickname: nick,
                level
            });
        });
        return { allowedNicks, vkByNick, metaByNick };
    }

    async function fetchInactivesPayload() {
        if (chrome?.runtime?.sendMessage) {
            const response = await sendMessageAsync({
                type: 'fetch-inactives',
                url: INACTIVES_URL
            });

            if (response?.ok && response.data) {
                return response.data;
            }

            throw new Error(response?.error || 'inactives fetch failed');
        }

        const response = await fetch(INACTIVES_URL, { cache: 'no-cache', credentials: 'omit' });
        if (!response.ok) {
            throw new Error(`inactives http ${response.status}`);
        }
        return response.json();
    }

    function isInactiveApproved(entry) {
        if (!entry) return false;
        const statusValue = Number(entry.status);
        if (Number.isFinite(statusValue)) {
            return statusValue === 1;
        }
        const statusText = stripHtml(entry.status_info);
        return /одобрено/i.test(statusText);
    }

    async function fetchInactivesForPeriod(periodSummary) {
        const payload = await fetchInactivesPayload();
        const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows.slice() : [];
        rows.sort((a, b) => {
            const aId = Number(a?.id) || 0;
            const bId = Number(b?.id) || 0;
            return bId - aId;
        });
        const limitedRows = rows.slice(0, INACTIVES_LIMIT);

        const entries = [];
        const byNick = new Map();

        if (!periodSummary) {
            limitedRows.forEach((row) => {
                const nick = String(row?.nick || '').trim();
                if (!nick) return;
                entries.push({
                    id: row.id,
                    uid: row.uid,
                    nick,
                    user_id: row.user_id,
                    date_start: row.date_start,
                    date_end: row.date_end,
                    statusText: stripHtml(row.status_info)
                });
            });
            return { entries, byNick };
        }

            limitedRows.forEach((row) => {
                const nick = String(row?.nick || '').trim();
                if (!nick) return;

            const start = parseDateFromAny(row?.date_start);
            const end = parseDateFromAny(row?.date_end);
            if (!start || !end) return;

            const overlapStart = start > periodSummary.start ? start : periodSummary.start;
            const overlapEnd = end < periodSummary.end ? end : periodSummary.end;
            if (overlapStart > overlapEnd) return;

            const statusText = stripHtml(row.status_info);
            entries.push({
                id: row.id,
                uid: row.uid,
                nick,
                user_id: row.user_id,
                date_start: row.date_start,
                date_end: row.date_end,
                statusText
            });

            if (isInactiveApproved(row)) {
                const key = nick.toLowerCase();
                let daysSet = byNick.get(key);
                if (!daysSet) {
                    daysSet = new Set();
                    byNick.set(key, daysSet);
                }

                const cursor = new Date(overlapStart);
                while (cursor <= overlapEnd) {
                    daysSet.add(dateKey(cursor));
                    cursor.setDate(cursor.getDate() + 1);
                }
            }
        });

        return { entries, byNick };
    }

    async function fetchAdminInfoPayload(vkid) {
        if (!vkid) {
            throw new Error('vkid is required');
        }

        if (chrome?.runtime?.sendMessage) {
            const response = await sendMessageAsync({
                type: 'fetch-admin-info',
                url: ADMIN_INFO_URL,
                vkid: String(vkid)
            });

            if (response?.ok && response.data) {
                return response.data;
            }

            throw new Error(response?.error || 'admin info fetch failed');
        }

        const response = await fetch(ADMIN_INFO_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            },
            body: `vkid=${encodeURIComponent(String(vkid))}`
        });
        if (!response.ok) {
            throw new Error(`admin info http ${response.status}`);
        }

        return response.json();
    }

    function extractNoteCandidate(value) {
        if (value === null || value === undefined) return null;
        if (Array.isArray(value)) {
            const joined = value.map((item) => String(item).trim()).filter(Boolean).join(' | ');
            return joined || null;
        }
        if (typeof value === 'object') return null;
        const text = String(value).replace(/\s+/g, ' ').trim();
        return text || null;
    }

    function findNoteInObject(value, depth = 0) {
        if (!value || depth > 3) return null;
        if (Array.isArray(value)) {
            for (const entry of value) {
                const found = findNoteInObject(entry, depth + 1);
                if (found) return found;
            }
            return null;
        }
        if (typeof value !== 'object') return null;

        for (const [key, val] of Object.entries(value)) {
            if (/note|notes|comment|remark/i.test(key)) {
                const candidate = extractNoteCandidate(val);
                if (candidate) return candidate;
            }
            const nested = findNoteInObject(val, depth + 1);
            if (nested) return nested;
        }
        return null;
    }

    function extractNotesFromPayload(payload) {
        const candidates = [
            payload?.note,
            payload?.notes,
            payload?.info?.note,
            payload?.info?.notes,
            payload?.data?.note,
            payload?.data?.notes,
            payload?.user?.note,
            payload?.user?.notes,
            payload?.player?.note,
            payload?.player?.notes,
            payload?.result?.note,
            payload?.result?.notes,
            payload?.data?.info?.note,
            payload?.data?.info?.notes
        ];

        for (const candidate of candidates) {
            const note = extractNoteCandidate(candidate);
            if (note) return note;
        }

        const deepNote = findNoteInObject(payload, 0);
        return deepNote || '';
    }

    async function loadNotesForShortOnline(allowedNicks, vkByNick) {
            const { error, filteredEntries } = getFilteredEntries({ allowedNicks });
            if (error) {
                throw new Error(error);
            }

        const targets = filteredEntries
            .filter((entry) => entry.onlineSeconds !== null && entry.onlineSeconds < MIN_ONLINE_HOURS * 3600);

        console.log(NOTES_PREFIX, 'Targets for notes:', targets.length);

        let loaded = 0;
        for (const entry of targets) {
            const key = entry.nickname.toLowerCase();
            if (notesCache.has(key)) {
                console.log(NOTES_PREFIX, 'Skip cached:', entry.nickname);
                continue;
            }

            const vkid = vkByNick?.get(key);
            if (!vkid) {
                notesCache.set(key, '');
                console.log(NOTES_PREFIX, 'No vkid:', entry.nickname);
                continue;
            }

            try {
                const payload = await fetchAdminInfoPayload(vkid);
                const note = extractNotesFromPayload(payload);
                notesCache.set(key, note || '');
                console.log(NOTES_PREFIX, 'Loaded:', entry.nickname, 'vkid:', vkid, 'note:', Boolean(note));
                loaded += 1;
            } catch (err) {
                console.error(err);
                notesCache.set(key, '');
                console.log(NOTES_PREFIX, 'Error:', entry.nickname, 'vkid:', vkid);
            }
        }

        return { total: targets.length, loaded };
    }

    function ensureForumConfigStyles() {
        const styleId = 'adminsForumConfigStyles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            #${FORUM_CONFIG_OVERLAY_ID} {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.55);
                z-index: 10002;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .admins-forum-config-modal {
                width: min(920px, 96vw);
                max-height: 92vh;
                background: #1c1f23;
                border: 1px solid #3a3f45;
                border-radius: 10px;
                box-shadow: 0 16px 36px rgba(0, 0, 0, 0.55);
                display: flex;
                flex-direction: column;
            }
            .admins-forum-config-header {
                padding: 16px 20px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                border-bottom: 1px solid #2a2f35;
                color: #fff;
                font-weight: 600;
            }
            .admins-forum-config-title {
                font-size: 16px;
                margin-bottom: 4px;
            }
            .admins-forum-config-status {
                font-size: 12px;
                color: rgba(236, 241, 249, 0.7);
            }
            .admins-forum-config-close {
                background: transparent;
                border: none;
                color: #fff;
                font-size: 20px;
                cursor: pointer;
            }
            .admins-forum-config-body {
                padding: 16px 20px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                overflow: auto;
            }
            .admins-forum-config-field {
                display: flex;
                flex-direction: column;
                gap: 6px;
                font-size: 12px;
                color: rgba(236, 241, 249, 0.8);
            }
            .admins-forum-config-field input {
                background: #121212;
                color: #f5f5f5;
                border: 1px solid #3a3f45;
                border-radius: 6px;
                padding: 8px 10px;
                font-size: 13px;
            }
            .admins-forum-config-groups {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .admins-forum-config-group {
                border: 1px solid #2a2f35;
                border-radius: 8px;
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                background: #20242a;
            }
            .admins-forum-config-group-head {
                display: grid;
                gap: 10px;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                align-items: end;
            }
            .admins-forum-config-group-head button {
                height: 34px;
            }
            .admins-forum-config-forums {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .admins-forum-config-forum-row {
                display: grid;
                gap: 8px;
                grid-template-columns: 110px 1fr 34px;
                align-items: center;
            }
            .admins-forum-config-forum-row input {
                background: #121212;
                color: #f5f5f5;
                border: 1px solid #3a3f45;
                border-radius: 6px;
                padding: 8px 10px;
                font-size: 13px;
            }
            .admins-forum-config-forum-row button {
                background: #2a2f35;
                border: 1px solid #3a3f45;
                color: #fff;
                border-radius: 6px;
                height: 34px;
                cursor: pointer;
            }
            .admins-forum-config-add {
                align-self: flex-start;
                background: #2a2f35;
                border: 1px dashed #4b525a;
                color: #fff;
                border-radius: 6px;
                padding: 6px 12px;
                cursor: pointer;
                font-size: 12px;
            }
            .admins-forum-config-actions {
                padding: 0 20px 16px;
                display: flex;
                justify-content: flex-end;
                gap: 10px;
            }
            .admins-forum-config-toggle {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
                color: rgba(236, 241, 249, 0.9);
            }
            .admins-forum-config-toggle input {
                width: 18px;
                height: 18px;
            }
            .admins-forum-config-rewards {
                border: 1px solid #2a2f35;
                border-radius: 8px;
                padding: 12px;
                background: #20242a;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .admins-forum-config-rewards-fields {
                display: grid;
                gap: 10px;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            }
            .admins-forum-config-norm {
                border: 1px solid #2a2f35;
                border-radius: 8px;
                padding: 12px;
                background: #20242a;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .admins-forum-config-btn {
                padding: 8px 16px;
                border-radius: 6px;
                border: 1px solid #3a3f45;
                background: #2a2f35;
                color: #fff;
                cursor: pointer;
                font-weight: 600;
                font-size: 12px;
            }
            .admins-forum-config-btn.primary {
                background: #4dd0e1;
                color: #111;
                border-color: transparent;
            }
            .admins-forum-config-btn.ghost {
                background: transparent;
            }
        `;
        document.head.appendChild(style);
    }

    function createForumRow(forum = {}) {
        const row = document.createElement('div');
        row.className = 'admins-forum-config-forum-row';

        const idInput = document.createElement('input');
        idInput.type = 'number';
        idInput.min = '1';
        idInput.step = '1';
        idInput.placeholder = 'ID';
        idInput.dataset.field = 'forumId';
        idInput.value = forum?.id ? String(forum.id) : '';

        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.placeholder = 'Название форума';
        titleInput.dataset.field = 'forumTitle';
        titleInput.value = forum?.title ? String(forum.title) : '';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => row.remove());

        row.appendChild(idInput);
        row.appendChild(titleInput);
        row.appendChild(removeBtn);

        return row;
    }

    function createForumGroup(group = {}) {
        const groupEl = document.createElement('div');
        groupEl.className = 'admins-forum-config-group';

        const head = document.createElement('div');
        head.className = 'admins-forum-config-group-head';

        const keyField = document.createElement('label');
        keyField.className = 'admins-forum-config-field';
        const keyLabel = document.createElement('span');
        keyLabel.textContent = 'Ключ группы';
        const keyInput = document.createElement('input');
        keyInput.type = 'text';
        keyInput.dataset.field = 'groupKey';
        keyInput.placeholder = 'sostNesost';
        keyInput.value = group?.key ? String(group.key) : '';
        keyField.appendChild(keyLabel);
        keyField.appendChild(keyInput);

        const titleField = document.createElement('label');
        titleField.className = 'admins-forum-config-field';
        const titleLabel = document.createElement('span');
        titleLabel.textContent = 'Название';
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.dataset.field = 'groupTitle';
        titleInput.placeholder = 'Сост / Несост';
        titleInput.value = group?.title ? String(group.title) : '';
        titleField.appendChild(titleLabel);
        titleField.appendChild(titleInput);

        const removeGroupBtn = document.createElement('button');
        removeGroupBtn.type = 'button';
        removeGroupBtn.className = 'admins-forum-config-btn ghost';
        removeGroupBtn.textContent = 'Удалить группу';
        removeGroupBtn.addEventListener('click', () => groupEl.remove());

        head.appendChild(keyField);
        head.appendChild(titleField);
        head.appendChild(removeGroupBtn);

        const forumsWrap = document.createElement('div');
        forumsWrap.className = 'admins-forum-config-forums';

        const forums = Array.isArray(group?.forums) && group.forums.length ? group.forums : [{}];
        forums.forEach((forum) => {
            forumsWrap.appendChild(createForumRow(forum));
        });

        const addForumBtn = document.createElement('button');
        addForumBtn.type = 'button';
        addForumBtn.className = 'admins-forum-config-add';
        addForumBtn.textContent = '+ Добавить форум';
        addForumBtn.addEventListener('click', () => {
            forumsWrap.appendChild(createForumRow({}));
        });

        groupEl.appendChild(head);
        groupEl.appendChild(forumsWrap);
        groupEl.appendChild(addForumBtn);

        return groupEl;
    }

    function renderForumConfigForm(modal, config) {
        const serverInput = modal.querySelector('[data-field="serverTitle"]');
        const groupsWrap = modal.querySelector('.admins-forum-config-groups');
        const rewardsToggle = modal.querySelector('[data-field="showRewards"]');
        const rewardStepInput = modal.querySelector('[data-field="rewardReportsStep"]');
        const rewardAmountInput = modal.querySelector('[data-field="rewardAmountPerStep"]');
        const rewardsFields = modal.querySelector('.admins-forum-config-rewards-fields');
        const dailyNormInput = modal.querySelector('[data-field="dailyNormHours"]');
        if (!serverInput || !groupsWrap) return;

        serverInput.value = config?.serverTitle || '';
        if (dailyNormInput) {
            dailyNormInput.value = String(config?.dailyNormHours ?? DAILY_NORM_HOURS);
        }
        if (rewardsToggle) {
            rewardsToggle.checked = Boolean(config?.showRewards);
        }
        if (rewardStepInput) {
            rewardStepInput.value = String(config?.rewardReportsStep ?? REWARD_REPORTS_STEP);
        }
        if (rewardAmountInput) {
            rewardAmountInput.value = String(config?.rewardAmountPerStep ?? REWARD_AMOUNT_PER_STEP);
        }
        if (rewardsFields) {
            rewardsFields.style.display = rewardsToggle?.checked ? 'grid' : 'none';
        }
        groupsWrap.innerHTML = '';

        const groups = Array.isArray(config?.groups) && config.groups.length ? config.groups : [{}];
        groups.forEach((group) => {
            groupsWrap.appendChild(createForumGroup(group));
        });
    }

    function readForumConfigFromForm(modal) {
        const serverInput = modal.querySelector('[data-field="serverTitle"]');
        const groupsWrap = modal.querySelector('.admins-forum-config-groups');
        if (!groupsWrap) {
            return { error: 'Форма настроек не найдена.' };
        }

        const serverTitle = String(serverInput?.value || '').trim();
        const groups = [];
        const dailyNormValue = parseOptionalInteger(modal.querySelector('[data-field="dailyNormHours"]')?.value);
        const showRewards = Boolean(modal.querySelector('[data-field="showRewards"]')?.checked);
        const rewardStepValue = parseOptionalInteger(modal.querySelector('[data-field="rewardReportsStep"]')?.value);
        const rewardAmountValue = parseOptionalInteger(modal.querySelector('[data-field="rewardAmountPerStep"]')?.value);

        groupsWrap.querySelectorAll('.admins-forum-config-group').forEach((groupEl) => {
            const key = String(groupEl.querySelector('[data-field="groupKey"]')?.value || '').trim();
            const title = String(groupEl.querySelector('[data-field="groupTitle"]')?.value || '').trim();
            const forums = [];

            groupEl.querySelectorAll('.admins-forum-config-forum-row').forEach((row) => {
                const idValue = row.querySelector('[data-field="forumId"]')?.value || '';
                const id = parseForumId(idValue);
                if (!id) return;
                const forumTitle = String(row.querySelector('[data-field="forumTitle"]')?.value || '').trim();
                forums.push({ id, title: forumTitle || `Форум ${id}` });
            });

            if (key && forums.length) {
                groups.push({ key, title, forums });
            }
        });

        if (!groups.length) {
            return { error: 'Добавьте хотя бы одну группу с форумами.' };
        }

        const configPayload = {
            serverTitle,
            groups,
            showRewards,
            rewardReportsStep: rewardStepValue ?? REWARD_REPORTS_STEP,
            rewardAmountPerStep: rewardAmountValue ?? REWARD_AMOUNT_PER_STEP,
            dailyNormHours: dailyNormValue ?? DAILY_NORM_HOURS
        };
        return { config: normalizeForumConfig(configPayload) };
    }

    function refreshReportAfterConfigChange() {
        forumReportState = {
            key: null,
            status: 'idle',
            data: null,
            error: null,
            promise: null
        };

        if (currentReportModal?.headerStatus) {
            currentReportModal.headerStatus.textContent = 'Форум: не синхронизирован';
        }
        if (currentReportModal?.reportTextarea) {
            currentReportModal.reportTextarea.value = buildReport({
                allowedNicks: adminListCache?.allowedNicks,
                adminMetaByNick: adminListCache?.metaByNick,
                notesByNick: notesCache,
                inactivesData: inactivesCache
            });
        }
        if (currentReportModal?.forumTextarea) {
            currentReportModal.forumTextarea.value = buildForumStatsReport();
        }
    }

    async function showForumConfigModal() {
        await loadForumConfig({ force: true });
        ensureForumConfigStyles();

        if (currentConfigModal?.overlay && document.body.contains(currentConfigModal.overlay)) {
            renderForumConfigForm(currentConfigModal.modal, getForumConfig());
            currentConfigModal.status.textContent = '';
            return currentConfigModal;
        }

        const overlay = document.createElement('div');
        overlay.id = FORUM_CONFIG_OVERLAY_ID;

        const modal = document.createElement('div');
        modal.className = 'admins-forum-config-modal';
        modal.innerHTML = `
            <div class="admins-forum-config-header">
                <div>
                    <div class="admins-forum-config-title">Настройка форумов</div>
                    <div class="admins-forum-config-status"></div>
                </div>
                <button type="button" class="admins-forum-config-close">×</button>
            </div>
            <div class="admins-forum-config-body">
                <label class="admins-forum-config-field">
                    <span>Название сервера</span>
                    <input type="text" data-field="serverTitle" placeholder="Arizona Mobile 3">
                </label>
                <div class="admins-forum-config-norm">
                    <label class="admins-forum-config-field">
                        <span>Норма онлайна в день (часы)</span>
                        <input type="number" min="1" step="1" data-field="dailyNormHours" placeholder="3">
                    </label>
                </div>
                <div class="admins-forum-config-rewards">
                    <label class="admins-forum-config-toggle">
                        <input type="checkbox" data-field="showRewards">
                        Показывать блок денежного вознаграждения
                    </label>
                    <div class="admins-forum-config-rewards-fields">
                        <label class="admins-forum-config-field">
                            <span>Шаг отчетов</span>
                            <input type="number" min="1" step="1" data-field="rewardReportsStep" placeholder="500">
                        </label>
                        <label class="admins-forum-config-field">
                            <span>Сумма за шаг</span>
                            <input type="number" min="1" step="1" data-field="rewardAmountPerStep" placeholder="190">
                        </label>
                    </div>
                </div>
                <div class="admins-forum-config-groups"></div>
                <button type="button" class="admins-forum-config-add">+ Добавить группу</button>
            </div>
            <div class="admins-forum-config-actions">
                <button type="button" class="admins-forum-config-btn primary" data-action="save">Сохранить</button>
                <button type="button" class="admins-forum-config-btn ghost" data-action="reset">Сбросить</button>
                <button type="button" class="admins-forum-config-btn" data-action="close">Закрыть</button>
            </div>
        `;

        const status = modal.querySelector('.admins-forum-config-status');
        const closeBtn = modal.querySelector('.admins-forum-config-close');
        const addGroupBtn = modal.querySelector('.admins-forum-config-add');
        const saveBtn = modal.querySelector('[data-action="save"]');
        const resetBtn = modal.querySelector('[data-action="reset"]');
        const closeActionBtn = modal.querySelector('[data-action="close"]');
        const rewardsToggle = modal.querySelector('[data-field="showRewards"]');
        const rewardsFields = modal.querySelector('.admins-forum-config-rewards-fields');

        const closeModal = () => {
            overlay.remove();
            if (currentConfigModal?.overlay === overlay) {
                currentConfigModal = null;
            }
        };

        addGroupBtn?.addEventListener('click', () => {
            const groupsWrap = modal.querySelector('.admins-forum-config-groups');
            if (!groupsWrap) return;
            groupsWrap.appendChild(createForumGroup({}));
        });
        rewardsToggle?.addEventListener('change', () => {
            if (rewardsFields) {
                rewardsFields.style.display = rewardsToggle.checked ? 'grid' : 'none';
            }
        });

        saveBtn?.addEventListener('click', async () => {
            const result = readForumConfigFromForm(modal);
            if (result.error) {
                if (status) status.textContent = result.error;
                return;
            }
            const config = result.config;
            const saved = await saveForumConfigToStorage(config);
            forumConfigState.value = config;
            forumConfigState.promise = null;
            refreshReportAfterConfigChange();
            renderForumConfigForm(modal, config);
            if (status) {
                status.textContent = saved ? 'Сохранено' : 'Сохранено локально';
            }
        });

        resetBtn?.addEventListener('click', async () => {
            await clearForumConfigStorage();
            forumConfigState.value = DEFAULT_FORUM_CONFIG;
            forumConfigState.promise = null;
            refreshReportAfterConfigChange();
            renderForumConfigForm(modal, DEFAULT_FORUM_CONFIG);
            if (status) status.textContent = 'Сброшено к значениям по умолчанию';
        });

        closeBtn?.addEventListener('click', closeModal);
        closeActionBtn?.addEventListener('click', closeModal);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });

        renderForumConfigForm(modal, getForumConfig());
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        currentConfigModal = {
            overlay,
            modal,
            status
        };

        return currentConfigModal;
    }

    function addReportButton() {
        const container = document.querySelector('.filter-buttons');
        if (!container || document.getElementById(REPORT_BUTTON_ID)) return;

        ensureReportStyles();

        const actionsWrap = document.createElement('div');
        actionsWrap.className = 'admins-report-actions';

        const button = document.createElement('button');
        button.id = REPORT_BUTTON_ID;
        button.type = 'button';
        button.className = 'btn btn-secondary';
        button.classList.add('admins-report-action-btn');
        button.textContent = 'Сформировать отчет';
        button.style.margin = '0';
        button.style.padding = '10px 20px';
        button.style.background = '#ffc107';
        button.style.color = '#000';
        button.style.border = 'none';
        button.style.borderRadius = '4px';
        button.style.cursor = 'pointer';
        button.style.fontSize = '14px';
        button.style.fontWeight = 'bold';
        button.style.display = 'block';
        button.style.width = '100%';
        button.style.maxWidth = '300px';

        button.addEventListener('click', () => {
            const periodSummary = getPeriodSummary();
            const periodKey = getPeriodKey(periodSummary);
            if (forumReportState.key !== periodKey) {
                forumReportState = {
                    key: periodKey,
                    status: 'idle',
                    data: null,
                    error: null,
                    promise: null
                };
            }
            const report = buildReport({
                allowedNicks: adminListCache?.allowedNicks,
                adminMetaByNick: adminListCache?.metaByNick,
                notesByNick: notesCache,
                inactivesData: inactivesCache
            });
            showReportModal(report);
        });

        const configButton = document.createElement('button');
        configButton.id = FORUM_CONFIG_BUTTON_ID;
        configButton.type = 'button';
        configButton.className = 'btn btn-secondary';
        configButton.classList.add('admins-report-action-btn');
        configButton.textContent = 'Настроить форумы';
        configButton.style.margin = '0';
        configButton.style.padding = '10px 20px';
        configButton.style.background = '#4dd0e1';
        configButton.style.color = '#000';
        configButton.style.border = 'none';
        configButton.style.borderRadius = '4px';
        configButton.style.cursor = 'pointer';
        configButton.style.fontSize = '14px';
        configButton.style.fontWeight = 'bold';
        configButton.style.display = 'block';
        configButton.style.width = '100%';
        configButton.style.maxWidth = '300px';
        configButton.addEventListener('click', () => {
            void showForumConfigModal();
        });

        actionsWrap.appendChild(button);
        actionsWrap.appendChild(configButton);
        container.appendChild(actionsWrap);
    }

    loadForumConfig();
    runWhenReady(addReportButton);

    function formatOnlineColumn() {
        const table = document.querySelector('table.table');
        if (!table) return;

        const headerCells = Array.from(table.querySelectorAll('thead th'));
        const headers = headerCells.map((cell) => normalizeHeaderText(cell.textContent));
        const onlineIndex = findColumnIndex(headers, ['онлайн', 'online', '?????']);
        if (onlineIndex < 0) return;

        const periodSummary = getPeriodSummary();
        const periodDays = periodSummary?.days;

        const rows = Array.from(table.querySelectorAll('tbody tr'));
        rows.forEach((row) => {
            const cells = row.querySelectorAll('td');
            const cell = cells[onlineIndex];
            if (!cell || cell.dataset.onlineFormatted) return;

            const raw = String(cell.textContent || '').replace(/\s+/g, ' ').trim();
            if (!raw || raw.includes('(')) return;

            const seconds = parseDurationToSeconds(raw);
            if (seconds === null) return;

            const avgText = formatAveragePerDay(seconds, periodDays);
            const avgSuffix = avgText ? ` (${avgText})` : '';
            cell.dataset.onlineSeconds = String(seconds);
            cell.dataset.onlineRaw = raw;
            cell.textContent = `${formatHmsTotal(seconds)}${avgSuffix} ( ${raw} )`;
            cell.dataset.onlineFormatted = '1';
        });
    }

    let formatOnlineQueued = false;

    function scheduleFormatOnlineColumn() {
        if (formatOnlineQueued) return;
        formatOnlineQueued = true;
        requestAnimationFrame(() => {
            formatOnlineQueued = false;
            formatOnlineColumn();
        });
    }

    function observeOnlineColumn() {
        const table = document.querySelector('table.table');
        const tbody = table?.querySelector('tbody');
        if (!tbody) return;

        const observer = new MutationObserver(() => {
            scheduleFormatOnlineColumn();
        });
        observer.observe(tbody, { childList: true, subtree: true });
    }

    runWhenReady(() => {
        formatOnlineColumn();
        observeOnlineColumn();
    });
})();

// Arizona RP Logs Period Splitter

(function() {
    'use strict';
    if (/^\/admins\/?$/i.test(window.location.pathname)) {
        return;
    }
    let pageIsHiding = false;
    const onPageHideCallbacks = [];

    function onPageHide(callback) {
        if (typeof callback === 'function') {
            onPageHideCallbacks.push(callback);
        }
    }

    window.addEventListener('pagehide', (event) => {
        pageIsHiding = true;
        for (const callback of onPageHideCallbacks) {
            try {
                callback(event);
            } catch (_error) {
            }
        }
    });

    window.addEventListener('beforeunload', () => {
        pageIsHiding = true;
    }, { once: true });

    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            pageIsHiding = false;
        }
    });

    // Утилита debounce для предотвращения частых вызовов
    function debounce(fn, delay) {
        let timeoutId = null;
        return function(...args) {
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                timeoutId = null;
                fn.apply(this, args);
            }, delay);
        };
    }

    // WeakSet для отслеживания обработанных строк таблицы
    const processedRows = new WeakSet();

    // Максимальный безопасный период (по умолчанию)
    let maxSafeMonths = 9;
    let autoSplitEnabled = true; // По умолчанию включено
    let csvButtonEnabled = false; // По умолчанию включено

    const DEBUG_PREFIX = '[LogsPeriodSplitter]';
    const PRICES_PREFIX = '[ItemPrices]';
    const AUTO_SPLIT_BUTTON_ID = 'autoSplitBtn';
    const EXPORT_CSV_BUTTON_ID = 'exportCsvBtn';
    const INTERACTION_LOOKBACK_MINUTES = 60; // минут до события
    const INTERACTION_LOOKAHEAD_MINUTES = 120; // минут после события
    const INTERACTION_FOCUS_PARAM = 'interaction_focus_ts';
    const HOUSE_FROM_TYPE = 'inventory_from_house';
    const HOUSE_TO_TYPE = 'inventory_to_house';
    const MINUTE_IN_MS = 60 * 1000;
    const SERVER_TZ_OFFSET_MINUTES = 180; // Europe/Moscow UTC+3, круглый год

    // Хранилище цен
    let itemPricesMap = new Map(); // id -> price
    let vehiclePricesMap = new Map(); // normalized name -> { price, model, name }

    function getMaxSafeMonths() {
        return maxSafeMonths;
    }

    function getAutoSplitEnabled() {
        return autoSplitEnabled;
    }

    function getCsvButtonEnabled() {
        return csvButtonEnabled;
    }

    function applyMaxSafeMonths(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
            debugLog('Игнорируется некорректное значение maxSafeMonths', value);
            return;
        }

        const normalized = Math.max(1, Math.floor(numeric));
        if (normalized !== maxSafeMonths) {
            debugLog('Обновляем maxSafeMonths', { old: maxSafeMonths, new: normalized });
            maxSafeMonths = normalized;
        }
    }

    function applyAutoSplitEnabled(value) {
        const newState = value !== false; // По умолчанию true
        if (newState !== autoSplitEnabled) {
            debugLog('Обновляем autoSplitEnabled', { old: autoSplitEnabled, new: newState });
            autoSplitEnabled = newState;
            // Кнопка больше не отображается на странице
        }
    }

    function applyCsvButtonEnabled(value) {
        const newState = value !== false; // По умолчанию true
        if (newState !== csvButtonEnabled) {
            debugLog('Обновляем csvButtonEnabled', { old: csvButtonEnabled, new: newState });
            csvButtonEnabled = newState;
            toggleCsvButton();
        }
    }

    function toggleCsvButton() {
        const button = document.getElementById(EXPORT_CSV_BUTTON_ID);
        if (!button) return;

        if (csvButtonEnabled) {
            button.style.display = 'block';
            debugLog('Кнопка CSV отображена');
        } else {
            button.style.display = 'none';
            debugLog('Кнопка CSV скрыта');
        }
    }

    function initializeSettings() {
        try {
            if (chrome?.storage?.local?.get) {
                chrome.storage.local.get({
                    maxSafeMonths,
                    autoSplitEnabled: true,
                    csvButtonEnabled: true
                }, (result) => {
                    applyMaxSafeMonths(result.maxSafeMonths);
                    applyAutoSplitEnabled(result.autoSplitEnabled);
                    applyCsvButtonEnabled(result.csvButtonEnabled);
                });

                if (chrome.storage.onChanged) {
                    chrome.storage.onChanged.addListener((changes, areaName) => {
                        if (areaName === 'local') {
                            if (changes.maxSafeMonths) {
                                applyMaxSafeMonths(changes.maxSafeMonths.newValue);
                            }
                            if (changes.autoSplitEnabled) {
                                applyAutoSplitEnabled(changes.autoSplitEnabled.newValue);
                            }
                            if (changes.csvButtonEnabled) {
                                applyCsvButtonEnabled(changes.csvButtonEnabled.newValue);
                            }
                        }
                    });
                }
            }
        } catch (error) {
            debugLog('Не удалось загрузить настройки из chrome.storage', error);
        }
    }

    initializeSettings();

    function debugLog(...args) {
        console.log(DEBUG_PREFIX, ...args)
    }

    function pricesLog(...args) {
        console.log(PRICES_PREFIX, ...args)
    }

    // Выполняет fn сразу или после готовности DOM, с одноразовой подпиской
    function runWhenReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    // Функция для парсинга даты из формата "YYYY-MM-DD" или "YYYY-MM-DD HH:MM[:SS]"
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

    // Функция для работы с датами как строками (timezone-independent)
    function parseDateString(dateStr) {
        if (!dateStr) return null;
        const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2})(?::(\d{2})(?::(\d{2}))?)?)?/);
        if (!match) return null;

        const year = Number(match[1]);
        const month = Number(match[2]) - 1; // JS месяцы с 0
        const day = Number(match[3]);
        const hours = Number(match[4] ?? '0');
        const minutes = Number(match[5] ?? '0');
        const seconds = Number(match[6] ?? '0');

        // Возвращаем объект с компонентами даты
        return { year, month, day, hours, minutes, seconds };
    }

    function formatDateUTC(date) {
        const y = date.getUTCFullYear();
        const m = String(date.getUTCMonth() + 1).padStart(2, '0');
        const d = String(date.getUTCDate()).padStart(2, '0');
        const hh = String(date.getUTCHours()).padStart(2, '0');
        const mm = String(date.getUTCMinutes()).padStart(2, '0');
        const ss = String(date.getUTCSeconds()).padStart(2, '0');
        return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
    }

    // Отформатировать Date как время в «виртуальной локали» с заданным offset от UTC
    function formatDateInTZ(date, offsetMin) {
        const shifted = new Date(date.getTime() + offsetMin * 60000);
        return formatDateUTC(shifted);
    }

    // Перевод строки «YYYY-MM-DD HH:MM:SS» (в серверном TZ) -> локальная строка
    function serverStrToLocalStr(serverStr, offsetMin = SERVER_TZ_OFFSET_MINUTES) {
        const p = parseDateString(serverStr);
        if (!p) return serverStr;
        // интерпретируем как локальное серверное время => переводим в UTC
        const utcMs = Date.UTC(p.year, p.month, p.day, p.hours, p.minutes, p.seconds) - offsetMin * 60000;
        return formatDate(new Date(utcMs));
    }

    function safeDecode(value, fallback = null) {
        try {
            return decodeURIComponent(value);
        } catch (_error) {
            return fallback;
        }
    }

    // Функция для добавления минут к строке даты в серверном TZ (MSK)
    function addMinutesToDateString(dateStr, minutesToAdd, tzOffsetMin = SERVER_TZ_OFFSET_MINUTES) {
        const parsed = parseDateString(dateStr);
        if (!parsed) return null;

        // трактуем вход как локальное время сервера (MSK): переводим в UTC
        const utcMs =
            Date.UTC(parsed.year, parsed.month, parsed.day, parsed.hours, parsed.minutes, parsed.seconds)
            - tzOffsetMin * 60000;

        // добавляем минуты в UTC
        const resultUtc = new Date(utcMs + minutesToAdd * 60000);

        // форматируем обратно как «время сервера»
        return formatDateInTZ(resultUtc, tzOffsetMin);
    }

    // Функция для форматирования даты в формат "YYYY-MM-DD HH:MM:SS"
    function formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    // Функция для добавления месяцев к дате
    function addMonths(date, months) {
        const newDate = new Date(date);
        newDate.setMonth(newDate.getMonth() + months);
        return newDate;
    }

    // Функция для вычисления разницы в месяцах
    function monthsDifference(date1, date2) {
        const months = (date2.getFullYear() - date1.getFullYear()) * 12 +
                       (date2.getMonth() - date1.getMonth());
        return months;
    }

    // Функция для разбиения периода на части
    function splitPeriod(startDate, endDate) {
        const periods = [];
        let currentStart = new Date(startDate);

        while (currentStart < endDate) {
            const currentEnd = addMonths(currentStart, getMaxSafeMonths());
            const periodEnd = currentEnd > endDate ? endDate : currentEnd;

            periods.push({
                start: new Date(currentStart),
                end: new Date(periodEnd)
            });

            currentStart = new Date(periodEnd);
            // Добавляем 1 секунду, чтобы не было перекрытия
            currentStart.setSeconds(currentStart.getSeconds() + 1);
        }

        return periods;
    }

    function extractAccountIds(row, maxCount) {
        if (!row) {
            return [];
        }

        const accountIds = [];
        const infoButtons = row.querySelectorAll('.js_entry_format_button');

        for (const button of infoButtons) {
            if (Number.isFinite(maxCount) && maxCount > 0 && accountIds.length >= maxCount) {
                break;
            }

            const hiddenInfo = button.nextElementSibling;
            if (!hiddenInfo || !hiddenInfo.classList?.contains('app__hidden')) {
                continue;
            }

            const accountLi = Array.from(hiddenInfo.querySelectorAll('li'))
                .find((li) => /ID\s+аккаунта/i.test(li.textContent || ''));

            if (!accountLi) {
                continue;
            }

            const codeElement = accountLi.querySelector('code');
            const rawValue = (codeElement?.textContent || accountLi.textContent || '').trim();
            const match = rawValue.match(/\d+/);
            if (!match) {
                continue;
            }

            const normalizedId = match[0].replace(/^0+/, '') || '0';
            accountIds.push(normalizedId);
        }

        return accountIds;
    }

    function formatPlayerLabel(name, accountId) {
        if (!name) {
            return accountId ? `[${accountId}]` : '';
        }
        return accountId ? `${name} [${accountId}]` : name;
    }

    function formatActionWithAccountIds(action, accountIds, row) {
        if (!action || accountIds.length === 0) {
            return action;
        }

        // Проверяем, не содержит ли уже строка accountIds (чтобы не добавлять их дважды)
        if (action.includes('[accID:')) {
            return action;
        }

        // Ищем ссылки на игроков в строке таблицы
        const playerLinks = Array.from(row.querySelectorAll('a[href*="player="]'));
        if (playerLinks.length === 0) {
            return action;
        }

        // Извлекаем имена игроков из ссылок
        const playerNames = playerLinks
            .slice(0, accountIds.length)
            .map(link => {
                const match = link.href.match(/player=([^&]+)/);
                return match ? decodeURIComponent(match[1]) : null;
            })
            .filter(Boolean);

        // Заменяем ники на версию с accountIds
        let result = action;
        playerNames.forEach((name, index) => {
            if (index < accountIds.length && accountIds[index]) {
                // Используем отрицательный lookahead для замены только ников без [accID:
                const regex = new RegExp(`\\b${name}(?!\\[accID:)`, 'g');
                const replacement = `${name}[accID:${accountIds[index]}]`;
                result = result.replace(regex, replacement);
            }
        });

        return result;
    }

    function getInputValue(input) {
        if (!input) {
            return '';
        }

        const direct = typeof input.value === 'string' ? input.value.trim() : '';
        if (direct) {
            return direct;
        }

        const attrValue = input.getAttribute && input.getAttribute('value');
        if (attrValue && attrValue.trim()) {
            return attrValue.trim();
        }

        const dataValue = input.dataset ? (input.dataset.value || input.dataset.defaultValue) : null;
        if (dataValue && dataValue.trim()) {
            return dataValue.trim();
        }

        // Иногда flatpickr хранит значение в data-date или data-alt-value
        const dataDate = input.getAttribute && (input.getAttribute('data-date') || input.getAttribute('data-alt-value'));
        if (dataDate && dataDate.trim()) {
            return dataDate.trim();
        }

        return '';
    }

    function getCurrentTimeString() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    }

    function ensureDateTimeString(value, fallbackTime) {
        if (!value) {
            return value;
        }

        const trimmed = value.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            return `${trimmed} ${fallbackTime}`;
        }

        if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(trimmed)) {
            return `${trimmed}:00`;
        }

        return trimmed;
    }

    function safeSubmit(form, reason = 'unknown') {
        debugLog('Переходим к стандартной отправке формы', { reason });

        if (form) {
            try {
                HTMLFormElement.prototype.submit.call(form);
                debugLog('Форма отправлена без разбиения (native submit)');
            } catch (err) {
                debugLog('Не удалось вызвать native submit, пробуем form.submit()', err);
                form.submit();
            }
            return;
        }

        const applyButton = findApplyButton();
        if (applyButton) {
            debugLog('Форма не найдена, кликаем по кнопке "Применить"');
            applyButton.click();
        } else {
            console.warn('Не удалось выполнить стандартную отправку: форма и кнопка "Применить" не найдены');
        }
    }

    // Перехватываем сабмит формы, чтобы запускать авторазбиение по Enter
    function attachFormSubmitInterceptor(form) {
        if (!form) {
            debugLog('Форма не найдена для перехвата submit');
            return;
        }

        if (form.dataset.autoSplitSubmitHooked === 'true') {
            return;
        }

        form.addEventListener('submit', (event) => {
            debugLog('Перехвачен submit формы', {
                targetTag: event.target?.tagName,
                triggeredBy: event.submitter?.textContent || 'Enter',
                autoSplitEnabled
            });

            event.preventDefault();

            // Проверяем, включено ли автоматическое разбиение
            if (autoSplitEnabled) {
                autoSplitPeriod(event);
            } else {
                // Если выключено, выполняем обычную отправку формы
                debugLog('Авто-разбиение выключено, используем стандартную отправку');
                safeSubmit(form, 'auto-split-disabled');
            }
        });

        form.dataset.autoSplitSubmitHooked = 'true';
        debugLog('Хук на submit установлен');
    }

    // Функция для поиска полей даты
    function findDateFields() {
        let periodFrom = null;
        let periodTo = null;

        // Стратегия 1: Поиск по label с текстом
        const labels = document.querySelectorAll('label, div, span, p');
        labels.forEach(label => {
            const text = label.textContent?.trim();
            if (text === 'Период от') {
                // Ищем input рядом
                const parent = label.parentElement;
                const input = parent?.querySelector('input') ||
                             label.nextElementSibling?.querySelector('input') ||
                             label.closest('div')?.querySelector('input');
                if (input && !periodFrom) {
                    periodFrom = input;
                }
            }
            if (text === 'Период до') {
                const parent = label.parentElement;
                const input = parent?.querySelector('input') ||
                             label.nextElementSibling?.querySelector('input') ||
                             label.closest('div')?.querySelector('input');
                if (input && !periodTo) {
                    periodTo = input;
                }
            }
        });

        // Стратегия 2: Поиск по placeholder
        if (!periodFrom || !periodTo) {
            const allInputs = document.querySelectorAll('input');
            allInputs.forEach(input => {
                if ((input.placeholder?.includes('Период от') ||
                     input.getAttribute('placeholder')?.includes('Период от')) && !periodFrom) {
                    periodFrom = input;
                }
                if ((input.placeholder?.includes('Период до') ||
                     input.getAttribute('placeholder')?.includes('Период до')) && !periodTo) {
                    periodTo = input;
                }
            });
        }

        // Стратегия 3: Поиск по значению (для уже заполненного поля)
        if (!periodFrom || !periodTo) {
            const allInputs = document.querySelectorAll('input');
            const inputsArray = Array.from(allInputs);

            // Ищем input с датой в формате YYYY-MM-DD или datetime-local
            const dateInputs = inputsArray.filter(inp => {
                return inp.type === 'datetime-local' ||
                       inp.type === 'date' ||
                       inp.type === 'text' && inp.value && inp.value.match(/\d{4}-\d{2}-\d{2}/);
            });

            if (dateInputs.length >= 2) {
                // Предполагаем, что первый - "от", второй - "до"
                if (!periodFrom) periodFrom = dateInputs[0];
                if (!periodTo) periodTo = dateInputs[1];
            }
        }

        // Стратегия 4: Ищем по структуре - два соседних input поля с датами
        if (!periodFrom || !periodTo) {
            const rows = document.querySelectorAll('.row, .form-row, div[class*="row"]');
            for (let row of rows) {
                const inputs = row.querySelectorAll('input');
                if (inputs.length >= 2) {
                    const rowText = row.textContent;
                    if (rowText.includes('Период от') && rowText.includes('Период до')) {
                        periodFrom = inputs[0];
                        periodTo = inputs[1];
                        break;
                    }
                }
            }
        }

        debugLog('Найденные поля', {
            periodFrom: periodFrom ? 'найдено' : 'не найдено',
            periodTo: periodTo ? 'найдено' : 'не найдено',
            periodFromValue: periodFrom?.value,
            periodToValue: periodTo?.value
        });

        if (periodFrom && periodTo && periodFrom === periodTo) {
            // debugLog('Выявлено совпадение полей периода, запускаем дополнительный поиск поля "Период до"');

            const directMax = document.querySelector('input[name="max_period"]');
            if (directMax && directMax !== periodFrom) {
                periodTo = directMax;
            } else {
                const containerMax = document.querySelector('.js_component_filter_item_max_period input');
                if (containerMax && containerMax !== periodFrom) {
                    periodTo = containerMax;
                }

                const candidates = Array.from(document.querySelectorAll('input')).filter(inp => {
                    if (inp === periodFrom) {
                        return false;
                    }
                    const name = inp.getAttribute('name')?.toLowerCase() || '';
                    const id = inp.id?.toLowerCase() || '';
                    return name.includes('max_period') || id.includes('max_period');
                });

                if (candidates.length) {
                    periodTo = candidates[0];
                }
            }

            debugLog('Результат повторного поиска поля "Период до"', {
                found: periodTo ? 'найдено' : 'не найдено',
                value: periodTo?.value,
                name: periodTo?.getAttribute('name'),
                id: periodTo?.id
            });
        }

        return { periodFrom, periodTo };
    }

    // Собираем параметры формы с учётом динамических имён
    function collectFormParams(form) {
        const params = new URLSearchParams();
        if (!form) {
            return params;
        }

        const formData = new FormData(form);
        const debugEntries = [];
        for (const [key, value] of formData.entries()) {
            if (value !== null && value !== undefined) {
                params.append(key, String(value));
                debugEntries.push({ key, value: String(value) });
            }
        }
        debugLog('Собраны параметры формы', debugEntries);
        return params;
    }

    // Функция для поиска кнопки "Применить"
    function findApplyButton() {
        const buttons = document.querySelectorAll('button');
        for (let btn of buttons) {
            if (btn.textContent && btn.textContent.includes('Применить')) {
                return btn;
            }
        }
        return null;
    }

    // Главная функция для автоматического разбиения
    function autoSplitPeriod(event) {
        // Получаем форму из события или ищем на странице
        let form = event?.target instanceof HTMLFormElement
            ? event.target
            : document.querySelector('form');

        try {
            let { periodFrom, periodTo } = findDateFields();

            const directPeriodFrom = document.querySelector('input[name="min_period"]');
            const directPeriodTo = document.querySelector('input[name="max_period"]');

            if (directPeriodFrom) periodFrom = directPeriodFrom;
            if (directPeriodTo) periodTo = directPeriodTo;

            if (!periodFrom || !periodTo) {
                alert('Браузер заблокировал часть вкладок. На странице появился список ссылок для ручного открытия.');
                safeSubmit(form, 'period-fields-not-found');
                return;
            }

            // Если форма не определена из события, берём из полей дат
            if (!form) {
                form = periodFrom.closest('form') || periodTo.closest('form');
            }

            let startDateStr = getInputValue(periodFrom);
            let endDateStr = getInputValue(periodTo);

            debugLog('Исходные значения периода', {
                startDateStr,
                endDateStr,
                periodFromName: periodFrom.getAttribute('name'),
                periodToName: periodTo.getAttribute('name')
            });

            if (!startDateStr) {
                startDateStr = periodFrom.value?.trim() || '';
            }

            if (!endDateStr) {
                endDateStr = periodTo.value?.trim() || '';
            }

            if (!startDateStr) {
                debugLog('Стартовая дата отсутствует, отправляем форму без авторазбиения');
                safeSubmit(form, 'missing-start-date');
                return;
            }

            if (!endDateStr) {
                const now = new Date();
                endDateStr = formatDate(now);
                debugLog('Дата окончания отсутствует, используем текущую дату', endDateStr);
            }

            const normalizedStartStr = ensureDateTimeString(startDateStr, '00:00:00');
            const normalizedEndStr = ensureDateTimeString(endDateStr, getCurrentTimeString());

            periodFrom.value = normalizedStartStr;
            periodFrom.setAttribute('value', normalizedStartStr);

            periodTo.value = normalizedEndStr;
            periodTo.setAttribute('value', normalizedEndStr);

            debugLog('Нормализованные значения периода', {
                start: normalizedStartStr,
                end: normalizedEndStr
            });

            const startDate = parseDate(normalizedStartStr);
            const endDate = parseDate(normalizedEndStr);

            if (!startDate || !endDate) {
                debugLog('Неверный формат даты после нормализации', {
                    start: normalizedStartStr,
                    end: normalizedEndStr
                });
                safeSubmit(form, 'invalid-date-format');
                return;
            }

            if (startDate > endDate) {
                alert('Браузер заблокировал часть вкладок. На странице появился список ссылок для ручного открытия.');
                safeSubmit(form, 'start-after-end');
                return;
            }

            const monthsDiff = monthsDifference(startDate, endDate);

            debugLog('Диапазон перед обработкой', {
                startDate: formatDate(startDate),
                endDate: formatDate(endDate),
                monthsDiff,
                maxSafeMonths: getMaxSafeMonths()
            });

            if (monthsDiff <= getMaxSafeMonths()) {
                safeSubmit(form, 'range-within-safe-limit');
                return;
            }

            const periods = splitPeriod(startDate, endDate);
            const hasSplit = periods.length > 1;

            const baseParams = collectFormParams(form);
            debugLog('Собранные параметры формы для split', {
                paramsCount: [...baseParams.keys()].length,
                params: Object.fromEntries(baseParams.entries())
            });

            const periodFromName = periodFrom.getAttribute('name');
            const periodToName = periodTo.getAttribute('name');
            const periodFromKeys = periodFromName ? [periodFromName] : ['min_period'];
            const periodToKeys = periodToName ? [periodToName] : ['max_period'];

            debugLog('Базовые ключи периода', { periodFromKeys, periodToKeys });

            const actionAttr = form?.getAttribute('action');
            const normalizedAction = actionAttr && actionAttr.trim() && actionAttr.trim() !== '#'
                ? actionAttr.trim()
                : `${window.location.origin}${window.location.pathname}`;
            const baseUrl = new URL(normalizedAction, window.location.href);

            const openedUrls = [];
            const blockedUrls = [];

            debugLog('Всего отрезков', periods.length);

            periods.forEach(period => {
                const params = new URLSearchParams(baseParams.toString());

                const startFormatted = formatDate(period.start);
                const endFormatted = formatDate(period.end);

                debugLog('Формируем ссылку для периода', {
                    periodStart: startFormatted,
                    periodEnd: endFormatted
                });

                periodFromKeys.forEach(key => {
                    params.delete(key);
                    params.append(key, startFormatted);
                });

                periodToKeys.forEach(key => {
                    params.delete(key);
                    params.append(key, endFormatted);
                });

                const finalUrl = new URL(baseUrl.toString());
                const queryString = params.toString();
                finalUrl.search = queryString;

                const targetUrl = finalUrl.toString();

                debugLog('Готовим вкладку', {
                    start: startFormatted,
                    end: endFormatted,
                    queryString,
                    url: targetUrl
                });

                const opened = window.open(targetUrl, '_blank');
                if (opened && !opened.closed) {
                    openedUrls.push(targetUrl);
                } else {
                    console.warn('Браузер заблокировал открытие вкладки', targetUrl);
                    blockedUrls.push(targetUrl);
                }
            });

            const summary = {
                totalPeriods: periods.length,
                openedCount: openedUrls.length,
                blockedCount: blockedUrls.length,
                openedUrls,
                blockedUrls,
                split: hasSplit
            };

            debugLog('Результат открытия вкладок', summary);

            if (!openedUrls.length && blockedUrls.length) {
                showBlockedNotice(blockedUrls, openedUrls, summary);
                return;
            }

            if (blockedUrls.length) {
                showBlockedNotice(blockedUrls, openedUrls, summary);
            } else {
                debugLog('Все вкладки открыты успешно');
            }
        } catch (error) {
            debugLog('Исключение во время авто-разбиения', error);
            safeSubmit(form, 'exception');
        }
    }

    function showBlockedNotice(blockedUrls, openedUrls = [], summary = null) {
        const existing = document.getElementById('autoSplitResultPanel');
        if (existing) existing.remove();

        const panel = document.createElement('div');
        panel.id = 'autoSplitResultPanel';
        panel.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 320px;
            max-height: 60vh;
            overflow-y: auto;
            background: #1f1f1f;
            color: #ffffff;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.4);
            padding: 18px 20px;
            z-index: 10001;
            font-family: sans-serif;
        `;

        const header = document.createElement('div');
        header.style.fontWeight = 'bold';
        header.style.marginBottom = '8px';
        header.textContent = 'Расширение: требуется открыть ссылки вручную';
        panel.appendChild(header);

        const info = document.createElement('p');
        info.style.fontSize = '13px';
        info.style.margin = '0 0 10px';
        info.textContent = 'Браузер заблокировал всплывающие окна. Разрешите их или откройте ссылки ниже вручную.';
        panel.appendChild(info);

        if (openedUrls.length) {
            const openedInfo = document.createElement('p');
            openedInfo.style.fontSize = '12px';
            openedInfo.style.margin = '0 0 10px';
            openedInfo.textContent = `Успешно открыто автоматически: ${openedUrls.length}`;
            panel.appendChild(openedInfo);
        }

        if (summary) {
            const summaryInfo = document.createElement('p');
            summaryInfo.style.fontSize = '11px';
            summaryInfo.style.margin = '0 0 8px';
            summaryInfo.style.color = '#bbbbbb';
            summaryInfo.textContent = `Всего периодов: ${summary.totalPeriods}. Успешно: ${summary.openedCount}, заблокировано: ${summary.blockedCount}.`;
            panel.appendChild(summaryInfo);
        }

        const listTitle = document.createElement('p');
        listTitle.style.fontSize = '12px';
        listTitle.style.margin = '0 0 6px';
        listTitle.textContent = 'Неоткрытые ссылки:';
        panel.appendChild(listTitle);

        const list = document.createElement('ul');
        list.style.margin = '0';
        list.style.padding = '0 0 0 18px';
        list.style.fontSize = '12px';

        blockedUrls.forEach((url, index) => {
            const item = document.createElement('li');
            item.style.marginBottom = '6px';

            const link = document.createElement('a');
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.style.color = '#4dd0e1';
            link.textContent = `Ссылка ${index + 1}`;

            item.appendChild(link);
            list.appendChild(item);
        });

        panel.appendChild(list);

        const actions = document.createElement('div');
        actions.style.marginTop = '12px';
        actions.style.display = 'flex';
        actions.style.justifyContent = 'space-between';
        actions.style.alignItems = 'center';

        const allowInfo = document.createElement('span');
        allowInfo.style.fontSize = '11px';
        allowInfo.style.color = '#bbbbbb';
        allowInfo.textContent = '⚠️ Разрешите pop-up для этого сайта и повторите.';
        actions.appendChild(allowInfo);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Закрыть';
        closeBtn.style.cssText = `
            background: #4dd0e1;
            border: none;
            border-radius: 6px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            color: #000000;
        `;
        closeBtn.addEventListener('click', () => panel.remove());

        actions.appendChild(closeBtn);
        panel.appendChild(actions);

        document.body.appendChild(panel);

        alert('Браузер заблокировал часть вкладок. На странице появился список ссылок для ручного открытия.');
    }

    // Добавляем кнопку в интерфейс
    function addSplitButton() {
        setTimeout(() => {
            const { periodFrom, periodTo } = findDateFields();

            if (!periodFrom || !periodTo) {
                debugLog('Не нашёл поля периода, повторю попытку позже');
                return;
            }

            const form = periodFrom.closest('form') || periodTo.closest('form') || document.querySelector('form');
            attachFormSubmitInterceptor(form);

            const applyButton = findApplyButton();

            // Кнопка авто-разбиения больше не добавляется на страницу
            // Управление теперь через popup расширения

            if (!document.getElementById(EXPORT_CSV_BUTTON_ID)) {
                const exportButton = createExportCsvButton();
                insertControlButton(exportButton, applyButton, periodTo, form);
                debugLog('Добавлена кнопка «Скачать CSV»');
                // Применяем настройку видимости
                toggleCsvButton();
            } else {
                // Если кнопка уже существует, обновляем её видимость
                toggleCsvButton();
            }

        }, 2000);
    }

    // Функции createAutoSplitButton() и updateAutoSplitButton() удалены
    // Управление авто-разбиением теперь только через popup расширения

    function createExportCsvButton() {
        const button = document.createElement('button');
        button.id = EXPORT_CSV_BUTTON_ID;
        button.textContent = 'Скачать CSV';
        button.type = 'button';
        button.className = 'btn btn-secondary';
        button.style.cssText = `
            margin: 0 0 10px 0;
            padding: 10px 20px;
            background: #4dd0e1;
            color: #000000;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            display: block;
            width: 100%;
            max-width: 300px;
        `;
        button.addEventListener('mouseover', () => {
            button.style.background = '#3abbd1';
        });
        button.addEventListener('mouseout', () => {
            button.style.background = '#4dd0e1';
        });
        button.addEventListener('click', exportLogsToCsv);
        return button;
    }

function insertControlButton(button, applyButton, periodTo, form) {
        if (!button) {
            return;
        }

        if (applyButton && applyButton.parentElement) {
            applyButton.parentElement.insertBefore(button, applyButton);
            return;
        }

        const container = periodTo?.parentElement;
        if (container) {
            const nextSibling = periodTo.nextElementSibling;
            if (nextSibling) {
                container.insertBefore(button, nextSibling);
            } else {
                container.appendChild(button);
            }
            return;
        }

        if (form) {
            form.insertBefore(button, form.firstChild);
            return;
        }

        document.body.appendChild(button);
    }

    function exportLogsToCsv() {
        try {
            const tableBody = document.querySelector('table.table-hover tbody');
            if (!tableBody) {
                alert('Не удалось найти строки для CSV: проверь фильтры.');
                return;
            }

            const rows = Array.from(tableBody.querySelectorAll('tr'));
            if (!rows.length) {
                alert('Данных для экспорта не найдено.');
                return;
            }

            const records = rows
                .map(extractLogRowData)
                .filter(Boolean);

            if (!records.length) {
                alert('Данных для экспорта не найдено.');
                return;
            }

            const columns = [
                { key: 'datetime', title: 'Дата и время' },
                { key: 'action', title: 'Действие' },
                { key: 'market_prices', title: 'Рыночные цены' },
                { key: 'I_money', title: 'I: Деньги' },
                { key: 'I_bank', title: 'I: Банк' },
                { key: 'I_donate', title: 'I: Донат' },
                { key: 'II_money', title: 'II: Деньги' },
                { key: 'II_bank', title: 'II: Банк' },
                { key: 'II_donate', title: 'II: Донат' },
                { key: 'I_ip_last', title: 'I: IP (последний)' },
                { key: 'I_ip_reg', title: 'I: IP (регистрационный)' },
                { key: 'II_ip_last', title: 'II: IP (последний)' },
                { key: 'II_ip_reg', title: 'II: IP (регистрационный)' }
            ];

            const csvContent = buildCsvContent(records, columns);
            const timestamp = formatTimestamp(new Date());
            const fileName = `logs_export_${timestamp}.csv`;

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);

            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            debugLog(`Экспорт CSV: ${records.length}`);
        } catch (error) {
            console.error(`${DEBUG_PREFIX} CSV export failed`, error);
            alert('Не удалось создать CSV. См. консоль.');
        }
    }
    function extractMarketPriceNotes(row) {
        if (!row) {
            return '';
        }

        const priceElements = Array.from(row.querySelectorAll('.item-price-display'));
        if (!priceElements.length) {
            return '';
        }

        const notes = priceElements
            .map(el => normalizeWhitespace(el.textContent))
            .filter(Boolean);

        if (!notes.length) {
            return '';
        }

        const uniqueNotes = Array.from(new Set(notes));
        return uniqueNotes.join(' | ');
    }

    function extractLogRowData(row) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 4) {
            return null;
        }

        const datetime = normalizeWhitespace(getVisibleText(cells[0]));
        let action = normalizeWhitespace(getVisibleText(cells[1]));

        if (!datetime && !action) {
            return null;
        }

        // Извлекаем accountIds и добавляем их к никам в тексте действия
        const accountIds = extractAccountIds(row, 2);
        if (accountIds.length > 0) {
            // Пытаемся найти ники и добавить к ним accountIds
            action = formatActionWithAccountIds(action, accountIds, row);
        }

        const financial = extractFinancialData(cells[2]);
        const ips = extractIpData(cells[3]);
        const notes = extractMarketPriceNotes(row);

        return {
            datetime,
            action,
            ...financial,
            ...ips,
            market_prices: notes
        };
    }

    function extractMarketPriceNotes(row) {
        if (!row) {
            return '';
        }

        const priceElements = Array.from(row.querySelectorAll('.item-price-display'));
        if (!priceElements.length) {
            return '';
        }

        const notes = priceElements
            .map(el => normalizeWhitespace(el.textContent))
            .filter(Boolean);

        if (!notes.length) {
            return '';
        }

        const uniqueNotes = Array.from(new Set(notes));
        return uniqueNotes.join(' | ');
    }
function getVisibleText(node) {
        if (!node) {
            return '';
        }

        const clone = node.cloneNode(true);
        clone.querySelectorAll('.item-price-display, .js_entry_format_button, .app-content-entry-format__button, .app__hidden').forEach(el => el.remove());
        clone.querySelectorAll('script, style').forEach(el => el.remove());
        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

        const text = clone.textContent || '';
        return text.replace(/\u00A0/g, ' ');
    }

    function normalizeWhitespace(value) {
        if (!value) {
            return '';
        }
        return value.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function extractFinancialData(cell) {
        const result = {
            I_money: '',
            I_bank: '',
            I_donate: '',
            II_money: '',
            II_bank: '',
            II_donate: ''
        };

        const codes = Array.from(cell.querySelectorAll(':scope > code'));

        let currentLabel = null;
        let values = [];

        const commit = () => {
            if (!currentLabel) {
                return;
            }
            const [money = '', bank = '', donate = ''] = values;
            result[`${currentLabel}_money`] = money;
            result[`${currentLabel}_bank`] = bank;
            result[`${currentLabel}_donate`] = donate;
            currentLabel = null;
            values = [];
        };

        codes.forEach(code => {
            const text = normalizeWhitespace(code.textContent);
            if (!text) {
                return;
            }

            if (text === 'I:' || text === 'II:') {
                commit();
                currentLabel = text.replace(':', '');
                values = [];
                return;
            }

            if (currentLabel) {
                values.push(text);
                if (values.length === 3) {
                    commit();
                }
            }
        });

        commit();
        return result;
    }

    function extractIpData(cell) {
        const result = {
            I_ip_last: '',
            I_ip_reg: '',
            II_ip_last: '',
            II_ip_reg: ''
        };

        const blocks = Array.from(cell.querySelectorAll('.table-ip'));
        blocks.forEach(block => {
            const labelText = normalizeWhitespace(block.querySelector('strong code')?.textContent || '');
            const label = labelText.replace(':', '');
            if (!label) {
                return;
            }

            const badges = Array.from(block.querySelectorAll('.badge')).map(el => normalizeWhitespace(el.textContent));
            const [last = '', reg = ''] = badges;

            const lastKey = `${label}_ip_last`;
            const regKey = `${label}_ip_reg`;

            if (last && lastKey in result) {
                result[lastKey] = last;
            }
            if (reg && regKey in result) {
                result[regKey] = reg;
            }
        });

        return result;
    }

    function buildCsvContent(records, columns) {
        const header = columns.map(col => csvEscape(col.title)).join(';');
        const rows = records.map(record => {
            return columns.map(col => csvEscape(record[col.key])).join(';');
        });
        return [header, ...rows].join('\r\n');
    }

    function csvEscape(value) {
        const text = value === undefined || value === null ? '' : String(value);
        const sanitized = text
            .replace(/\r?\n|\r/g, ' ')
            .replace(/\u00A0/g, ' ')
            .trim();
        return `"${sanitized.replace(/"/g, '""')}"`;
    }

    function formatTimestamp(date) {
        const pad = (num) => String(num).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    }

    runWhenReady(addSplitButton);

    // ============================================
    // ФУНКЦИОНАЛ ОТОБРАЖЕНИЯ ЦЕН ПРЕДМЕТОВ
    // ============================================

    // Конфигурация валют (BTC/ASC/EUR)
    let currencyRates = null;

    async function loadCurrencyRates() {
        try {
            const configUrl = chrome.runtime.getURL('currency_config.json');
            pricesLog('Загрузка валютного конфигурационного файла:', configUrl);
            const response = await fetch(configUrl);
            if (!response.ok) {
                pricesLog('Не удалось загрузить currency_config.json:', response.status);
                return;
            }

            currencyRates = await response.json();
            pricesLog('Валютный конфиг загружен', currencyRates);
        } catch (error) {
            pricesLog('Ошибка при загрузке currency_config.json:', error);
        }
    }

    function normalizePriceValue(value) {
        if (value === null || value === undefined) {
            return null;
        }

        if (typeof value === 'number' && Number.isFinite(value)) {
            return { min: value, max: value };
        }

        if (typeof value === 'object') {
            const candidates = [
                value.price,
                value.value,
                value.min ?? value[0] ?? value['1'],
                value.max ?? value[1] ?? value['2']
            ];

            let min = null;
            let max = null;

            for (const candidate of candidates) {
                const numeric = Number(candidate);
                if (Number.isFinite(numeric)) {
                    if (min === null || numeric < min) min = numeric;
                    if (max === null || numeric > max) max = numeric;
                }
            }

            if (min !== null && max !== null) {
                if (min > max) {
                    [min, max] = [max, min];
                }
                return { min, max };
            }
        }

        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return { min: numeric, max: numeric };
        }

        return null;
    }

    function formatPriceRange(range) {
        if (!range) return '';
        const min = range.min;
        const max = range.max;
        if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
        if (min === max) {
            return `$${formatPrice(min)}`;
        }
        return `$${formatPrice(min)} – $${formatPrice(max)}`;
    }

    function formatTotalPrice(range, quantity) {
        if (!range || !Number.isFinite(quantity)) return '';
        const min = range.min * quantity;
        const max = range.max * quantity;
        if (min === max) {
            return `$${formatPrice(min)}`;
        }
        return `$${formatPrice(min)} – $${formatPrice(max)}`;
    }

    function extractDualPrices(value) {
        if (!value || typeof value !== 'object') {
            const normalized = normalizePriceValue(value);
            return normalized ? { sa: normalized, vc: null } : null;
        }

        if (value.sa || value.vc) {
            const saPrice = normalizePriceValue(value.sa?.price);
            const vcPrice = normalizePriceValue(value.vc?.price);

            if (saPrice || vcPrice) {
                return { sa: saPrice, vc: vcPrice };
            }
            return null;
        }

        // Старый формат: {price, updated}
        if (value.price !== undefined) {
            const normalized = normalizePriceValue(value.price);
            return normalized ? { sa: normalized, vc: null } : null;
        }

        // Возможно это уже нормализованное значение {min, max}
        const normalized = normalizePriceValue(value);
        return normalized ? { sa: normalized, vc: null } : null;
    }

    // Форматирует обе цены: "$SA | VC$VC" или только одну если вторая отсутствует
    function formatDualPriceRange(dualPrice) {
        if (!dualPrice) return '';

        const saFormatted = dualPrice.sa ? formatPriceRange(dualPrice.sa) : null;
        const vcFormatted = dualPrice.vc ? `VC${formatPriceRange(dualPrice.vc).replace('$', '$')}` : null;

        if (saFormatted && vcFormatted) {
            return `${saFormatted} | ${vcFormatted}`;
        }
        return saFormatted || vcFormatted || '';
    }

    // Вычисляет итоговую цену для количества
    function calculateDualTotal(dualPrice, quantity) {
        if (!dualPrice || !Number.isFinite(quantity)) return null;

        const result = {};
        if (dualPrice.sa) {
            result.sa = {
                min: dualPrice.sa.min * quantity,
                max: dualPrice.sa.max * quantity
            };
        }
        if (dualPrice.vc) {
            result.vc = {
                min: dualPrice.vc.min * quantity,
                max: dualPrice.vc.max * quantity
            };
        }
        return (result.sa || result.vc) ? result : null;
    }

    async function loadItemPriceFile() {
        try {
            const pricesUrl = chrome.runtime.getURL('prices.jsonl');
            pricesLog('Загрузка цен из:', pricesUrl);

            const response = await fetch(pricesUrl);
            if (!response.ok) {
                pricesLog('Ошибка загрузки prices.jsonl:', response.status);
                return;
            }

            const text = await response.text();
            let loaded = 0;

            const tryAddItem = (id, value) => {
                const dualPrices = extractDualPrices(value);
                if (id && dualPrices) {
                    itemPricesMap.set(String(id), dualPrices);
                    loaded += 1;
                }
            };

            // Пытаемся сначала распарсить как цельный JSON (карта или массив)
            let parsedJson = null;
            try {
                parsedJson = JSON.parse(text);
            } catch (e) {
                parsedJson = null;
            }

            if (parsedJson) {
                if (Array.isArray(parsedJson)) {
                    for (const item of parsedJson) {
                        if (item && (item.id || item.name)) {
                            tryAddItem(item.id || item.name, item);
                        }
                    }
                } else if (typeof parsedJson === 'object') {
                    for (const [key, value] of Object.entries(parsedJson)) {
                        tryAddItem(key, value);
                    }
                }
            }

            // Если ничего не загрузили, пытаемся как JSONL
            if (loaded === 0) {
                const lines = text.split('\n').filter(line => line.trim());
                pricesLog('Найдено строк в prices.jsonl:', lines.length);

                for (const line of lines) {
                    try {
                        const item = JSON.parse(line);
                        if (item && (item.id || item.name)) {
                            tryAddItem(item.id || item.name, item);
                        }
                    } catch (e) {
                        console.warn(PRICES_PREFIX, 'Ошибка парсинга строки:', line, e);
                    }
                }
            }

            pricesLog(`Загружено цен предметов: ${itemPricesMap.size}`);
        } catch (error) {
            pricesLog('Ошибка при загрузке prices.jsonl:', error);
        }
    }

    async function loadCustomPriceFile() {
        try {
            const customUrl = chrome.runtime.getURL('custom_prices.json');
            const response = await fetch(customUrl);
            if (!response.ok) {
                // Тихо выходим, если файл не существует
                if (response.status !== 404) {
                    pricesLog('Не удалось загрузить custom_prices.json:', response.status);
                }
                return;
            }

            const text = (await response.text()).trim();
            let applied = 0;

            const tryAddItem = (id, value) => {
                const dualPrices = extractDualPrices(value);
                if (id && dualPrices) {
                    itemPricesMap.set(String(id), dualPrices);
                    applied += 1;
                }
            };

            let parsedJson = null;
            try {
                parsedJson = JSON.parse(text);
            } catch (e) {
                parsedJson = null;
            }

            if (parsedJson) {
                if (Array.isArray(parsedJson)) {
                    for (const item of parsedJson) {
                        if (item && (item.id || item.name)) {
                            tryAddItem(item.id || item.name, item);
                        }
                    }
                } else if (typeof parsedJson === 'object') {
                    for (const [key, value] of Object.entries(parsedJson)) {
                        tryAddItem(key, value);
                    }
                }
            }

            if (applied === 0) {
                const lines = text.split('\n').filter(line => line.trim());
                for (const line of lines) {
                    try {
                        const item = JSON.parse(line);
                        if (item && (item.id || item.name)) {
                            tryAddItem(item.id || item.name, item);
                        }
                    } catch (e) {
                        // ignore broken lines
                    }
                }
            }

            if (applied > 0) {
                pricesLog(`Применены кастомные цены из custom_prices.json: ${applied}`);
            }
        } catch (error) {
            pricesLog('Ошибка при загрузке custom_prices.json:', error);
        }
    }

    async function applyPriceOverrides() {
        try {
            if (!chrome?.storage?.local?.get) return;
            const { priceOverrides = null } = await chrome.storage.local.get('priceOverrides');
            if (!priceOverrides || typeof priceOverrides !== 'object') return;

            let applied = 0;
            Object.entries(priceOverrides).forEach(([itemId, rawValue]) => {
                const sourceValue =
                    rawValue && typeof rawValue === 'object' && rawValue.price !== undefined
                        ? rawValue.price
                        : rawValue;
                const normalized = normalizePriceValue(sourceValue);
                if (!normalized) return;
                itemPricesMap.set(String(itemId), normalized);
                applied += 1;
            });

            if (applied > 0) {
                pricesLog(`Применены кастомные цены: ${applied}`);
            }
        } catch (error) {
            pricesLog('Не удалось применить кастомные цены:', error);
        }
    }

    async function loadVehiclePriceFile() {
        try {
            const vehiclesUrl = chrome.runtime.getURL('vehicle_prices.jsonl');
            pricesLog('Загрузка цен транспорта из:', vehiclesUrl);

            const response = await fetch(vehiclesUrl);
            if (!response.ok) {
                pricesLog('Ошибка загрузки vehicle_prices.jsonl:', response.status);
                return;
            }

            const text = await response.text();
            let loaded = 0;

            const tryAddVehicle = (name, price, model) => {
                const normalizedPrice = normalizePriceValue(price);
                if (!name || !normalizedPrice) return;
                const key = normalizeVehicleName(name);
                if (!key) return;
                vehiclePricesMap.set(key, {
                    name,
                    model,
                    price: normalizedPrice
                });
                loaded += 1;
            };

            // Пытаемся распарсить как цельный JSON
            let parsedJson = null;
            try {
                parsedJson = JSON.parse(text);
            } catch (e) {
                parsedJson = null;
            }

            if (parsedJson) {
                if (Array.isArray(parsedJson)) {
                    for (const item of parsedJson) {
                        if (item && item.name && item.price !== undefined) {
                            tryAddVehicle(item.name, item.price, item.model);
                        }
                    }
                } else if (typeof parsedJson === 'object') {
                    for (const [key, value] of Object.entries(parsedJson)) {
                        if (value && typeof value === 'object' && value.price !== undefined) {
                            tryAddVehicle(value.name || key, value.price, value.model);
                        } else {
                            tryAddVehicle(key, value, null);
                        }
                    }
                }
            }

            // Если не загрузили, пробуем JSONL
            if (loaded === 0) {
                const lines = text.split('\n').filter(line => line.trim());
                pricesLog('Найдено строк в vehicle_prices.jsonl:', lines.length);

                for (const line of lines) {
                    try {
                        const item = JSON.parse(line);
                        if (item && item.name && item.price !== undefined) {
                            tryAddVehicle(item.name, item.price, item.model);
                        }
                    } catch (e) {
                        console.warn(PRICES_PREFIX, 'Ошибка парсинга строки транспорта:', line, e);
                    }
                }
            }

            pricesLog(`Загружено цен транспорта: ${vehiclePricesMap.size}`);
        } catch (error) {
            pricesLog('Ошибка при загрузке vehicle_prices.jsonl:', error);
        }
    }

    // Загрузка цен и валютной конфигурации
    async function loadPriceData() {
        try {
            await loadCurrencyRates();
            await loadItemPriceFile();
            await loadCustomPriceFile();
            await applyPriceOverrides();
            await loadVehiclePriceFile();

            initDonateItemHoverPreview();
            processItemPrices();
        } catch (error) {
            pricesLog('Ошибка при загрузке цен:', error);
        }
    }

    // Форматирование цены
    function formatPrice(price) {
        return new Intl.NumberFormat('ru-RU').format(price);
    }

    function normalizeVehicleName(name) {
        if (!name) return '';
        return name
            .replace(/["'`«»“”]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function cleanVehicleName(raw) {
        if (!raw) return '';

        let result = raw
            .replace(/^[\s(]+/, '') // убираем лишние пробелы и открывающие скобки в начале
            .replace(/[)\]]+\s*$/, '') // убираем закрывающие скобки в конце
            .replace(/["'`«»""\[\]\(\)]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Более точные паттерны, которые удаляют только служебные префиксы
        // но сохраняют названия транспорта, содержащие эти слова
        const cutPatterns = [
            /^.*?\bустановил\s+на\s+транспорт\s+/iu,
            /^.*?\bна\s+транспорт\s+(?!.*?\bавтомобил)/iu, // "на транспорт X" только если после нет "автомобиль"
            /^.*?\bна\s+машину\s+/iu,
            /^.*?\bна\s+авто\s+(?!\S)/iu, // "на авто" только если после пробел (не "автомобиль")
            /^.*?\b(?:купил|получил|потерял|продал)\s+транспорт\s+/iu,
            /^.*?\bтранспорт\s+(?=[A-Z])/u  // "транспорт X" только если после заглавная буква (название модели)
        ];

        for (const pattern of cutPatterns) {
            if (pattern.test(result)) {
                result = result.replace(pattern, '');
                break;
            }
        }

        result = result
            .replace(/^игрок\s+/iu, '')
            .replace(/^на\s+/iu, '') // удаляем "на " в начале (для "на Аэродиномичный автомобиль")
            .replace(/^[+\s,:-]+/, '')
            .replace(/\s+/g, ' ')
            .trim();

        return result;
    }

    function extractVehicleMatches(fullText) {
        if (!fullText || vehiclePricesMap.size === 0) {
            return [];
        }

        const matches = [];
        const unique = new Set();
        const vehiclePattern = /(?:^|[\s(])([^()\[\]\n]{2,}?)\s*(?:\(|\[)\s*id:\s*\d+/giu;
        let match;

        while ((match = vehiclePattern.exec(fullText)) !== null) {
            const rawName = match[1];
            const cleaned = cleanVehicleName(rawName);
            if (!cleaned) continue;
            if (cleaned.length > 60) continue; // отсекаем длинные предложения
            const lowerCleaned = cleaned.toLowerCase();
            if (lowerCleaned.includes('игрок') || lowerCleaned.includes('получил') || lowerCleaned.includes('потерял') || lowerCleaned.includes('деталь')) {
                continue;
            }

            const normalized = normalizeVehicleName(cleaned);
            if (!normalized || unique.has(normalized)) {
                continue;
            }

            const info = vehiclePricesMap.get(normalized);
            if (info && info.price) {
                matches.push({
                    name: info.name || cleaned,
                    price: info.price
                });
                unique.add(normalized);
            }
        }

        return matches;
    }

    const currencyPatterns = [
        {
            key: 'BTC',
            regex: /(\d+[\d\s,]*)\s*BTC/i
        },
        {
            key: 'ASC',
            regex: /(\d+[\d\s,]*)\s*ASC/i
        },
        {
            key: 'EUR',
            regex: /(\d+[\d\s,]*)\s*(?:EURO|ЕВРО)/i
        }
    ];

    // ============================================
    // HOVER ПРЕВЬЮ ДЛЯ DONATE-ПРЕДМЕТОВ ([id: 1234])
    // ============================================

    const DONATE_ITEM_PREVIEW_TOOLTIP_ID = 'ahDonateItemPreviewTooltip';

    const donateItemPreviewState = {
        initialized: false,
        hoverDelayTimer: null,
        hideDelayTimer: null,
        currentElement: null,
        currentToken: 0,
        lastMouseX: null,
        lastMouseY: null,
        cache: new Map(), // id -> { status: 'loaded'|'error', src }
        tooltip: null,
        img: null,
        loader: null
    };

    function ensureDonateItemPreviewStyles() {
        const styleId = 'ahDonateItemPreviewStyles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            [data-ah-preview-id]:hover {
                cursor: help;
            }

            #${DONATE_ITEM_PREVIEW_TOOLTIP_ID} {
                position: fixed;
                z-index: 2147483647;
                display: none;
                pointer-events: none;
                background: rgba(20, 20, 20, 0.92);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 10px;
                padding: 10px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.45);
                backdrop-filter: blur(6px);
                max-width: 240px;
            }

            #${DONATE_ITEM_PREVIEW_TOOLTIP_ID} .ahDonateItemPreviewLoader {
                color: rgba(255,255,255,0.8);
                font-size: 12px;
                white-space: nowrap;
            }

            #${DONATE_ITEM_PREVIEW_TOOLTIP_ID} img {
                display: block;
                max-width: 220px;
                max-height: 220px;
                width: auto;
                height: auto;
                border-radius: 8px;
            }
        `;

        document.head.appendChild(style);
    }

    function ensureDonateItemPreviewTooltip() {
        if (donateItemPreviewState.tooltip && donateItemPreviewState.tooltip.isConnected) return;

        ensureDonateItemPreviewStyles();

        const tooltip = document.createElement('div');
        tooltip.id = DONATE_ITEM_PREVIEW_TOOLTIP_ID;

        const loader = document.createElement('div');
        loader.className = 'ahDonateItemPreviewLoader';
        loader.textContent = 'Загрузка превью...';

        const img = document.createElement('img');
        img.alt = 'preview';
        img.decoding = 'async';
        img.style.display = 'none';

        tooltip.appendChild(loader);
        tooltip.appendChild(img);
        document.body.appendChild(tooltip);

        donateItemPreviewState.tooltip = tooltip;
        donateItemPreviewState.img = img;
        donateItemPreviewState.loader = loader;
    }

    function donateItemPreviewUrl(id) {
        return `https://cdn.azresources.cloud/projects/arizona-rp/assets/images/donate/${id}.png`;
    }

    async function loadDonateItemPreviewViaFetch(url) {
        const response = await fetch(url, { cache: 'force-cache', credentials: 'omit' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const blob = await response.blob();
        return URL.createObjectURL(blob);
    }

    function wrapPreviewTextInNode(textNode, previewId) {
        try {
            if (!textNode?.parentNode) return false;
            const text = String(textNode.nodeValue || '');
            const id = String(previewId || '').trim();
            if (!text || !/^\d+$/.test(id)) return false;

            const already = textNode.parentElement?.querySelector?.(`[data-ah-preview-id="${CSS.escape(id)}"]`);
            if (already) return true;

            const wrapRange = (start, end) => {
                if (!(Number.isInteger(start) && Number.isInteger(end))) return false;
                if (start < 0 || end <= start || end > text.length) return false;

                const middle = textNode.splitText(start);
                middle.splitText(end - start);

                const span = document.createElement('span');
                span.dataset.ahPreviewId = id;
                span.textContent = middle.nodeValue || '';
                middle.parentNode.replaceChild(span, middle);
                return true;
            };

            // Лучший вариант: подсветить именно "<название> (ID: N" после слова "предмет"
            // Учитываем варианты типа: "предмет (storage) Super Car Box (ID: 1852 ..."
            const byItemWord = new RegExp(
                `\\bпредмет\\s*(?:\\([^)]*\\)\\s*)?(.+?)\\s*\\(ID:\\s*${id}\\b`,
                'iu'
            );
            const m1 = text.match(byItemWord);
            if (m1 && typeof m1.index === 'number') {
                const full = m1[0];
                const namePart = m1[1] || '';
                const namePosInFull = full.indexOf(namePart);
                if (namePosInFull >= 0) {
                    const start = m1.index + namePosInFull;
                    const end = m1.index + full.length;
                    if (wrapRange(start, end)) return true;
                }
            }

            // Фоллбек: оборачиваем сам токен [id: N]
            const bracketRe = new RegExp(`\\[id:\\s*${id}\\]`, 'iu');
            const m2 = text.match(bracketRe);
            if (m2 && typeof m2.index === 'number') {
                if (wrapRange(m2.index, m2.index + m2[0].length)) return true;
            }

            // Фоллбек: оборачиваем сам токен (ID: N
            const parenRe = new RegExp(`\\(ID:\\s*${id}\\b`, 'iu');
            const m3 = text.match(parenRe);
            if (m3 && typeof m3.index === 'number') {
                if (wrapRange(m3.index, m3.index + m3[0].length)) return true;
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    function positionDonateItemPreviewTooltip(anchorElement, mouseX = null, mouseY = null) {
        const tooltip = donateItemPreviewState.tooltip;
        if (!tooltip || !anchorElement) return;

        const rect = anchorElement.getBoundingClientRect();
        const margin = 12;

        tooltip.style.left = '0px';
        tooltip.style.top = '0px';
        tooltip.style.display = 'block';

        const tooltipRect = tooltip.getBoundingClientRect();
        let left;
        let top;

        if (typeof mouseX === 'number' && typeof mouseY === 'number') {
            left = mouseX + margin;
            top = mouseY - 18;
        } else {
            left = rect.right + margin;
            top = rect.top;
        }

        if (left + tooltipRect.width > window.innerWidth - margin) {
            left = Math.max(margin, rect.left - tooltipRect.width - margin);
        }

        if (top + tooltipRect.height > window.innerHeight - margin) {
            top = Math.max(margin, window.innerHeight - tooltipRect.height - margin);
        }

        if (top < margin) top = margin;

        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;
    }

    function showDonateItemPreview(anchorElement) {
        if (!anchorElement) return;
        const previewId = String(anchorElement.dataset.ahPreviewId || '').trim();
        if (!/^\d+$/.test(previewId)) return;

        ensureDonateItemPreviewTooltip();

        donateItemPreviewState.currentElement = anchorElement;
        const token = ++donateItemPreviewState.currentToken;

        const tooltip = donateItemPreviewState.tooltip;
        const img = donateItemPreviewState.img;
        const loader = donateItemPreviewState.loader;

        if (!tooltip || !img || !loader) return;

        img.style.display = 'none';
        img.removeAttribute('src');
        loader.style.display = 'block';

        positionDonateItemPreviewTooltip(anchorElement, donateItemPreviewState.lastMouseX, donateItemPreviewState.lastMouseY);

        const cached = donateItemPreviewState.cache.get(previewId);
        if (cached?.status === 'loaded') {
            img.src = cached.src;
            img.style.display = 'block';
            loader.style.display = 'none';
            positionDonateItemPreviewTooltip(anchorElement, donateItemPreviewState.lastMouseX, donateItemPreviewState.lastMouseY);
            return;
        }

        const url = donateItemPreviewUrl(previewId);
        const preloader = new Image();
        preloader.decoding = 'async';

        preloader.onload = () => {
            donateItemPreviewState.cache.set(previewId, { status: 'loaded', src: url });
            if (token !== donateItemPreviewState.currentToken) return;
            img.src = url;
            img.style.display = 'block';
            loader.style.display = 'none';
            positionDonateItemPreviewTooltip(anchorElement, donateItemPreviewState.lastMouseX, donateItemPreviewState.lastMouseY);
        };

        preloader.onerror = () => {
            // В некоторых случаях img-src страницы может блокировать внешние домены.
            // Пробуем загрузить через fetch контент-скрипта и отдать blob URL.
            (async () => {
                try {
                    const blobUrl = await loadDonateItemPreviewViaFetch(url);
                    donateItemPreviewState.cache.set(previewId, { status: 'loaded', src: blobUrl });
                    if (token !== donateItemPreviewState.currentToken) return;
                    img.src = blobUrl;
                    img.style.display = 'block';
                    loader.style.display = 'none';
                    positionDonateItemPreviewTooltip(anchorElement, donateItemPreviewState.lastMouseX, donateItemPreviewState.lastMouseY);
                } catch (err) {
                    donateItemPreviewState.cache.set(previewId, { status: 'error', src: url });
                    if (token !== donateItemPreviewState.currentToken) return;
                    loader.textContent = 'Не удалось загрузить превью';
                    img.style.display = 'none';
                    positionDonateItemPreviewTooltip(anchorElement, donateItemPreviewState.lastMouseX, donateItemPreviewState.lastMouseY);
                }
            })();
        };

        preloader.src = url;
    }

    function hideDonateItemPreview() {
        const tooltip = donateItemPreviewState.tooltip;
        if (tooltip) tooltip.style.display = 'none';
        donateItemPreviewState.currentElement = null;
        donateItemPreviewState.currentToken += 1; // отменяем активную загрузку

        if (donateItemPreviewState.loader) {
            donateItemPreviewState.loader.textContent = 'Загрузка превью...';
            donateItemPreviewState.loader.style.display = 'block';
        }
        if (donateItemPreviewState.img) {
            donateItemPreviewState.img.style.display = 'none';
            donateItemPreviewState.img.removeAttribute('src');
        }
    }

    function initDonateItemHoverPreview() {
        if (donateItemPreviewState.initialized) return;
        donateItemPreviewState.initialized = true;

        const clearTimers = () => {
            if (donateItemPreviewState.hoverDelayTimer) {
                clearTimeout(donateItemPreviewState.hoverDelayTimer);
                donateItemPreviewState.hoverDelayTimer = null;
            }
            if (donateItemPreviewState.hideDelayTimer) {
                clearTimeout(donateItemPreviewState.hideDelayTimer);
                donateItemPreviewState.hideDelayTimer = null;
            }
        };

        const scheduleShow = (element) => {
            clearTimers();
            donateItemPreviewState.hoverDelayTimer = setTimeout(() => {
                donateItemPreviewState.hoverDelayTimer = null;
                showDonateItemPreview(element);
            }, 140);
        };

        const scheduleHide = () => {
            clearTimers();
            donateItemPreviewState.hideDelayTimer = setTimeout(() => {
                donateItemPreviewState.hideDelayTimer = null;
                hideDonateItemPreview();
            }, 160);
        };

        document.addEventListener('mouseover', (e) => {
            if (e.target?.closest?.('.item-price-display')) return;
            const element = e.target?.closest?.('[data-ah-preview-id]');
            if (!element) return;
            donateItemPreviewState.lastMouseX = typeof e.clientX === 'number' ? e.clientX : null;
            donateItemPreviewState.lastMouseY = typeof e.clientY === 'number' ? e.clientY : null;
            scheduleShow(element);
        }, true);

        document.addEventListener('mousemove', (e) => {
            donateItemPreviewState.lastMouseX = typeof e.clientX === 'number' ? e.clientX : null;
            donateItemPreviewState.lastMouseY = typeof e.clientY === 'number' ? e.clientY : null;

            const element = donateItemPreviewState.currentElement;
            if (!element) return;
            if (donateItemPreviewState.tooltip?.style.display !== 'block') return;
            positionDonateItemPreviewTooltip(element, donateItemPreviewState.lastMouseX, donateItemPreviewState.lastMouseY);
        }, true);

        document.addEventListener('mouseout', (e) => {
            const element = e.target?.closest?.('[data-ah-preview-id]');
            if (!element) return;
            const related = e.relatedTarget;
            if (related && element.contains(related)) return;
            scheduleHide();
        }, true);

        window.addEventListener('scroll', () => {
            const element = donateItemPreviewState.currentElement;
            if (element && donateItemPreviewState.tooltip?.style.display === 'block') {
                positionDonateItemPreviewTooltip(element);
            }
        }, true);

        window.addEventListener('resize', () => {
            const element = donateItemPreviewState.currentElement;
            if (element && donateItemPreviewState.tooltip?.style.display === 'block') {
                positionDonateItemPreviewTooltip(element);
            }
        });
    }

    // Поиск и добавление цен к предметам
    function processItemPrices() {
        if (pageIsHiding) return;
        // Регулярные выражения для поиска ID в разных форматах:
        // (ID: 1637  | или [id: 1425]
        const bracketIdPattern = /\[id:\s*(\d+)\]/ig; // [id: 1425] (реальный item id)
        const parenIdPattern = /\(ID:\s*(\d+)/ig;     // (ID: 1637 (обычно model id)

        // Регулярные выражения для поиска количества:
        // Кол-во 20 или количестве 3
        const quantityPatterns = [
            /Кол-во\s+(\d+)/i,           // Кол-во 20
            /количестве\s+(\d+)/i,       // количестве 3
            /в количестве\s+(\d+)/i      // в количестве 47
        ];

        // Получаем все текстовые узлы, содержащие ID
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null
        );

        const nodesToProcess = [];
        let node;
        while (node = walker.nextNode()) {
            const text = node.nodeValue;
            if (!text) continue;

            const upper = text.toUpperCase();
            const hasIdMarker = upper.includes('ID:');
            const hasCurrencyMarker = currencyRates && (
                upper.includes(' BTC') ||
                upper.includes(' ASC') ||
                upper.includes('€') ||
                upper.includes(' EUR') ||
                upper.includes(' ЕВРО')
            );
            const hasOldMarker = upper.includes('OLD:');
            const hasPriceMarker = /\$\d{4,}/.test(text); // Проверка на цены с 4+ цифрами

            if (hasIdMarker || hasCurrencyMarker || hasOldMarker || hasPriceMarker) {
                nodesToProcess.push(node);
            }
        }

        pricesLog(`Найдено узлов с "ID:" или "id:": ${nodesToProcess.length}`);

        let processedCount = 0;
        const processedNodes = new Set(); // Чтобы не обрабатывать один узел дважды
        const processedVehicleNodes = new Set();

        nodesToProcess.forEach(textNode => {
            // Пропускаем если уже обработали
            if (processedNodes.has(textNode)) {
            return;
        }

        const parent = textNode.parentElement;
        if (!parent) return;

        const originalValue = textNode.nodeValue || '';
        const formattedCurrencyValue = originalValue.replace(/\$(\d{4,})/g, (_, digits) => {
            const numeric = Number(digits);
            if (Number.isNaN(numeric)) {
                return `$${digits}`;
            }
            return `$${formatPrice(numeric)}`;
        });
        const formattedValueIntermediate = formattedCurrencyValue.replace(/OLD:(\d{4,})(\$?)/g, (_, digits, currency) => {
            const numeric = Number(digits);
            if (Number.isNaN(numeric)) {
                return `OLD:${digits}${currency || ''}`;
            }
            const formattedDigits = formatPrice(numeric);
            return `OLD:${formattedDigits}${currency || ''}`;
        });
        if (formattedValueIntermediate !== originalValue) {
            textNode.nodeValue = formattedValueIntermediate;
        }
        const formattedValue = originalValue.replace(/OLD:(\d{4,})(\$?)/g, (_, digits, currency) => {
            const numeric = Number(digits);
            if (Number.isNaN(numeric)) {
                return `OLD:${digits}${currency || ''}`;
            }
            const formattedDigits = formatPrice(numeric);
            return `OLD:${formattedDigits}${currency || ''}`;
        });
        if (formattedValue !== originalValue) {
            textNode.nodeValue = formattedValue;
        }

        const container = parent.closest('td') || parent;

        // Получаем весь текст строки/ячейки (а не вложенного span)
        const fullText = container.textContent;
        const fullTextLower = fullText ? fullText.toLowerCase() : '';

            // Проверяем, не добавлена ли уже цена
            if (container.querySelector('.item-price-display')) {
                return;
            }

            // Пропускаем строки с пополнением склада (там уже указана фактическая сумма)
            if (fullTextLower.includes('пополняет склад')) {
                return;
            }

            let itemId = null;
            let previewId = null;
            let quantity = 1; // По умолчанию количество = 1

            // Пробуем найти ID:
            // - если есть [id: N] — используем его (это item id, нужен для донат-картинок и корректной цены)
            // - иначе используем (ID: N)
            const bracketIds = [];
            const parenIds = [];

            let match;
            bracketIdPattern.lastIndex = 0;
            while ((match = bracketIdPattern.exec(fullText)) !== null) {
                bracketIds.push(match[1]);
            }

            parenIdPattern.lastIndex = 0;
            while ((match = parenIdPattern.exec(fullText)) !== null) {
                parenIds.push(match[1]);
            }

            if (bracketIds.length) {
                itemId = bracketIds[bracketIds.length - 1];
                previewId = itemId;
            } else if (parenIds.length) {
                const knownId = parenIds.find(id => itemPricesMap.has(String(id)));
                itemId = knownId || parenIds[parenIds.length - 1];
                previewId = itemId;
            }

            if (previewId) {
                // Стараемся повесить превью на сам текст предмета (не на всю строку)
                const wrapped = wrapPreviewTextInNode(textNode, previewId);
                if (!wrapped) {
                    container.dataset.ahPreviewId = String(previewId);
                }
            } else if (container.dataset.ahPreviewId) {
                delete container.dataset.ahPreviewId;
            }

            // Пробуем найти количество
            for (const pattern of quantityPatterns) {
                const match = fullText.match(pattern);
                if (match) {
                    quantity = parseInt(match[1], 10);
                    break;
                }
            }

            // Валютные операции (без ID предмета)
            if (!itemId && currencyRates) {
                for (const currency of currencyPatterns) {
                    const match = fullText.match(currency.regex);
                    if (match) {
                        const amountStr = match[1].replace(/\s|,/g, '');
                        const amount = Number(amountStr);
                        const rate = currencyRates[currency.key];

                        if (!Number.isNaN(amount) && rate) {
                            const total = amount * rate;
                            const parentNode = container;

                            const priceSpan = document.createElement('span');
                            priceSpan.className = 'item-price-display';
                            priceSpan.innerHTML = ` <span style="color: #ffc107; font-weight: bold;">💱 ${currency.key} → $${formatPrice(rate)} | Всего - $${formatPrice(total)}</span>`;

                            parentNode.appendChild(priceSpan);

                            processedNodes.add(textNode);
                            processedCount++;
                        }
                        break;
                    }
                }
                return;
            }

            if (itemId) {
                const priceEntry = itemPricesMap.get(itemId);
                const pricePerItem = normalizePriceValue(priceEntry);
                const dualPrice = (!pricePerItem && priceEntry && (priceEntry.sa || priceEntry.vc)) ? priceEntry : null;

                if (pricePerItem || dualPrice) {

                    // Ищем конец строки/элемента для вставки цены
                    let lastTextNode = textNode;
                    let currentNode = textNode;
                    let moneySpan = null; // Span с суммой денег

                    // Идём вперёд по соседним узлам, пока не найдём конец
                    while (currentNode.nextSibling) {
                        currentNode = currentNode.nextSibling;
                        if (currentNode.nodeType === Node.TEXT_NODE && currentNode.nodeValue.trim()) {
                            lastTextNode = currentNode;
                        }
                        // Ищем span с суммой денег (обычно зелёный цвет и содержит "$")
                        if (currentNode.nodeType === Node.ELEMENT_NODE &&
                            currentNode.tagName === 'SPAN' &&
                            currentNode.textContent.includes('$')) {
                            moneySpan = currentNode;
                        }
                    }

                    let priceText = '';
                    let totalText = '';

                    if (dualPrice) {
                        priceText = formatDualPriceRange(dualPrice) || '';
                        const totalDualPrice = calculateDualTotal(dualPrice, quantity);
                        totalText = totalDualPrice ? formatDualPriceRange(totalDualPrice) : '';
                    } else if (pricePerItem) {
                        priceText = formatPriceRange(pricePerItem);
                        const totalPrice = {
                            min: pricePerItem.min * quantity,
                            max: pricePerItem.max * quantity
                        };
                        totalText = formatPriceRange(totalPrice);
                    }

                    if (priceText) {
                        // Создаем элемент с ценой
                        const priceSpan = document.createElement('span');
                        priceSpan.className = 'item-price-display';

                        if (quantity > 1 && totalText) {
                            priceSpan.innerHTML = ` <span style="color: #4dd0e1; font-weight: bold;">💰 Цена 1 шт ~ ${priceText} | Всего (×${quantity}) - ${totalText}</span>`;
                        } else {
                            priceSpan.innerHTML = ` <span style="color: #4dd0e1; font-weight: bold;">💰 Цена 1 шт ~ ${priceText}</span>`;
                        }

                        const insertionRoot =
                            parent.tagName === 'SPAN' && parent.dataset && parent.dataset.ahPreviewId
                                ? (parent.parentElement || container)
                                : parent;

                        // Если есть span с суммой денег, вставляем СРАЗУ ПОСЛЕ него (в рамках insertionRoot)
                        if (moneySpan && moneySpan.parentNode === insertionRoot) {
                            if (moneySpan.nextSibling) {
                                insertionRoot.insertBefore(priceSpan, moneySpan.nextSibling);
                            } else {
                                insertionRoot.appendChild(priceSpan);
                            }
                        } else if (insertionRoot === parent) {
                            // Иначе вставляем после последнего текстового узла (в конец строки)
                            if (lastTextNode.nextSibling) {
                                insertionRoot.insertBefore(priceSpan, lastTextNode.nextSibling);
                            } else {
                                insertionRoot.appendChild(priceSpan);
                            }
                        } else {
                            // Если вышли из превью-обёртки — просто добавляем в конец td
                            container.appendChild(priceSpan);
                        }
                        processedCount++;
                        processedNodes.add(textNode);
                    }
                }
            }

            if (!processedVehicleNodes.has(textNode) && vehiclePricesMap.size > 0) {
                const existingVehiclePrice = container.querySelector('.vehicle-price-display');
                if (!existingVehiclePrice) {
                    // Проверяем, есть ли в тексте паттерн транспорта (id: число)
                    const hasVehiclePattern = /(?:\(id:\s*\d+|\[id:\s*\d+\])/i.test(fullText);
                    if (hasVehiclePattern) {
                        const foundVehicles = [];

                        // Проходим по всем машинам из базы
                        for (const [normalizedKey, vehicleInfo] of vehiclePricesMap.entries()) {
                            const vehicleName = vehicleInfo.name;
                            if (!vehicleName) continue;

                            // Ищем название машины в тексте (без учета регистра)
                            // Используем границы слов, чтобы не находить название внутри никнеймов
                            const escapedName = vehicleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            // Проверяем что перед и после названия нет букв, цифр или подчёркиваний
                            const regex = new RegExp(`(?:^|[^a-zA-Zа-яА-ЯёЁ0-9_])${escapedName}(?:[^a-zA-Zа-яА-ЯёЁ0-9_]|$)`, 'i');
                            if (regex.test(fullText)) {
                                foundVehicles.push({
                                    name: vehicleName,
                                    price: vehicleInfo.price
                                });
                            }
                        }

                        if (foundVehicles.length > 0) {
                            // Сортируем по длине названия (от длинного к короткому)
                            foundVehicles.sort((a, b) => b.name.length - a.name.length);

                            // Фильтруем: убираем короткие названия, которые являются подстрокой более длинных
                            const filtered = [];
                            const addedNames = new Set();

                            for (const vehicle of foundVehicles) {
                                const lowerName = vehicle.name.toLowerCase();

                                // Проверяем, не является ли это название подстрокой уже добавленного
                                let isSubstring = false;
                                for (const added of addedNames) {
                                    if (added.includes(lowerName) && added !== lowerName) {
                                        isSubstring = true;
                                        break;
                                    }
                                }

                                if (!isSubstring && !addedNames.has(lowerName)) {
                                    filtered.push(vehicle);
                                    addedNames.add(lowerName);
                                }
                            }

                            if (filtered.length > 0) {
                                const priceSpan = document.createElement('span');
                                priceSpan.className = 'item-price-display vehicle-price-display';
                                const parts = filtered
                                    .map(vehicle => {
                                const normalizedPrice = normalizePriceValue(vehicle.price);
                                const formatted = normalizedPrice ? formatPriceRange(normalizedPrice) : '';
                                return formatted ? `${vehicle.name} ~ ${formatted}` : vehicle.name;
                            })
                                    .filter(Boolean);
                                priceSpan.innerHTML = ` <span style="color: #ffb74d; font-weight: bold;">🚗 ${parts.join(' | ')}</span>`;

                                parent.appendChild(priceSpan);

                                processedVehicleNodes.add(textNode);
                                processedNodes.add(textNode);
                                processedCount++;
                            }
                        }
                    }
                }
            }
        });

        pricesLog(`Добавлено цен на страницу: ${processedCount}`);
    }

    // Запуск загрузки цен при загрузке страницы
    runWhenReady(loadPriceData);

    // ============================================
    // ОБХОД БАГА СО СКЛАДОМ ДОМА + ПОИСК ПОДОЗРИТЕЛЬНЫХ
    // ============================================

    function collectLogTypes(params) {
        const types = [];
        params.forEach((value, key) => {
            if (key.toLowerCase().startsWith('type')) {
                types.push(value);
            }
        });
        return types;
    }

    function isHouseCombinedUrl(urlLike) {
        try {
            const params = new URL(urlLike, window.location.href).searchParams;
            const types = collectLogTypes(params);
            return types.includes(HOUSE_FROM_TYPE) && types.includes(HOUSE_TO_TYPE);
        } catch (error) {
            console.warn(DEBUG_PREFIX, 'Не удалось определить типы для URL', urlLike, error);
            return false;
        }
    }

    function buildHouseUrlWithSingleType(urlLike, typeValue) {
        const parsed = new URL(urlLike, window.location.href);
        Array.from(parsed.searchParams.keys()).forEach(key => {
            if (key.toLowerCase().startsWith('type')) {
                parsed.searchParams.delete(key);
            }
        });
        parsed.searchParams.append('type[]', typeValue);
        return parsed.toString();
    }

    function buildHouseCombinedUrl(urlLike, pageNumber = null) {
        const parsed = new URL(urlLike, window.location.href);
        Array.from(parsed.searchParams.keys()).forEach(key => {
            if (key.toLowerCase().startsWith('type')) {
                parsed.searchParams.delete(key);
            }
        });
        parsed.searchParams.append('type[]', HOUSE_FROM_TYPE);
        parsed.searchParams.append('type[]', HOUSE_TO_TYPE);
        if (Number.isFinite(pageNumber)) {
            parsed.searchParams.set('page', String(pageNumber));
        }
        return parsed.toString();
    }

    function getRowTimestamp(row) {
        const cell = row?.cells?.[0];
        return (cell?.textContent || '').trim();
    }

    function sortRowsByTimestampDesc(rows) {
        rows.sort((a, b) => getRowTimestamp(b).localeCompare(getRowTimestamp(a)));
    }

    async function fetchHousePage(url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
            const response = await fetch(url, {
                credentials: 'include',
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Статус ответа: ${response.status}`);
            }

            const htmlText = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, 'text/html');

            const rowNodes = Array.from(doc.querySelectorAll('table.table-hover tbody tr'));
            const importedRows = rowNodes.map(row => document.importNode(row, true));
            const paginationMeta = extractPaginationMeta(doc, null, null);

            return {
                rows: importedRows,
                rowCount: importedRows.length,
                paginationMeta
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function downloadHouseMergedPage(urlLike) {
        const pageNumber = getPageNumberFromUrl(urlLike) ?? 1;
        const [fromData, toData] = await Promise.all([
            fetchHousePage(buildHouseUrlWithSingleType(urlLike, HOUSE_FROM_TYPE)),
            fetchHousePage(buildHouseUrlWithSingleType(urlLike, HOUSE_TO_TYPE))
        ]);

        const combinedRows = [...(fromData.rows || []), ...(toData.rows || [])];
        sortRowsByTimestampDesc(combinedRows);

        const fragment = document.createDocumentFragment();
        combinedRows.forEach(row => fragment.appendChild(row));

        const totalPages = Math.max(
            fromData.paginationMeta?.totalPages || 0,
            toData.paginationMeta?.totalPages || 0
        ) || null;

        const pageLimit = fromData.paginationMeta?.pageLimit
            || toData.paginationMeta?.pageLimit
            || null;

        const nextUrl = totalPages && pageNumber < totalPages
            ? buildHouseCombinedUrl(urlLike, pageNumber + 1)
            : null;

        return {
            fragment,
            rowCount: combinedRows.length,
            nextUrl,
            totalPages,
            currentPage: pageNumber,
            pageLimit
        };
    }

    // ============================================
    // ОБЪЕДИНЕНИЕ ПРОИЗВОЛЬНЫХ URL (MULTI-URL MERGER)
    // ============================================

    const MULTI_URL_STORAGE_KEY = 'logsparser_multi_url_configs'; // Изменено на множественное число
    const MULTI_URL_PANEL_ID = 'multiUrlMergerPanel';
    const DEFAULT_MULTI_URL_BUTTON_ENABLED = false;
    let multiUrlButtonEnabled = DEFAULT_MULTI_URL_BUTTON_ENABLED;

    const multiUrlState = {
        enabled: false,
        additionalUrls: [], // Массив дополнительных URL для объединения
        baseUrl: null
    };

    // Нормализация URL для надежного сравнения (удаляет page и сортирует параметры)
    function normalizeUrlForComparison(urlString) {
        try {
            const url = new URL(urlString, window.location.href);
            const params = new URLSearchParams(url.search);

            // Удаляем параметр page, так как он динамический
            params.delete('page');

            // Сортируем параметры для стабильного сравнения
            const sortedParams = new URLSearchParams(
                Array.from(params.entries()).sort((a, b) => {
                    if (a[0] === b[0]) {
                        return a[1].localeCompare(b[1]);
                    }
                    return a[0].localeCompare(b[0]);
                })
            );

            // Возвращаем путь + отсортированные параметры
            return url.origin + url.pathname + '?' + sortedParams.toString();
        } catch (error) {
            console.warn(DEBUG_PREFIX, 'Не удалось нормализовать URL', urlString, error);
            return urlString;
        }
    }

    // Получение нормализованного URL текущей страницы
    function getCurrentNormalizedUrl() {
        return normalizeUrlForComparison(window.location.href);
    }

    // Загрузка сохраненной конфигурации из localStorage для текущей страницы
    function loadMultiUrlConfig() {
        try {
            const saved = localStorage.getItem(MULTI_URL_STORAGE_KEY);
            if (saved) {
                const allConfigs = JSON.parse(saved); // Это объект { [normalizedUrl]: { enabled, additionalUrls } }
                const currentUrl = getCurrentNormalizedUrl();
                const config = allConfigs[currentUrl];

                if (config && Array.isArray(config.additionalUrls)) {
                    multiUrlState.enabled = config.enabled || false;
                    multiUrlState.additionalUrls = config.additionalUrls.filter(url => url && url.trim());
                    multiUrlState.baseUrl = currentUrl;
                    console.log(DEBUG_PREFIX, 'Загружена конфигурация Multi-URL для', currentUrl, ':', multiUrlState);
                } else {
                    // Для этой страницы нет конфигурации
                    multiUrlState.enabled = false;
                    multiUrlState.additionalUrls = [];
                    multiUrlState.baseUrl = currentUrl;
                    console.log(DEBUG_PREFIX, 'Конфигурация Multi-URL для текущей страницы не найдена');
                }
            } else {
                multiUrlState.enabled = false;
                multiUrlState.additionalUrls = [];
                multiUrlState.baseUrl = getCurrentNormalizedUrl();
            }
        } catch (error) {
            console.warn(DEBUG_PREFIX, 'Не удалось загрузить конфигурацию Multi-URL', error);
            multiUrlState.enabled = false;
            multiUrlState.additionalUrls = [];
            multiUrlState.baseUrl = getCurrentNormalizedUrl();
        }
    }

    // Сохранение конфигурации в localStorage для текущей страницы
    function saveMultiUrlConfig() {
        try {
            // Загружаем все существующие конфигурации
            const saved = localStorage.getItem(MULTI_URL_STORAGE_KEY);
            const allConfigs = saved ? JSON.parse(saved) : {};

            const currentUrl = getCurrentNormalizedUrl();

            // Обновляем конфигурацию для текущей страницы
            if (multiUrlState.enabled && multiUrlState.additionalUrls.length > 0) {
                allConfigs[currentUrl] = {
                    enabled: multiUrlState.enabled,
                    additionalUrls: multiUrlState.additionalUrls
                };
            } else {
                // Если отключено или нет URL - удаляем конфигурацию для этой страницы
                delete allConfigs[currentUrl];
            }

            // Сохраняем все конфигурации
            localStorage.setItem(MULTI_URL_STORAGE_KEY, JSON.stringify(allConfigs));
            console.log(DEBUG_PREFIX, 'Сохранена конфигурация Multi-URL для', currentUrl, ':', multiUrlState);
        } catch (error) {
            console.warn(DEBUG_PREFIX, 'Не удалось сохранить конфигурацию Multi-URL', error);
        }
    }

    // Проверка, активна ли функция объединения нескольких URL для текущей страницы
    function isMultiUrlCombinedActive() {
        return multiUrlButtonEnabled &&
               multiUrlState.enabled &&
               multiUrlState.additionalUrls.length > 0 &&
               multiUrlState.baseUrl === getCurrentNormalizedUrl();
    }

    // Загрузка страницы по URL
    async function fetchPageRows(url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
            const response = await fetch(url, {
                credentials: 'include',
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Статус ответа: ${response.status}`);
            }

            const htmlText = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, 'text/html');

            const rowNodes = Array.from(doc.querySelectorAll('table.table-hover tbody tr'));
            const importedRows = rowNodes.map(row => document.importNode(row, true));
            const paginationMeta = extractPaginationMeta(doc, null, null);

            return {
                rows: importedRows,
                rowCount: importedRows.length,
                paginationMeta
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // Обновление номера страницы в URL
    function updateUrlPageNumber(urlString, pageNumber) {
        try {
            const parsed = new URL(urlString, window.location.href);
            if (Number.isFinite(pageNumber) && pageNumber > 0) {
                parsed.searchParams.set('page', String(pageNumber));
            } else {
                parsed.searchParams.delete('page');
            }
            return parsed.toString();
        } catch (error) {
            console.warn(DEBUG_PREFIX, 'Не удалось обновить номер страницы в URL', error);
            return urlString;
        }
    }

    // Основная функция объединения данных из нескольких URL
    async function downloadMultiUrlMergedPage(baseUrl) {
        const pageNumber = getPageNumberFromUrl(baseUrl) ?? 1;

        // Создаем массив промисов для загрузки базового URL и всех дополнительных
        const urlsToFetch = [baseUrl, ...multiUrlState.additionalUrls.map(url => updateUrlPageNumber(url, pageNumber))];

        console.log(DEBUG_PREFIX, `Загрузка страницы ${pageNumber} из ${urlsToFetch.length} источников`);

        const results = await Promise.all(urlsToFetch.map(url => fetchPageRows(url)));

        // Объединяем все строки
        const combinedRows = [];
        results.forEach(result => {
            if (result.rows && result.rows.length > 0) {
                combinedRows.push(...result.rows);
            }
        });

        // Сортируем по timestamp (первая колонка)
        sortRowsByTimestampDesc(combinedRows);

        // Создаем фрагмент с объединенными строками
        const fragment = document.createDocumentFragment();
        combinedRows.forEach(row => fragment.appendChild(row));

        // Определяем общее количество страниц (берем максимальное)
        const totalPages = Math.max(
            ...results.map(r => r.paginationMeta?.totalPages || 0)
        ) || null;

        const pageLimit = results[0]?.paginationMeta?.pageLimit || null;

        // URL для следующей страницы
        const nextUrl = totalPages && pageNumber < totalPages
            ? updateUrlPageNumber(baseUrl, pageNumber + 1)
            : null;

        return {
            fragment,
            rowCount: combinedRows.length,
            nextUrl,
            totalPages,
            currentPage: pageNumber,
            pageLimit
        };
    }

    // Диалог для управления всеми конфигурациями
    function showAllConfigsDialog() {
        const existing = document.getElementById('multiUrlAllConfigsDialog');
        if (existing) {
            existing.remove();
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'multiUrlAllConfigsDialog';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 10001;
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(4px);
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            border: 2px solid #4a90e2;
            border-radius: 12px;
            padding: 20px;
            max-width: 700px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            color: #fff;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 2px solid rgba(255, 255, 255, 0.2);
        `;

        const title = document.createElement('h3');
        title.textContent = '📋 Все сохраненные конфигурации';
        title.style.cssText = 'margin: 0; font-size: 18px; font-weight: 600;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = `
            background: rgba(255, 255, 255, 0.1);
            border: none;
            color: #fff;
            font-size: 24px;
            cursor: pointer;
            width: 32px;
            height: 32px;
            border-radius: 6px;
            transition: all 0.2s;
        `;
        closeBtn.onmouseover = () => closeBtn.style.background = 'rgba(255, 255, 255, 0.2)';
        closeBtn.onmouseout = () => closeBtn.style.background = 'rgba(255, 255, 255, 0.1)';
        closeBtn.onclick = () => overlay.remove();

        header.appendChild(title);
        header.appendChild(closeBtn);
        dialog.appendChild(header);

        // Загружаем все конфигурации
        const saved = localStorage.getItem(MULTI_URL_STORAGE_KEY);
        const allConfigs = saved ? JSON.parse(saved) : {};
        const configEntries = Object.entries(allConfigs);

        if (configEntries.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = `
                text-align: center;
                padding: 40px 20px;
                opacity: 0.7;
                font-size: 14px;
            `;
            emptyMsg.textContent = 'Нет сохраненных конфигураций';
            dialog.appendChild(emptyMsg);
        } else {
            const list = document.createElement('div');
            list.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';

            configEntries.forEach(([normalizedUrl, config]) => {
                const item = document.createElement('div');
                item.style.cssText = `
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 8px;
                    padding: 12px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                `;

                const urlDisplay = document.createElement('div');
                urlDisplay.style.cssText = `
                    font-size: 11px;
                    word-break: break-all;
                    margin-bottom: 8px;
                    padding: 8px;
                    background: rgba(0, 0, 0, 0.2);
                    border-radius: 4px;
                    font-family: monospace;
                `;
                urlDisplay.textContent = normalizedUrl;

                const info = document.createElement('div');
                info.style.cssText = 'font-size: 12px; margin-bottom: 8px; opacity: 0.9;';
                info.innerHTML = `
                    <strong>Дополнительных URL:</strong> ${config.additionalUrls?.length || 0}<br>
                    ${config.enabled ? '<span style="color: #34c759;">✓ Активно</span>' : '<span style="opacity: 0.6;">○ Неактивно</span>'}
                `;

                const actions = document.createElement('div');
                actions.style.cssText = 'display: flex; gap: 8px; margin-top: 10px;';

                const viewBtn = document.createElement('button');
                viewBtn.textContent = '👁 Просмотр';
                viewBtn.style.cssText = `
                    flex: 1;
                    padding: 6px;
                    border: 1px solid rgba(74, 144, 226, 0.5);
                    background: rgba(74, 144, 226, 0.2);
                    color: #fff;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                    transition: all 0.2s;
                `;
                viewBtn.onmouseover = () => viewBtn.style.background = 'rgba(74, 144, 226, 0.3)';
                viewBtn.onmouseout = () => viewBtn.style.background = 'rgba(74, 144, 226, 0.2)';
                viewBtn.onclick = () => {
                    alert(`Дополнительные URL:\n\n${config.additionalUrls.join('\n\n')}`);
                };

                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '🗑 Удалить';
                deleteBtn.style.cssText = `
                    flex: 1;
                    padding: 6px;
                    border: 1px solid rgba(255, 59, 48, 0.5);
                    background: rgba(255, 59, 48, 0.2);
                    color: #fff;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                    transition: all 0.2s;
                `;
                deleteBtn.onmouseover = () => deleteBtn.style.background = 'rgba(255, 59, 48, 0.3)';
                deleteBtn.onmouseout = () => deleteBtn.style.background = 'rgba(255, 59, 48, 0.2)';
                deleteBtn.onclick = () => {
                    if (confirm('Удалить эту конфигурацию?')) {
                        delete allConfigs[normalizedUrl];
                        localStorage.setItem(MULTI_URL_STORAGE_KEY, JSON.stringify(allConfigs));
                        overlay.remove();
                        showAllConfigsDialog(); // Перезагружаем диалог
                    }
                };

                actions.appendChild(viewBtn);
                actions.appendChild(deleteBtn);

                item.appendChild(urlDisplay);
                item.appendChild(info);
                item.appendChild(actions);
                list.appendChild(item);
            });

            dialog.appendChild(list);

            // Кнопка очистки всех конфигураций
            if (configEntries.length > 0) {
                const clearAllBtn = document.createElement('button');
                clearAllBtn.textContent = '🗑 Удалить все конфигурации';
                clearAllBtn.style.cssText = `
                    width: 100%;
                    padding: 10px;
                    margin-top: 15px;
                    border: 1px solid rgba(255, 59, 48, 0.5);
                    background: rgba(255, 59, 48, 0.2);
                    color: #fff;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 500;
                    transition: all 0.2s;
                `;
                clearAllBtn.onmouseover = () => clearAllBtn.style.background = 'rgba(255, 59, 48, 0.3)';
                clearAllBtn.onmouseout = () => clearAllBtn.style.background = 'rgba(255, 59, 48, 0.2)';
                clearAllBtn.onclick = () => {
                    if (confirm(`Удалить все ${configEntries.length} конфигураций?`)) {
                        localStorage.removeItem(MULTI_URL_STORAGE_KEY);
                        overlay.remove();
                        alert('Все конфигурации удалены. Перезагрузите страницу для применения изменений.');
                    }
                };
                dialog.appendChild(clearAllBtn);
            }
        }

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Закрытие по клику на overlay
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        };
    }

    // Создание UI панели для управления Multi-URL
    function createMultiUrlPanel() {
        // Проверяем, не создана ли уже панель
        if (document.getElementById(MULTI_URL_PANEL_ID)) {
            return;
        }

        const panel = document.createElement('div');
        panel.id = MULTI_URL_PANEL_ID;
        panel.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            border: 2px solid #4a90e2;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            z-index: 10000;
            min-width: 400px;
            max-width: 600px;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 2px solid rgba(255, 255, 255, 0.2);
        `;

        const title = document.createElement('h3');
        title.textContent = '🔗 Объединение логов';
        title.style.cssText = 'margin: 0; font-size: 18px; font-weight: 600;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = `
            background: rgba(255, 255, 255, 0.1);
            border: none;
            color: #fff;
            font-size: 24px;
            cursor: pointer;
            width: 32px;
            height: 32px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        `;
        closeBtn.onmouseover = () => closeBtn.style.background = 'rgba(255, 255, 255, 0.2)';
        closeBtn.onmouseout = () => closeBtn.style.background = 'rgba(255, 255, 255, 0.1)';
        closeBtn.onclick = () => panel.remove();

        header.appendChild(title);
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // Информация
        const info = document.createElement('div');
        info.style.cssText = `
            margin-bottom: 15px;
            padding: 12px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            font-size: 13px;
            line-height: 1.5;
        `;
        info.innerHTML = `
            <strong>💡 Конфигурация привязана к текущей странице</strong><br>
            <span style="font-size: 11px; opacity: 0.8; margin-top: 5px; display: block;">
                Каждая страница с уникальными параметрами имеет свою отдельную конфигурацию объединения.
            </span>
        `;
        panel.appendChild(info);

        // Контейнер для полей ввода URL
        const urlsContainer = document.createElement('div');
        urlsContainer.id = 'multiUrlInputsContainer';
        panel.appendChild(urlsContainer);

        // Функция для создания поля ввода URL
        function createUrlInput(index, value = '') {
            const inputGroup = document.createElement('div');
            inputGroup.style.cssText = `
                margin-bottom: 12px;
                display: flex;
                gap: 8px;
            `;

            const label = document.createElement('label');
            label.textContent = `URL ${index + 1}:`;
            label.style.cssText = `
                min-width: 60px;
                display: flex;
                align-items: center;
                font-weight: 500;
                font-size: 13px;
            `;

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'https://arizonarp.logsparser.info/?...';
            input.value = value;
            input.style.cssText = `
                flex: 1;
                padding: 8px 12px;
                border: 1px solid rgba(255, 255, 255, 0.3);
                border-radius: 6px;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                font-size: 12px;
                transition: all 0.2s;
            `;
            input.onfocus = () => {
                input.style.background = 'rgba(255, 255, 255, 0.15)';
                input.style.borderColor = '#4a90e2';
            };
            input.onblur = () => {
                input.style.background = 'rgba(255, 255, 255, 0.1)';
                input.style.borderColor = 'rgba(255, 255, 255, 0.3)';
            };

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '−';
            removeBtn.style.cssText = `
                width: 32px;
                height: 32px;
                border: none;
                background: rgba(255, 59, 48, 0.8);
                color: #fff;
                border-radius: 6px;
                cursor: pointer;
                font-size: 20px;
                transition: all 0.2s;
            `;
            removeBtn.onmouseover = () => removeBtn.style.background = 'rgba(255, 59, 48, 1)';
            removeBtn.onmouseout = () => removeBtn.style.background = 'rgba(255, 59, 48, 0.8)';
            removeBtn.onclick = () => {
                inputGroup.remove();
                updateUrlLabels();
            };

            inputGroup.appendChild(label);
            inputGroup.appendChild(input);
            inputGroup.appendChild(removeBtn);

            return inputGroup;
        }

        // Обновление номеров URL после удаления
        function updateUrlLabels() {
            const inputs = urlsContainer.querySelectorAll('label');
            inputs.forEach((label, index) => {
                label.textContent = `URL ${index + 1}:`;
            });
        }

        // Добавляем начальные поля (или загруженные из конфигурации)
        if (multiUrlState.additionalUrls.length > 0) {
            multiUrlState.additionalUrls.forEach((url, index) => {
                urlsContainer.appendChild(createUrlInput(index, url));
            });
        } else {
            // Добавляем 2 пустых поля по умолчанию
            for (let i = 0; i < 2; i++) {
                urlsContainer.appendChild(createUrlInput(i));
            }
        }

        // Кнопка добавления нового URL
        const addUrlBtn = document.createElement('button');
        addUrlBtn.textContent = '+ Добавить URL';
        addUrlBtn.style.cssText = `
            width: 100%;
            padding: 10px;
            margin-bottom: 15px;
            border: 2px dashed rgba(255, 255, 255, 0.3);
            background: transparent;
            color: #fff;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
        `;
        addUrlBtn.onmouseover = () => {
            addUrlBtn.style.background = 'rgba(255, 255, 255, 0.1)';
            addUrlBtn.style.borderColor = 'rgba(255, 255, 255, 0.5)';
        };
        addUrlBtn.onmouseout = () => {
            addUrlBtn.style.background = 'transparent';
            addUrlBtn.style.borderColor = 'rgba(255, 255, 255, 0.3)';
        };
        addUrlBtn.onclick = () => {
            const currentCount = urlsContainer.querySelectorAll('div').length;
            if (currentCount < 5) { // Максимум 5 дополнительных URL
                urlsContainer.appendChild(createUrlInput(currentCount));
            } else {
                alert('Максимум 5 дополнительных URL');
            }
        };
        panel.appendChild(addUrlBtn);

        // Кнопки действий
        const actions = document.createElement('div');
        actions.style.cssText = `
            display: flex;
            gap: 10px;
            margin-top: 15px;
        `;

        const applyBtn = document.createElement('button');
        applyBtn.textContent = '✓ Применить и обновить';
        applyBtn.style.cssText = `
            flex: 1;
            padding: 12px;
            border: none;
            background: linear-gradient(135deg, #34c759 0%, #30d158 100%);
            color: #fff;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            transition: all 0.2s;
            box-shadow: 0 4px 12px rgba(52, 199, 89, 0.3);
        `;
        applyBtn.onmouseover = () => {
            applyBtn.style.transform = 'translateY(-2px)';
            applyBtn.style.boxShadow = '0 6px 16px rgba(52, 199, 89, 0.4)';
        };
        applyBtn.onmouseout = () => {
            applyBtn.style.transform = 'translateY(0)';
            applyBtn.style.boxShadow = '0 4px 12px rgba(52, 199, 89, 0.3)';
        };
        applyBtn.onclick = () => {
            const inputs = urlsContainer.querySelectorAll('input');
            const urls = Array.from(inputs)
                .map(input => input.value.trim())
                .filter(url => url.length > 0);

            if (urls.length === 0) {
                alert('Добавьте хотя бы один URL для объединения');
                return;
            }

            multiUrlState.enabled = true;
            multiUrlState.additionalUrls = urls;
            multiUrlState.baseUrl = getCurrentNormalizedUrl();
            saveMultiUrlConfig();

            console.log(DEBUG_PREFIX, 'Конфигурация Multi-URL применена для текущей страницы, перезагрузка...');
            window.location.reload();
        };

        const disableBtn = document.createElement('button');
        disableBtn.textContent = '✕ Отключить';
        disableBtn.style.cssText = `
            padding: 12px 20px;
            border: none;
            background: rgba(255, 59, 48, 0.8);
            color: #fff;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            transition: all 0.2s;
        `;
        disableBtn.onmouseover = () => disableBtn.style.background = 'rgba(255, 59, 48, 1)';
        disableBtn.onmouseout = () => disableBtn.style.background = 'rgba(255, 59, 48, 0.8)';
        disableBtn.onclick = () => {
            multiUrlState.enabled = false;
            multiUrlState.additionalUrls = [];
            multiUrlState.baseUrl = getCurrentNormalizedUrl();
            saveMultiUrlConfig();
            console.log(DEBUG_PREFIX, 'Multi-URL отключен для текущей страницы, перезагрузка...');
            window.location.reload();
        };

        actions.appendChild(applyBtn);
        actions.appendChild(disableBtn);
        panel.appendChild(actions);

        // Кнопка управления всеми конфигурациями
        const manageBtn = document.createElement('button');
        manageBtn.textContent = '📋 Управление конфигурациями';
        manageBtn.style.cssText = `
            width: 100%;
            padding: 8px;
            margin-top: 10px;
            border: 1px solid rgba(255, 255, 255, 0.3);
            background: transparent;
            color: #fff;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        `;
        manageBtn.onmouseover = () => {
            manageBtn.style.background = 'rgba(255, 255, 255, 0.1)';
        };
        manageBtn.onmouseout = () => {
            manageBtn.style.background = 'transparent';
        };
        manageBtn.onclick = () => {
            showAllConfigsDialog();
        };
        panel.appendChild(manageBtn);

        // Статус
        const status = document.createElement('div');
        status.style.cssText = `
            margin-top: 15px;
            padding: 10px;
            border-radius: 6px;
            text-align: center;
            font-size: 13px;
            font-weight: 500;
        `;

        if (multiUrlState.enabled && multiUrlState.additionalUrls.length > 0) {
            status.style.background = 'rgba(52, 199, 89, 0.2)';
            status.style.border = '1px solid rgba(52, 199, 89, 0.5)';
            status.innerHTML = `✓ Режим объединения активен для этой страницы<br><span style="font-size: 11px; opacity: 0.9;">(${multiUrlState.additionalUrls.length} дополнительных URL)</span>`;
        } else {
            status.style.background = 'rgba(255, 255, 255, 0.05)';
            status.style.border = '1px solid rgba(255, 255, 255, 0.15)';
            status.innerHTML = `ℹ️ Режим объединения не активен для этой страницы`;
        }
        panel.appendChild(status);

        document.body.appendChild(panel);
    }

    // Создание кнопки для открытия панели Multi-URL
    function createMultiUrlToggleButton() {
        if (document.getElementById('multiUrlToggleBtn')) {
            return;
        }

        const button = document.createElement('button');
        button.id = 'multiUrlToggleBtn';
        button.textContent = '🔗';
        button.title = 'Объединение логов из нескольких источников';
        button.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            width: 48px;
            height: 48px;
            border: none;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
            border-radius: 50%;
            cursor: pointer;
            font-size: 24px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 9999;
            transition: all 0.3s;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        if (multiUrlState.enabled) {
            button.style.background = 'linear-gradient(135deg, #34c759 0%, #30d158 100%)';
            button.style.animation = 'pulse 2s infinite';
        }

        button.onmouseover = () => {
            button.style.transform = 'scale(1.1)';
            button.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.4)';
        };
        button.onmouseout = () => {
            button.style.transform = 'scale(1)';
            button.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
        };

        button.onclick = () => {
            const existing = document.getElementById(MULTI_URL_PANEL_ID);
            if (existing) {
                existing.remove();
            } else {
                createMultiUrlPanel();
            }
        };

        document.body.appendChild(button);

        // Добавляем анимацию pulse в стили
        if (!document.getElementById('multiUrlStyles')) {
            const style = document.createElement('style');
            style.id = 'multiUrlStyles';
            style.textContent = `
                @keyframes pulse {
                    0%, 100% { box-shadow: 0 4px 12px rgba(52, 199, 89, 0.3); }
                    50% { box-shadow: 0 4px 20px rgba(52, 199, 89, 0.6); }
                }
            `;
            document.head.appendChild(style);
        }
    }

    function setMultiUrlButtonEnabled(enabled) {
        multiUrlButtonEnabled = Boolean(enabled);
        if (!multiUrlButtonEnabled) {
            const existingPanel = document.getElementById(MULTI_URL_PANEL_ID);
            if (existingPanel) {
                existingPanel.remove();
            }
            const existingButton = document.getElementById('multiUrlToggleBtn');
            if (existingButton) {
                existingButton.remove();
            }
            return;
        }
        runWhenReady(createMultiUrlToggleButton);
    }

    function loadMultiUrlButtonEnabled() {
        return new Promise((resolve) => {
            try {
                if (!chrome?.storage?.local?.get) {
                    resolve(DEFAULT_MULTI_URL_BUTTON_ENABLED);
                    return;
                }
                chrome.storage.local.get({ multiUrlButtonEnabled: DEFAULT_MULTI_URL_BUTTON_ENABLED }, (result) => {
                    resolve(result.multiUrlButtonEnabled === true);
                });
            } catch (error) {
                console.warn(DEBUG_PREFIX, 'Не удалось загрузить флаг Multi-URL кнопки', error);
                resolve(DEFAULT_MULTI_URL_BUTTON_ENABLED);
            }
        });
    }

    // Инициализация Multi-URL функционала
    function initMultiUrl() {
        loadMultiUrlConfig();

        // Создаем кнопку для управления
        loadMultiUrlButtonEnabled().then(setMultiUrlButtonEnabled);
        if (chrome?.storage?.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes.multiUrlButtonEnabled) return;
                setMultiUrlButtonEnabled(changes.multiUrlButtonEnabled.newValue === true);
            });
        }

        console.log(DEBUG_PREFIX, 'Multi-URL инициализирован', multiUrlState);
    }

    // Запускаем инициализацию
    initMultiUrl();

    // ============================================
    // БЕСКОНЕЧНАЯ ПРОКРУТКА ЛОГОВ
    // ============================================

    const INFINITE_SCROLL_SENTINEL_ID = 'logsInfiniteScrollSentinel';
    const INFINITE_SCROLL_LOADER_ID = 'logsInfiniteScrollLoader';
    const INFINITE_SCROLL_ROOT_MARGIN = '480px 0px';
    const SCROLL_PRELOAD_THRESHOLD_PX = 2000;

    const infiniteScrollState = {
        observer: null,
        sentinel: null,
        loader: null,
        loaderMessage: null,
        loaderSpinner: null,
        retryButton: null,
        tableBody: null,
        nextPageUrl: null,
        totalPages: null,
        pageLimit: null,
        isLoading: false,
        autoPaused: false,
        loadedPages: new Set(),
        scrollCheckScheduled: false,
        scrollListenerAttached: false,
        summaryElement: null,
        summaryStart: null,
        summaryTotal: null
    };

    const SUMMARY_TEXT_REGEX = /показано\s+с\s+([\d\s]+)\s+по\s+([\d\s]+)\s+из\s+([\d\s]+)/i;

    function normalizeSummaryNumber(value) {
        const num = Number(String(value ?? '').replace(/\s+/g, ''));
        return Number.isFinite(num) ? num : null;
    }

    function findPaginationSummaryElement() {
        const candidates = Array.from(document.querySelectorAll('.text-muted'));
        for (const element of candidates) {
            const text = element.textContent || '';
            if (SUMMARY_TEXT_REGEX.test(text.toLowerCase())) {
                return element;
            }
        }
        return null;
    }

    function parseSummaryText(text) {
        if (!text) return null;
        const match = text.replace(/\s+/g, ' ').match(SUMMARY_TEXT_REGEX);
        if (!match) return null;
        const [, fromStr, toStr, totalStr] = match;
        const start = normalizeSummaryNumber(fromStr);
        const end = normalizeSummaryNumber(toStr);
        const total = normalizeSummaryNumber(totalStr);
        if (start === null && end === null && total === null) {
            return null;
        }
        return { start, end, total };
    }

    function applySummaryToElement(element, start, end, total) {
        if (!element) return;

        const strongs = element.querySelectorAll('strong');
        if (strongs.length >= 3) {
            if (Number.isFinite(start)) strongs[0].textContent = String(start);
            if (Number.isFinite(end)) strongs[1].textContent = String(end);
            if (Number.isFinite(total)) strongs[2].textContent = String(total);
            return;
        }

        const startText = Number.isFinite(start) ? start : '?';
        const endText = Number.isFinite(end) ? end : '?';
        const totalText = Number.isFinite(total) ? total : '?';
        element.textContent = `Показано с ${startText} по ${endText} из ${totalText}`;
    }

    function refreshPaginationSummary() {
        if (!infiniteScrollState.tableBody) {
            return;
        }

        if (!infiniteScrollState.summaryElement) {
            infiniteScrollState.summaryElement = findPaginationSummaryElement();
            if (infiniteScrollState.summaryElement) {
                const parsed = parseSummaryText(infiniteScrollState.summaryElement.textContent);
                if (parsed?.start !== null && Number.isFinite(parsed.start)) {
                    infiniteScrollState.summaryStart = parsed.start;
                }
                if (parsed?.total !== null && Number.isFinite(parsed.total)) {
                    infiniteScrollState.summaryTotal = parsed.total;
                }
            }
        }

        if (!infiniteScrollState.summaryElement) {
            return;
        }

        const limit = infiniteScrollState.pageLimit;
        const currentPage = getCurrentPageNumber();
        if (!Number.isFinite(infiniteScrollState.summaryStart) && Number.isFinite(limit) && Number.isFinite(currentPage)) {
            infiniteScrollState.summaryStart = (currentPage - 1) * limit + 1;
        }

        const dataRows = Array.from(infiniteScrollState.tableBody.querySelectorAll('tr'))
            .filter(tr => !tr.classList.contains('logs-infinite-scroll-divider-row'));

        const visibleCount = dataRows.length;
        if (visibleCount === 0) {
            return;
        }

        const startValue = Number.isFinite(infiniteScrollState.summaryStart) ? infiniteScrollState.summaryStart : 1;
        const endValue = startValue + visibleCount - 1;

        if (!Number.isFinite(infiniteScrollState.summaryTotal) && Number.isFinite(infiniteScrollState.totalPages) && Number.isFinite(limit)) {
            infiniteScrollState.summaryTotal = infiniteScrollState.totalPages * limit;
        }

        const totalValue = Number.isFinite(infiniteScrollState.summaryTotal)
            ? Math.max(infiniteScrollState.summaryTotal, endValue)
            : endValue;

        applySummaryToElement(infiniteScrollState.summaryElement, startValue, endValue, totalValue);
    }

    function getCurrentPageNumber() {
        const params = new URLSearchParams(window.location.search);
        const raw = params.get('page');
        if (!raw) {
            return 1;
        }
        const num = Number(raw);
        return Number.isNaN(num) ? 1 : num;
    }

    function getPageNumberFromUrl(url) {
        if (!url) {
            return null;
        }
        try {
            const parsed = new URL(url, window.location.href);
            const raw = parsed.searchParams.get('page');
            if (!raw) {
                return null;
            }
            const num = Number(raw);
            return Number.isNaN(num) ? null : num;
        } catch (error) {
            console.warn(DEBUG_PREFIX, 'Не удалось разобрать номер страницы из URL', url, error);
            return null;
        }
    }

    function extractPaginationMeta(root, visitedPages, pageLimit) {
        const meta = {
            nextUrl: null,
            totalPages: null,
            currentPage: null,
            pageLimit: Number.isFinite(pageLimit) && pageLimit > 0 ? pageLimit : null
        };

        if (!root) {
            return meta;
        }

        const pagination = root.querySelector('ul.pagination');
        if (!pagination) {
            return meta;
        }

        const candidateAnchors = [];

        const active = pagination.querySelector('.page-item.active');
        const activeText = active?.textContent?.trim() || '';
        const activeMatch = activeText.match(/\d+/);
        const currentPage = activeMatch ? Number(activeMatch[0]) : null;
        if (Number.isFinite(currentPage) && currentPage > 0) {
            meta.currentPage = currentPage;
        }

        if (active?.nextElementSibling?.querySelector?.('a.page-link[href]')) {
            candidateAnchors.push(active.nextElementSibling.querySelector('a.page-link[href]'));
        }

        pagination.querySelectorAll('a.page-link[href]').forEach(anchor => {
            const label = anchor.getAttribute('aria-label') || anchor.textContent || '';
            if (/вперёд|»/i.test(label)) {
                candidateAnchors.push(anchor);
            }
        });

        const pageNumbers = [];
        pagination.querySelectorAll('li').forEach(li => {
            const text = li.textContent?.trim();
            if (!text) {
                return;
            }
            const matches = text.match(/\d+/g);
            if (!matches) {
                return;
            }
            matches.forEach(numStr => {
                const num = Number(numStr);
                if (Number.isFinite(num)) {
                    pageNumbers.push(num);
                }
            });
        });

        if (pageNumbers.length > 0) {
            meta.totalPages = Math.max(...pageNumbers);
        }

        let effectivePageLimit = meta.pageLimit;
        if (!effectivePageLimit) {
            const sampleAnchor = pagination.querySelector('a.page-link[href]');
            if (sampleAnchor) {
                try {
                    const sampleUrl = new URL(sampleAnchor.href, window.location.href);
                    const limitParam = Number(sampleUrl.searchParams.get('limit'));
                    if (Number.isFinite(limitParam) && limitParam > 0) {
                        effectivePageLimit = limitParam;
                    }
                } catch (error) {
                    console.warn(DEBUG_PREFIX, 'Не удалось определить лимит записей из URL пагинации', error);
                }
            }
        }

        if (!meta.totalPages || !Number.isFinite(meta.totalPages)) {
            const summaryElement = root.querySelector('.text-muted');
            const summaryText = summaryElement?.textContent || '';
            const summaryMatch = summaryText.match(/из\s+([\d\s]+)/i);
            if (summaryMatch) {
                const totalEntries = Number(summaryMatch[1].replace(/\s+/g, ''));
                if (Number.isFinite(totalEntries) && totalEntries > 0 && effectivePageLimit) {
                    meta.totalPages = Math.max(meta.totalPages || 0, Math.ceil(totalEntries / effectivePageLimit));
                }
            }
        }

        if (Number.isFinite(effectivePageLimit) && effectivePageLimit > 0) {
            meta.pageLimit = effectivePageLimit;
        }

        const processed = new Set();
        const candidateList = [];

        candidateAnchors.forEach(anchor => {
            if (!anchor || processed.has(anchor)) {
                return;
            }
            processed.add(anchor);
            candidateList.push(anchor);
        });

        if (candidateList.length === 0) {
            pagination.querySelectorAll('a.page-link[href]').forEach(anchor => {
                if (!anchor || processed.has(anchor)) {
                    return;
                }
                processed.add(anchor);
                candidateList.push(anchor);
            });
        }

        const numericAnchors = candidateList.map(anchor => {
            try {
                const absoluteUrl = new URL(anchor.href, window.location.href).toString();
                const pageNumber = getPageNumberFromUrl(absoluteUrl) ?? (() => {
                    const anchorText = anchor.textContent?.trim() || '';
                    const numericMatch = anchorText.match(/\d+/);
                    return numericMatch ? Number(numericMatch[0]) : null;
                })();
                return {
                    anchor,
                    url: absoluteUrl,
                    pageNumber
                };
            } catch (error) {
                console.warn(DEBUG_PREFIX, 'Не удалось разобрать ссылку пагинации', error);
                return null;
            }
        }).filter(Boolean);

        numericAnchors.sort((a, b) => {
            if (!Number.isFinite(a.pageNumber) && !Number.isFinite(b.pageNumber)) {
                return 0;
            }
            if (!Number.isFinite(a.pageNumber)) {
                return 1;
            }
            if (!Number.isFinite(b.pageNumber)) {
                return -1;
            }
            return a.pageNumber - b.pageNumber;
        });

        for (const item of numericAnchors) {
            let pageNumber = item.pageNumber;

            // Если pageNumber не определён, но URL без параметра page - это страница 1
            if (!Number.isFinite(pageNumber)) {
                try {
                    const parsed = new URL(item.url, window.location.href);
                    if (!parsed.searchParams.has('page')) {
                        pageNumber = 1;
                    }
                } catch (e) {
                    }
            }

            if (Number.isFinite(pageNumber)) {
                if (visitedPages?.has(pageNumber)) {
                    continue;
                }
                if (currentPage && pageNumber <= currentPage) {
                    continue;
                }
            }
            meta.nextUrl = item.url;
            break;
        }

        return meta;
    }

    function ensureLoaderElements() {
        if (infiniteScrollState.loader) {
            return;
        }

        const nav = document.querySelector('nav[role="navigation"]');
        const mountPoint = nav?.parentElement || document.querySelector('.app-content') || document.body;

        const loader = document.createElement('div');
        loader.id = INFINITE_SCROLL_LOADER_ID;
        loader.className = 'logs-infinite-scroll-loader';
        loader.hidden = true;

        const spinner = document.createElement('span');
        spinner.className = 'logs-infinite-scroll-spinner';
        loader.appendChild(spinner);

        const message = document.createElement('span');
        message.className = 'logs-infinite-scroll-message';
        loader.appendChild(message);

        const retryButton = document.createElement('button');
        retryButton.type = 'button';
        retryButton.className = 'logs-infinite-scroll-retry';
        retryButton.textContent = 'Повторить';
        retryButton.hidden = true;
        retryButton.addEventListener('click', () => {
            if (infiniteScrollState.isLoading) {
                return;
            }
            if (!infiniteScrollState.nextPageUrl) {
                return;
            }
            infiniteScrollState.autoPaused = false;
            infiniteScrollState.observer?.observe(infiniteScrollState.sentinel);
            void loadNextPage();
        });
        loader.appendChild(retryButton);

        const sentinel = document.createElement('div');
        sentinel.id = INFINITE_SCROLL_SENTINEL_ID;
        sentinel.className = 'logs-infinite-scroll-sentinel';

        mountPoint.appendChild(loader);
        mountPoint.appendChild(sentinel);

        infiniteScrollState.loader = loader;
        infiniteScrollState.loaderSpinner = spinner;
        infiniteScrollState.loaderMessage = message;
        infiniteScrollState.retryButton = retryButton;
        infiniteScrollState.sentinel = sentinel;
    }

    function createPageDividerRow(pageNumber) {
        if (!pageNumber || !infiniteScrollState.tableBody) {
            return null;
        }

        const referenceRow = infiniteScrollState.tableBody.querySelector('tr');
        const colCount = referenceRow?.cells?.length || 1;

        const dividerRow = document.createElement('tr');
        dividerRow.className = 'logs-infinite-scroll-divider-row';
        dividerRow.dataset.pageNumber = String(pageNumber);

        const dividerCell = document.createElement('td');
        dividerCell.className = 'logs-infinite-scroll-divider-cell';
        dividerCell.colSpan = colCount;
        const totalPages = infiniteScrollState.totalPages;
        const suffix = Number.isFinite(totalPages) && totalPages > 0 ? ` из ${totalPages}` : '';
        dividerCell.textContent = `Автозагрузка · страница ${pageNumber}${suffix}`;

        dividerRow.appendChild(dividerCell);
        return dividerRow;
    }

    function setLoaderState(state, details = {}) {
        const { loader, loaderMessage, loaderSpinner, retryButton } = infiniteScrollState;
        if (!loader || !loaderMessage || !loaderSpinner || !retryButton) {
            return;
        }

        const {
            errorMessage,
            currentPage,
            nextPage,
            totalPagesOverride
        } = details;

        const totalPages = Number.isFinite(totalPagesOverride)
            ? totalPagesOverride
            : infiniteScrollState.totalPages;

        const formatPageProgress = (page) => {
            if (!Number.isFinite(page) || page <= 0) {
                return null;
            }
            if (Number.isFinite(totalPages) && totalPages > 0) {
                return `${page} из ${totalPages}`;
            }
            return String(page);
        };

        loader.hidden = false;
        loaderSpinner.hidden = state !== 'loading';
        retryButton.hidden = state !== 'error';

        switch (state) {
            case 'loading': {
                const pageLabel = formatPageProgress(currentPage ?? nextPage ?? getPageNumberFromUrl(infiniteScrollState.nextPageUrl));
                loaderMessage.textContent = pageLabel
                    ? `Загружаем страницу ${pageLabel}…`
                    : 'Загружаем следующую страницу…';
                break;
            }
            case 'error': {
                const pageLabel = formatPageProgress(currentPage ?? nextPage);
                loaderMessage.textContent = errorMessage
                    || (pageLabel
                        ? `Не удалось загрузить страницу ${pageLabel}. Попробуйте ещё раз.`
                        : 'Не удалось загрузить данные. Попробуйте ещё раз.');
                break;
            }
            case 'complete': {
                loaderSpinner.hidden = true;
                if (Number.isFinite(totalPages) && totalPages > 0) {
                    loaderMessage.textContent = `Загружены все ${totalPages} страниц.`;
                } else {
                    loaderMessage.textContent = 'Это все записи.';
                }
                break;
            }
            default: {
                const upcomingPage = formatPageProgress(nextPage ?? getPageNumberFromUrl(infiniteScrollState.nextPageUrl));
                loaderMessage.textContent = upcomingPage
                    ? `Следующая страница: ${upcomingPage}. Листайте вниз, чтобы загрузить автоматически.`
                    : 'Листайте вниз, чтобы загрузить следующую страницу.';
                break;
            }
        }
    }

    function isScrollNearBottom() {
        const scrollElement = document.scrollingElement || document.documentElement || document.body;
        if (!scrollElement) {
            return false;
        }

        const remaining = scrollElement.scrollHeight - scrollElement.scrollTop - window.innerHeight;
        return remaining <= SCROLL_PRELOAD_THRESHOLD_PX;
    }

    function ensurePreload() {
        if (infiniteScrollState.autoPaused || infiniteScrollState.isLoading) {
            return;
        }
        if (!infiniteScrollState.nextPageUrl) {
            return;
        }
        if (!isScrollNearBottom()) {
            return;
        }

        void loadNextPage();
    }

    function schedulePreloadCheck() {
        if (infiniteScrollState.scrollCheckScheduled) {
            return;
        }
        infiniteScrollState.scrollCheckScheduled = true;
        requestAnimationFrame(() => {
            infiniteScrollState.scrollCheckScheduled = false;
            ensurePreload();
        });
    }

    function markInfiniteScrollComplete() {
        if (infiniteScrollState.autoPaused) {
            return;
        }
        infiniteScrollState.autoPaused = true;
        infiniteScrollState.observer?.unobserve(infiniteScrollState.sentinel);
        setLoaderState('complete', {
            totalPagesOverride: infiniteScrollState.totalPages
        });
    }

    async function downloadLogsPage(url) {
        // Проверяем Multi-URL режим (приоритет выше чем House Combined)
        if (isMultiUrlCombinedActive()) {
            return downloadMultiUrlMergedPage(url);
        }

        if (isHouseCombinedUrl(url)) {
            return downloadHouseMergedPage(url);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
            const response = await fetch(url, {
                credentials: 'include',
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Статус ответа: ${response.status}`);
            }

            const htmlText = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, 'text/html');

            const rowNodes = Array.from(doc.querySelectorAll('table.table-hover tbody tr'));
            const fragment = document.createDocumentFragment();
            const importedRows = rowNodes.map(row => document.importNode(row, true));
            importedRows.forEach(row => fragment.appendChild(row));

            const paginationMeta = extractPaginationMeta(doc, infiniteScrollState.loadedPages, infiniteScrollState.pageLimit);

            return {
                fragment,
                rowCount: importedRows.length,
                nextUrl: paginationMeta.nextUrl,
                totalPages: paginationMeta.totalPages,
                currentPage: paginationMeta.currentPage,
                pageLimit: paginationMeta.pageLimit
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function loadNextPage() {
        if (infiniteScrollState.isLoading || infiniteScrollState.autoPaused) {
            return;
        }
        const targetUrl = infiniteScrollState.nextPageUrl;
        if (!targetUrl) {
            markInfiniteScrollComplete();
            return;
        }

        let pageNumber = getPageNumberFromUrl(targetUrl);

        infiniteScrollState.isLoading = true;
        setLoaderState('loading', { currentPage: pageNumber });

        try {
            const {
                fragment,
                rowCount,
                nextUrl,
                totalPages,
                currentPage: loadedPageNumber,
                pageLimit
            } = await downloadLogsPage(targetUrl);

            if (rowCount === 0) {
                markInfiniteScrollComplete();
                return;
            }

            if (!Number.isFinite(pageNumber) && Number.isFinite(loadedPageNumber)) {
                pageNumber = loadedPageNumber;
            }

            if (Number.isFinite(totalPages) && totalPages > 0) {
                const currentTotal = infiniteScrollState.totalPages;
                if (!Number.isFinite(currentTotal) || totalPages > currentTotal) {
                    infiniteScrollState.totalPages = totalPages;
                }
            }

            if (!Number.isFinite(infiniteScrollState.pageLimit) && Number.isFinite(pageLimit) && pageLimit > 0) {
                infiniteScrollState.pageLimit = pageLimit;
            }

            if (pageNumber) {
                const dividerRow = createPageDividerRow(pageNumber);
                if (dividerRow) {
                    fragment.insertBefore(dividerRow, fragment.firstChild);
                }
            }

            infiniteScrollState.tableBody.appendChild(fragment);

            refreshPaginationSummary();

            if (pageNumber) {
                infiniteScrollState.loadedPages.add(pageNumber);
            }

            if (nextUrl) {
                infiniteScrollState.nextPageUrl = nextUrl;
                setLoaderState('idle', {
                    nextPage: getPageNumberFromUrl(nextUrl)
                });
            } else {
                infiniteScrollState.nextPageUrl = null;
                markInfiniteScrollComplete();
            }

            setTimeout(processItemPrices, 120);
        } catch (error) {
            console.warn(DEBUG_PREFIX, 'Ошибка при загрузке следующей страницы логов', error);
            infiniteScrollState.autoPaused = true;
            infiniteScrollState.observer?.unobserve(infiniteScrollState.sentinel);
            setLoaderState('error', {
                errorMessage: error?.message ? `Не удалось загрузить данные: ${error.message}` : undefined,
                currentPage: pageNumber
            });
        } finally {
            infiniteScrollState.isLoading = false;
            schedulePreloadCheck();
        }
    }

    async function hydrateHouseFirstPage(tableBody) {
        try {
            const merged = await downloadHouseMergedPage(window.location.href);
            if (merged?.fragment) {
                tableBody.innerHTML = '';
                tableBody.appendChild(merged.fragment);
            }
            return merged;
        } catch (error) {
            console.warn(DEBUG_PREFIX, 'Не удалось объединить логи шкафа', error);
            return null;
        }
    }

    async function hydrateMultiUrlFirstPage(tableBody) {
        try {
            const merged = await downloadMultiUrlMergedPage(window.location.href);
            if (merged?.fragment) {
                tableBody.innerHTML = '';
                tableBody.appendChild(merged.fragment);
            }
            return merged;
        } catch (error) {
            console.warn(DEBUG_PREFIX, 'Не удалось объединить Multi-URL логи', error);
            return null;
        }
    }

    async function setupInfiniteScroll() {
        if (infiniteScrollState.sentinel) {
            return;
        }

        const tableBody = document.querySelector('table.table-hover tbody');
        if (!tableBody) {
            return;
        }

        const isMultiUrlActive = isMultiUrlCombinedActive();
        const isHouseCombined = isHouseCombinedUrl(window.location.href);
        let mergedMeta = null;

        // Multi-URL режим имеет приоритет
        if (isMultiUrlActive) {
            mergedMeta = await hydrateMultiUrlFirstPage(tableBody);
        } else if (isHouseCombined) {
            mergedMeta = await hydrateHouseFirstPage(tableBody);
        }

        const pagination = document.querySelector('ul.pagination');
        if (!pagination && !isHouseCombined && !isMultiUrlActive) {
            return;
        }

        infiniteScrollState.tableBody = tableBody;
        infiniteScrollState.loadedPages.add(mergedMeta?.currentPage ?? getCurrentPageNumber());

        if (!Number.isFinite(infiniteScrollState.pageLimit)) {
            const params = new URLSearchParams(window.location.search);
            const limitParam = Number(params.get('limit'));
            if (Number.isFinite(limitParam) && limitParam > 0) {
                infiniteScrollState.pageLimit = limitParam;
            } else {
                const initialRows = tableBody.querySelectorAll('tr').length;
                if (initialRows > 0) {
                    infiniteScrollState.pageLimit = initialRows;
                }
            }
        }

        if ((isMultiUrlActive || isHouseCombined) && mergedMeta) {
            infiniteScrollState.nextPageUrl = mergedMeta.nextUrl;
            if (Number.isFinite(mergedMeta.totalPages) && mergedMeta.totalPages > 0) {
                infiniteScrollState.totalPages = mergedMeta.totalPages;
            }
            if (!Number.isFinite(infiniteScrollState.pageLimit) && Number.isFinite(mergedMeta.pageLimit) && mergedMeta.pageLimit > 0) {
                infiniteScrollState.pageLimit = mergedMeta.pageLimit;
            }
        } else {
            const paginationMeta = extractPaginationMeta(document, infiniteScrollState.loadedPages, infiniteScrollState.pageLimit);
            infiniteScrollState.nextPageUrl = paginationMeta.nextUrl;
            if (Number.isFinite(paginationMeta.totalPages) && paginationMeta.totalPages > 0) {
                infiniteScrollState.totalPages = paginationMeta.totalPages;
            }
            if (!Number.isFinite(infiniteScrollState.pageLimit) && Number.isFinite(paginationMeta.pageLimit) && paginationMeta.pageLimit > 0) {
                infiniteScrollState.pageLimit = paginationMeta.pageLimit;
            }
        }

        refreshPaginationSummary();

        if (!infiniteScrollState.nextPageUrl) {
            return;
        }

        ensureLoaderElements();
        setLoaderState('idle', {
            nextPage: getPageNumberFromUrl(infiniteScrollState.nextPageUrl)
        });

        if (!infiniteScrollState.scrollListenerAttached) {
            const schedule = () => schedulePreloadCheck();
            window.addEventListener('scroll', schedule, { passive: true });
            window.addEventListener('resize', schedule, { passive: true });
            infiniteScrollState.scrollListenerAttached = true;
        }

        infiniteScrollState.observer = new IntersectionObserver((entries) => {
            const entry = entries[0];
            if (!entry || !entry.isIntersecting) {
                return;
            }

            if (infiniteScrollState.autoPaused) {
                return;
            }

            void loadNextPage();
        }, {
            root: null,
            rootMargin: INFINITE_SCROLL_ROOT_MARGIN,
            threshold: 0
        });

        infiniteScrollState.observer.observe(infiniteScrollState.sentinel);

        schedulePreloadCheck();
    }

    runWhenReady(setupInfiniteScroll);

    // ============================================
    // Сохранение выбранного лимита логов
    // ============================================

    const LOGS_LIMIT_STORAGE_KEY = 'logsPreferredLimit';
    const LOGS_LIMIT_DEFAULT = 100;
    const LOGS_LIMIT_ALLOWED = [100, 500, 1000];
    const LOGS_LIMIT_SELECT_SELECTOR = 'select[name="limit"]';

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

    function readLogsLimitFromLocalStorage() {
        try {
            const raw = localStorage.getItem(LOGS_LIMIT_STORAGE_KEY);
            return parseLogsLimit(raw);
        } catch (error) {
            debugLog('Не удалось прочитать лимит логов из localStorage', error);
            return null;
        }
    }

    function loadPreferredLogsLimit() {
        return new Promise((resolve) => {
            const localStored = readLogsLimitFromLocalStorage();

            try {
                if (!chrome?.storage?.local?.get) {
                    resolve(localStored ?? LOGS_LIMIT_DEFAULT);
                    return;
                }
                chrome.storage.local.get({ [LOGS_LIMIT_STORAGE_KEY]: localStored ?? LOGS_LIMIT_DEFAULT }, (result) => {
                    const raw = result?.[LOGS_LIMIT_STORAGE_KEY];
                    const parsed = parseLogsLimit(raw);
                    const resolved = parsed ?? localStored ?? LOGS_LIMIT_DEFAULT;

                    if (parsed !== null) {
                        try {
                            localStorage.setItem(LOGS_LIMIT_STORAGE_KEY, String(parsed));
                        } catch (error) {
                            debugLog('Не удалось сохранить лимит логов в localStorage после загрузки', error);
                        }
                    }

                    resolve(resolved);
                });
            } catch (error) {
                debugLog('Не удалось загрузить сохранённый лимит логов', error);
                resolve(localStored ?? LOGS_LIMIT_DEFAULT);
            }
        });
    }

    function savePreferredLogsLimit(limit) {
        const normalized = parseLogsLimit(limit) ?? LOGS_LIMIT_DEFAULT;

        try {
            if (!chrome?.storage?.local?.set) return;
            chrome.storage.local.set({ [LOGS_LIMIT_STORAGE_KEY]: normalized });
        } catch (error) {
            debugLog('Не удалось сохранить выбранный лимит логов', error);
        }

        try {
            localStorage.setItem(LOGS_LIMIT_STORAGE_KEY, String(normalized));
        } catch (error) {
            debugLog('Не удалось сохранить лимит логов в localStorage', error);
        }
    }

    function syncLimitParamWithUrl(limit, { reloadIfChanged = false } = {}) {
        const normalized = parseLogsLimit(limit) ?? LOGS_LIMIT_DEFAULT;
        const currentUrl = new URL(window.location.href);
        const currentParam = currentUrl.searchParams.get('limit');
        const hasLimit = currentUrl.searchParams.has('limit');

        if (normalized === LOGS_LIMIT_DEFAULT) {
            if (hasLimit) {
                currentUrl.searchParams.delete('limit');
                const nextHref = currentUrl.toString();
                if (reloadIfChanged) {
                    window.location.replace(nextHref);
                    return true;
                }
                history.replaceState(null, '', nextHref);
            }
            return false;
        }

        if (currentParam === String(normalized)) {
            return false;
        }

        currentUrl.searchParams.set('limit', String(normalized));
        const nextHref = currentUrl.toString();
        if (reloadIfChanged) {
            window.location.replace(nextHref);
            return true;
        }
        history.replaceState(null, '', nextHref);
        return false;
    }

    function setupLimitSelect(preferredLimit, onChange) {
        const select = document.querySelector(LOGS_LIMIT_SELECT_SELECTOR);
        if (!select || select.dataset.logsLimitEnhanced === 'true') {
            return;
        }

        select.dataset.logsLimitEnhanced = 'true';

        const targetLimit = parseLogsLimit(preferredLimit) ?? LOGS_LIMIT_DEFAULT;
        const matchingOption = Array.from(select.options).find(opt => opt.value === String(targetLimit));
        if (matchingOption && select.value !== matchingOption.value) {
            select.value = matchingOption.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }

        select.addEventListener('change', () => {
            const selected = parseLogsLimit(select.value) ?? LOGS_LIMIT_DEFAULT;
            onChange(selected);
        });
    }

    async function initPreferredLimitControl() {
        const params = new URLSearchParams(window.location.search);
        const urlLimit = parseLogsLimit(params.get('limit'));
        const storedLimit = await loadPreferredLogsLimit();
        let preferredLimit = urlLimit ?? storedLimit ?? LOGS_LIMIT_DEFAULT;

        if (urlLimit !== null && urlLimit !== storedLimit) {
            savePreferredLogsLimit(urlLimit);
        }

        const redirectTriggered = syncLimitParamWithUrl(preferredLimit, {
            reloadIfChanged: urlLimit === null && preferredLimit > LOGS_LIMIT_DEFAULT
        });
        if (redirectTriggered) {
            return;
        }

        const handleLimitChange = (nextLimit) => {
            preferredLimit = nextLimit;
            savePreferredLogsLimit(nextLimit);
            syncLimitParamWithUrl(nextLimit, { reloadIfChanged: false });
        };

        // Вызываем один раз (единый observer вызовет при изменениях DOM)
        setupLimitSelect(preferredLimit, handleLimitChange);
    }

    runWhenReady(() => {
        void initPreferredLimitControl();
    });

    // ============================================
    // ФУНКЦИОНАЛ ИСТОРИИ ВЗАИМОДЕЙСТВИЙ
    // ============================================

    function addInteractionButtons() {
        if (pageIsHiding) return;
        const tableBody = document.querySelector('table.table-hover tbody');
        if (!tableBody) return;

        const rows = tableBody.querySelectorAll('tr');
        rows.forEach(row => {
            // Быстрая проверка через WeakSet вместо querySelector
            if (processedRows.has(row)) return;

            const cells = row.querySelectorAll('td');
            if (cells.length < 2) {
                processedRows.add(row);
                return;
            }

            const actionCell = cells[1];
            const links = actionCell.querySelectorAll('a[href*="player="]');

            // Нужен хотя бы один игрок в записи
            if (links.length === 0) {
                processedRows.add(row);
                return;
            }

            // Создаем кнопку
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'interaction-history-btn';
            button.textContent = '🔍';
            button.title = 'Показать историю взаимодействий за выбранный период';
            button.addEventListener('click', () => {
                try {
                    showInteractionHistory(row, links, cells[0]);
                } catch (error) {
                    console.error(DEBUG_PREFIX, 'Interaction history failed', error);
                    alert('Не удалось открыть историю взаимодействий. Проверьте консоль для деталей.');
                }
            });

            // Вставляем кнопку в начало ячейки действия
            actionCell.insertBefore(button, actionCell.firstChild);
            processedRows.add(row);
        });
    }

    function showInteractionHistory(row, playerLinks, dateCell) {
        const nextRow = row.nextElementSibling;
        if (nextRow?.dataset?.interactionPanel === 'true') {
            row.classList.remove('interaction-history-active-row');
            nextRow.remove();
            return;
        }

        document.querySelectorAll('tr[data-interaction-panel="true"]').forEach((openRow) => {
            const hostRow = openRow.previousElementSibling;
            if (hostRow?.classList?.contains('interaction-history-active-row')) {
                hostRow.classList.remove('interaction-history-active-row');
            }
            openRow.remove();
        });

        const players = Array.from(playerLinks)
            .map((link) => {
                const match = link.href.match(/player=([^&]+)/);
                if (match) {
                    return safeDecode(match[1], match[1]) || link.textContent?.trim() || null;
                }
                return link.textContent?.trim() || null;
            })
            .filter(Boolean)
            .slice(0, 2);

        if (players.length === 0) {
            alert('Не удалось извлечь имя игрока');
            return;
        }

        const [primaryPlayer, secondaryPlayer] = players;
        const accountIds = extractAccountIds(row, players.length);
        const primaryLabel = formatPlayerLabel(primaryPlayer, accountIds[0]);
        const secondaryLabel = secondaryPlayer ? formatPlayerLabel(secondaryPlayer, accountIds[1]) : null;
        const primaryQueryValue = accountIds[0] || primaryPlayer;
        const secondaryQueryValue = accountIds[1] || secondaryPlayer || null;

        const dateText = (dateCell?.textContent || '').trim();
        const dateMatch = dateText.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);

        if (!dateMatch) {
            alert('Не удалось извлечь дату из строки');
            return;
        }

        const eventDateStr = `${dateMatch[1]} ${dateMatch[2]}`;
        const eventTimestamp = eventDateStr;

        // Используем новые функции для работы с датами без привязки к часовому поясу
        const startDateStr = addMinutesToDateString(eventDateStr, -INTERACTION_LOOKBACK_MINUTES);
        const desiredEndDateStr = INTERACTION_LOOKAHEAD_MINUTES > 0
            ? addMinutesToDateString(eventDateStr, INTERACTION_LOOKAHEAD_MINUTES)
            : eventDateStr;

        if (!startDateStr || !desiredEndDateStr) {
            alert('Не удалось вычислить период');
            return;
        }

        // Проверяем, не выходит ли желаемая конечная дата за текущее время
        const nowStr = formatDateInTZ(new Date(), SERVER_TZ_OFFSET_MINUTES);
        const endDateStr = desiredEndDateStr > nowStr ? nowStr : desiredEndDateStr;

        const urlParams = new URLSearchParams(window.location.search);
        const serverId = urlParams.get('server_number') || '103';

        const logsUrl = new URL('https://arizonarp.logsparser.info/');
        logsUrl.searchParams.set('server_number', serverId);
        logsUrl.searchParams.set('sort', 'desc');
        logsUrl.searchParams.set('player', primaryQueryValue);
        logsUrl.searchParams.set('min_period', startDateStr);
        logsUrl.searchParams.set('max_period', endDateStr);
        logsUrl.searchParams.set('limit', '1000');
        logsUrl.searchParams.set(INTERACTION_FOCUS_PARAM, eventTimestamp);

        const longRangeUrl = new URL('https://arizonarp.logsparser.info/');
        longRangeUrl.searchParams.set('server_number', serverId);
        longRangeUrl.searchParams.set('sort', 'desc');
        longRangeUrl.searchParams.set('player', primaryQueryValue);
        if (secondaryQueryValue) {
            longRangeUrl.searchParams.set('target', secondaryQueryValue);
        }
        const longRangeEnd = new Date();
        const longRangeStart = new Date(longRangeEnd.getTime());
        longRangeStart.setMonth(longRangeStart.getMonth() - 9);
        longRangeUrl.searchParams.set('min_period', formatDateInTZ(longRangeStart, SERVER_TZ_OFFSET_MINUTES));
        longRangeUrl.searchParams.set('max_period', formatDateInTZ(longRangeEnd, SERVER_TZ_OFFSET_MINUTES));

        const longRangeElements = createLongRangeSection(longRangeUrl.toString(), eventTimestamp);
        const longRangeSection = longRangeElements?.section || null;
        const longRangeToggleBtn = longRangeElements?.toggleButton || null;

        const panelRow = document.createElement('tr');
        panelRow.dataset.interactionPanel = 'true';
        panelRow.className = 'interaction-history-row';

        const panelCell = document.createElement('td');
        panelCell.colSpan = row.cells.length;
        panelCell.className = 'interaction-history-cell';

        const panel = document.createElement('div');
        panel.className = 'interaction-history-panel';

        const header = document.createElement('div');
        header.className = 'interaction-history-header';

        const title = document.createElement('div');
        title.className = 'interaction-history-title';

        const titleLine = document.createElement('div');
        titleLine.className = 'interaction-history-title-line';
        const titleIcon = document.createElement('span');
        titleIcon.className = 'interaction-history-icon';
        titleIcon.textContent = '🔍';
        titleLine.append(titleIcon, 'История взаимодействий: ');

        const firstPlayer = document.createElement('span');
        firstPlayer.className = 'interaction-history-player';
        firstPlayer.textContent = primaryLabel;

        titleLine.append(firstPlayer);
        if (secondaryLabel) {
            const secondPlayer = document.createElement('span');
            secondPlayer.className = 'interaction-history-player';
            secondPlayer.textContent = secondaryLabel;
            titleLine.append(' и ', secondPlayer);
        }

        const periodLine = document.createElement('div');
        periodLine.className = 'interaction-history-period';
        const localStart = serverStrToLocalStr(startDateStr);
        const localEnd = serverStrToLocalStr(endDateStr);
        periodLine.innerHTML = `
  <div><b>Период (MSK):</b> ${startDateStr} — ${endDateStr}</div>
  <div><b>Ваше время:</b> ${localStart} — ${localEnd}</div>
`;

        title.append(titleLine, periodLine);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'interaction-history-close';
        closeBtn.textContent = '✖ Закрыть';
        closeBtn.addEventListener('click', () => {
            row.classList.remove('interaction-history-active-row');
            panelRow.remove();
        });

        header.append(title, closeBtn);

        const iframe = document.createElement('iframe');
        iframe.className = 'interaction-history-iframe';
        iframe.src = logsUrl.toString();
        iframe.title = 'История взаимодействий игроков';
        iframe.loading = 'lazy';
        iframe.addEventListener('load', () => {
            scrollIframeToInteraction(iframe, eventTimestamp);
        });

        const openLinkBtn = document.createElement('a');
        openLinkBtn.className = 'interaction-history-open-link';
        openLinkBtn.href = logsUrl.toString();
        openLinkBtn.target = '_blank';
        openLinkBtn.rel = 'noopener noreferrer';
        openLinkBtn.textContent = '🔗 Открыть в новой вкладке';

        const actionsWrapper = document.createElement('div');
        actionsWrapper.className = 'interaction-history-actions';
        actionsWrapper.append(openLinkBtn);
        if (longRangeToggleBtn) {
            actionsWrapper.append(longRangeToggleBtn);
        }

        panel.append(header, iframe, actionsWrapper);
        if (longRangeSection) {
            panel.append(longRangeSection);
        }
        panelCell.appendChild(panel);

        if (!row?.parentNode) {
            alert('Строка таблицы больше не доступна. Обновите страницу и попробуйте снова.');
            return;
        }
        panelRow.appendChild(panelCell);

        row.classList.add('interaction-history-active-row');
        row.parentNode.insertBefore(panelRow, row.nextSibling);
        panel.scrollIntoView({ block: 'nearest' });
    }

    function createLongRangeSection(url, focusTimestamp) {
        if (!url) {
            return {};
        }

        const section = document.createElement('div');
        section.className = 'interaction-history-long-range';

        const title = document.createElement('div');
        title.className = 'interaction-history-long-range-title';
        title.textContent = 'История взаимодействий за 9 месяцев';

        const content = document.createElement('div');
        content.className = 'interaction-history-long-range-content';
        content.hidden = true;

        const note = document.createElement('div');
        note.className = 'interaction-history-long-range-note';
        note.textContent = 'История открывается во встроенном окне. Загрузка может занять немного времени.';

        let iframe = null;

        const toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.className = 'interaction-history-open-link interaction-history-full-link interaction-history-full-toggle';
        toggleButton.textContent = '📜 Показать историю за 9 месяцев';

        toggleButton.addEventListener('click', () => {
            const isOpen = section.classList.toggle('interaction-history-long-range--open');
            if (isOpen) {
                toggleButton.textContent = '📜 Скрыть историю за 9 месяцев';
                content.hidden = false;
                const panelElement = section.closest('.interaction-history-panel');
                if (panelElement) {
                    panelElement.classList.add('interaction-history-panel--expanded');
                }

                if (!iframe) {
                    iframe = document.createElement('iframe');
                    iframe.className = 'interaction-history-iframe interaction-history-iframe-long-range';
                    iframe.src = url;
                    iframe.title = 'История взаимодействий за 9 месяцев';
                    iframe.loading = 'lazy';
                    iframe.addEventListener('load', () => {
                        scrollIframeToInteraction(iframe, focusTimestamp);
                    });
                    content.appendChild(iframe);
                }
            } else {
                toggleButton.textContent = '📜 Показать историю за 9 месяцев';
                content.hidden = true;
                const panelElement = section.closest('.interaction-history-panel');
                if (panelElement) {
                    panelElement.classList.remove('interaction-history-panel--expanded');
                }
            }
        });

        section.append(title, content, note);

        return { section, toggleButton };
    }

    function startsWithMinute(cellText, ts) {
        return cellText.startsWith(ts.slice(0, 16)); // YYYY-MM-DD HH:MM
    }

    function tryMatchWithOffsets(cellText, focusTs) {
        if (startsWithMinute(cellText, focusTs)) return true;
        // пробуем вариант, сдвинутый на локальный offset относительно сервера
        const offsetMin = (new Date()).getTimezoneOffset() + SERVER_TZ_OFFSET_MINUTES;
        // getTimezoneOffset() в минутах «сколько вычесть из локального до UTC».
        // Для Европы (UTC+1 зимой): offset= -60 => -60 + 180 = 120 (т.е. локал раньше на 2ч относительно MSK).
        const shifted = addMinutesToDateString(focusTs, -offsetMin);
        return startsWithMinute(cellText, shifted);
    }

    function scrollIframeToInteraction(iframe, focusTimestamp) {
        const maxAttempts = 25;
        const attemptDelay = 400;
        let attempts = 0;

        const tryScroll = () => {
            attempts += 1;
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!doc) {
                if (attempts < maxAttempts) {
                    setTimeout(tryScroll, attemptDelay);
                }
                return;
            }

            const tableBody = doc.querySelector('table.table-hover tbody');
            if (tableBody) {
                const rows = Array.from(tableBody.querySelectorAll('tr'));
                for (const row of rows) {
                    const firstCell = row.cells[0];
                    const cellText = firstCell?.textContent?.trim();
                    if (cellText && tryMatchWithOffsets(cellText, focusTimestamp)) {
                        row.scrollIntoView({ block: 'center' });
                        const originalBackground = row.style.backgroundColor;
                        const originalBoxShadow = row.style.boxShadow;
                        row.style.backgroundColor = 'rgba(77, 208, 225, 0.18)';
                        row.style.boxShadow = 'inset 0 0 0 2px rgba(77, 208, 225, 0.45)';
                        setTimeout(() => {
                            row.style.backgroundColor = originalBackground;
                            row.style.boxShadow = originalBoxShadow;
                        }, 6000);
                        return;
                    }
                }
            }

            if (attempts < maxAttempts) {
                setTimeout(tryScroll, attemptDelay);
            }
        };

        setTimeout(tryScroll, attemptDelay);
    }

    function maybeScrollToInteractionFocus() {
        const params = new URLSearchParams(window.location.search);
        const focusTimestamp = params.get(INTERACTION_FOCUS_PARAM);
        if (!focusTimestamp) {
            return;
        }

        const highlightClass = 'interaction-history-focus-row';
        const maxAttempts = 20;
        const attemptDelay = 500;
        let attempts = 0;

        const tryScroll = () => {
            attempts += 1;

            const tableBody = document.querySelector('table.table-hover tbody');
            if (tableBody) {
                const rows = Array.from(tableBody.querySelectorAll('tr'));
                for (const row of rows) {
                    const firstCell = row.cells[0];
                    const cellText = firstCell?.textContent?.trim();
                    if (cellText && tryMatchWithOffsets(cellText, focusTimestamp)) {
                        row.classList.add(highlightClass);
                        row.scrollIntoView({ block: 'center' });
                        setTimeout(() => row.classList.remove(highlightClass), 8000);
                        return;
                    }
                }
            }

            if (attempts < maxAttempts) {
                setTimeout(tryScroll, attemptDelay);
            }
        };

        runWhenReady(tryScroll);
    }

    // Добавляем кнопки при загрузке страницы
    runWhenReady(addInteractionButtons);

    maybeScrollToInteractionFocus();

    // ============================================
    // ФУНКЦИОНАЛ КОПИРОВАНИЯ И ДУБЛИКАТОВ EMAIL
    // ============================================

    const emailRegistry = new Map();
    const vkRegistry = new Map();
    const tgRegistry = new Map();
    const processedAttachmentRows = new WeakSet();
    function registerEmail(email, accId, nickname, serverId) {
        if (!email || !accId) return;

        if (!emailRegistry.has(email)) {
            emailRegistry.set(email, new Set());
        }

        const accounts = emailRegistry.get(email);
        accounts.add(JSON.stringify({ accId, nickname, serverId }));

        debugLog(`Registered email ${email} for account ${accId} (${nickname})`);
    }

    function getEmailDuplicates(email, currentAccId) {
        if (!email || !emailRegistry.has(email)) return [];

        const accounts = emailRegistry.get(email);
        const duplicates = [];

        for (const accountStr of accounts) {
            const account = JSON.parse(accountStr);
            if (account.accId !== currentAccId) {
                duplicates.push(account);
            }
        }

        return duplicates;
    }

    function hasEmailDuplicates(email, currentAccId) {
        return getEmailDuplicates(email, currentAccId).length > 0;
    }

    function registerVkId(vkId, accId, nickname, serverId, displayName) {
        if (!vkId || !accId) return;

        if (!vkRegistry.has(vkId)) {
            vkRegistry.set(vkId, new Set());
        }

        const accounts = vkRegistry.get(vkId);
        accounts.add(JSON.stringify({ accId, nickname, serverId, displayName }));

        debugLog(`Registered VK ID ${vkId} for account ${accId} (${nickname})`);
    }

    function getVkDuplicates(vkId, currentAccId) {
        if (!vkId || !vkRegistry.has(vkId)) return [];

        const accounts = vkRegistry.get(vkId);
        const duplicates = [];

        for (const accountStr of accounts) {
            const account = JSON.parse(accountStr);
            if (account.accId !== currentAccId) {
                duplicates.push(account);
            }
        }

        return duplicates;
    }

    function hasVkDuplicates(vkId, currentAccId) {
        return getVkDuplicates(vkId, currentAccId).length > 0;
    }

    function registerTgId(tgId, accId, nickname, serverId, tgUsername) {
        if (!tgId || !accId) return;

        if (!tgRegistry.has(tgId)) {
            tgRegistry.set(tgId, new Set());
        }

        const accounts = tgRegistry.get(tgId);
        accounts.add(JSON.stringify({ accId, nickname, serverId, tgUsername }));

        debugLog(`Registered TG ID ${tgId} for account ${accId} (${nickname})`);
    }

    function getTgDuplicates(tgId, currentAccId) {
        if (!tgId || !tgRegistry.has(tgId)) return [];

        const accounts = tgRegistry.get(tgId);
        const duplicates = [];

        for (const accountStr of accounts) {
            const account = JSON.parse(accountStr);
            if (account.accId !== currentAccId) {
                duplicates.push(account);
            }
        }

        return duplicates;
    }

    function hasTgDuplicates(tgId, currentAccId) {
        return getTgDuplicates(tgId, currentAccId).length > 0;
    }

    function createCopyButton(textToCopy, emoji = '📋') {
        const btn = document.createElement('button');
        btn.className = 'attachment-copy-emoji-btn';
        btn.textContent = emoji;
        btn.title = 'Копировать';
        btn.type = 'button';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            navigator.clipboard.writeText(textToCopy).then(() => {
                const originalText = btn.textContent;
                btn.textContent = '✓';
                setTimeout(() => {
                    btn.textContent = originalText;
                }, 1500);
            }).catch(err => {
                debugLog('Failed to copy:', err);
            });
        });
        return btn;
    }

    function createCopyButtonWithMenu(value, type, emoji = '📋') {
        const btn = document.createElement('button');
        btn.className = 'attachment-copy-emoji-btn';
        btn.textContent = emoji;
        btn.title = 'Копировать (клик для меню)';
        btn.type = 'button';

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            showCopyMenu(btn, value, type);
        });

        return btn;
    }

    function showCopyMenu(anchorElement, value, type) {
        const existingMenu = document.querySelector('.copy-menu-popup');
        if (existingMenu) {
            existingMenu.remove();
            if (existingMenu.dataset.value === value && existingMenu.dataset.type === type) {
                return;
            }
        }

        const menu = document.createElement('div');
        menu.className = 'copy-menu-popup';
        menu.dataset.value = value;
        menu.dataset.type = type;

        let command1 = '';
        let command1Label = '';
        let command2 = '';
        let command2Label = '';
        let valueLabel = '';

        if (type === 'VK') {
            command1 = `/vk ${value}`;
            command1Label = `/vk ${value}`;
            command2 = `/vkban ${value}`;
            command2Label = `/vkban ${value}`;
            valueLabel = `VK ID: ${value}`;
        } else if (type === 'TG') {
            command1 = `/tg ${value}`;
            command1Label = `/tg ${value}`;
            command2 = `/tgban ${value}`;
            command2Label = `/tgban ${value}`;
            valueLabel = `TG ID: ${value}`;
        } else if (type === 'email') {
            command1 = `/mail ${value}`;
            command1Label = `/mail ${value}`;
            command2 = `/mailban ${value}`;
            command2Label = `/mailban ${value}`;
            valueLabel = value;
        }

        const copyValueBtn = document.createElement('button');
        copyValueBtn.className = 'copy-menu-item';
        copyValueBtn.innerHTML = `<span class="copy-menu-icon">📋</span><span class="copy-menu-text">${valueLabel}</span>`;
        copyValueBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(value).then(() => {
                copyValueBtn.innerHTML = `<span class="copy-menu-icon">✓</span><span class="copy-menu-text">Скопировано!</span>`;
                setTimeout(() => menu.remove(), 500);
            });
        });

        const copyCommand1Btn = document.createElement('button');
        copyCommand1Btn.className = 'copy-menu-item copy-menu-item-command';
        copyCommand1Btn.innerHTML = `<span class="copy-menu-icon">⌨️</span><span class="copy-menu-text">${command1Label}</span>`;
        copyCommand1Btn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(command1).then(() => {
                copyCommand1Btn.innerHTML = `<span class="copy-menu-icon">✓</span><span class="copy-menu-text">Скопировано!</span>`;
                setTimeout(() => menu.remove(), 500);
            });
        });

        const copyCommand2Btn = document.createElement('button');
        copyCommand2Btn.className = 'copy-menu-item copy-menu-item-ban';
        copyCommand2Btn.innerHTML = `<span class="copy-menu-icon">🚫</span><span class="copy-menu-text">${command2Label}</span>`;
        copyCommand2Btn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(command2).then(() => {
                copyCommand2Btn.innerHTML = `<span class="copy-menu-icon">✓</span><span class="copy-menu-text">Скопировано!</span>`;
                setTimeout(() => menu.remove(), 500);
            });
        });

        menu.appendChild(copyValueBtn);
        menu.appendChild(copyCommand1Btn);
        menu.appendChild(copyCommand2Btn);

        document.body.appendChild(menu);
        const rect = anchorElement.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${rect.left}px`;
        menu.style.zIndex = '10001';

        function closeMenu(e) {
            if (!menu.contains(e.target) && e.target !== anchorElement) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        }

        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    function processAttachments() {
        if (pageIsHiding) return;
        const tableBody = document.querySelector('table.table-hover tbody');
        if (!tableBody) return;

        const rows = tableBody.querySelectorAll('tr');
        const urlParams = new URLSearchParams(window.location.search);
        const serverId = urlParams.get('server_number');

        rows.forEach((row) => {
            if (processedAttachmentRows.has(row)) return;

            const cells = row.querySelectorAll('td');
            if (cells.length < 2) return;

            const actionCell = cells[1];
            if (!actionCell) return;

            const actionText = actionCell.textContent || '';
            const accountIds = extractAccountIds(row, 1);
            const accId = accountIds.length > 0 ? accountIds[0] : null;

            const vkAttachMatch = actionText.match(/Игрок\s+(\S+)\s+привязывает\s+аккаунт\s+(.+?)\s+\(VK\s+ID:\s+(\d+)\)/i);
            if (vkAttachMatch) {
                const [_, nickname, displayName, vkId] = vkAttachMatch;
                if (vkId && accId) {
                    registerVkId(vkId, accId, nickname, serverId, displayName);
                }
            }

            const tgAttachMatch = actionText.match(/Игрок\s+(\S+)\s+привязывает\s+аккаунт\s+(@\S+)\s+\(TG\s+ID:\s+(\d+)\)/i);
            if (tgAttachMatch) {
                const [_, nickname, tgUsername, tgId] = tgAttachMatch;
                if (tgId && accId) {
                    registerTgId(tgId, accId, nickname, serverId, tgUsername);
                }
            }

            const emailAttachMatch = actionText.match(/Игрок\s+(\S+)\s+изменил\s+почту\s+(.+?)\s+на\s+(.+?)(?:\s|$)/i);
            if (emailAttachMatch) {
                const [_, nickname, oldEmail, newEmail] = emailAttachMatch;

                if (newEmail && accId) {
                    registerEmail(newEmail, accId, nickname, serverId);
                }
            }
        });

        rows.forEach((row) => {
            if (processedAttachmentRows.has(row)) return;

            const cells = row.querySelectorAll('td');
            if (cells.length < 2) return;

            const actionCell = cells[1];
            if (!actionCell) return;

            const actionText = actionCell.textContent || '';
            const accountIds = extractAccountIds(row, 1);
            const accId = accountIds.length > 0 ? accountIds[0] : null;

            const vkAttachMatch = actionText.match(/Игрок\s+(\S+)\s+привязывает\s+аккаунт\s+(.+?)\s+\(VK\s+ID:\s+(\d+)\)/i);
            if (vkAttachMatch) {
                const [_, nickname, fullName, vkId] = vkAttachMatch;
                addAttachmentCopyButtons(actionCell, nickname, vkId, 'VK', accId);
                processedAttachmentRows.add(row);
                return;
            }

            const tgAttachMatch = actionText.match(/Игрок\s+(\S+)\s+привязывает\s+аккаунт\s+(@\S+)\s+\(TG\s+ID:\s+(\d+)\)/i);
            if (tgAttachMatch) {
                const [_, nickname, tgUsername, tgId] = tgAttachMatch;
                addAttachmentCopyButtons(actionCell, nickname, tgId, 'TG', accId);
                processedAttachmentRows.add(row);
                return;
            }

            const emailAttachMatch = actionText.match(/Игрок\s+(\S+)\s+изменил\s+почту\s+(.+?)\s+на\s+(.+?)(?:\s|$)/i);
            if (emailAttachMatch) {
                const [_, nickname, oldEmail, newEmail] = emailAttachMatch;

                addEmailCopyButtons(actionCell, nickname, oldEmail, newEmail, accId);
                processedAttachmentRows.add(row);
                return;
            }
        });
    }

    function addAttachmentCopyButtons(cell, nickname, idValue, type, accId) {
        if (cell.querySelector('.attachment-copy-emoji-btn')) return;

        const strongElements = cell.querySelectorAll('strong');
        let nicknameElement = null;

        for (const strong of strongElements) {
            if (strong.textContent.trim() === nickname) {
                nicknameElement = strong;
                break;
            }
        }

        if (nicknameElement) {
            const nickCopyBtn = createCopyButton(nickname, '👤');
            nicknameElement.parentNode.insertBefore(document.createTextNode(' '), nicknameElement.nextSibling);
            nicknameElement.parentNode.insertBefore(nickCopyBtn, nicknameElement.nextSibling.nextSibling);
        }

        const idPattern = type === 'VK'
            ? new RegExp(`VK\\s+ID:\\s+(${idValue})`)
            : new RegExp(`TG\\s+ID:\\s+(${idValue})`);

        const walker = document.createTreeWalker(
            cell,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        let textNode;
        while (textNode = walker.nextNode()) {
            const match = textNode.textContent.match(idPattern);
            if (match) {
                const beforeText = textNode.textContent.substring(0, match.index + match[0].length);
                const afterText = textNode.textContent.substring(match.index + match[0].length);

                const beforeNode = document.createTextNode(beforeText);
                const afterNode = document.createTextNode(afterText);
                const idCopyBtn = createCopyButtonWithMenu(idValue, type, '📋');
                idCopyBtn.style.marginLeft = '4px';

                const parent = textNode.parentNode;
                parent.insertBefore(beforeNode, textNode);
                parent.insertBefore(document.createTextNode(' '), textNode);
                parent.insertBefore(idCopyBtn, textNode);
                if (afterText) {
                    parent.insertBefore(afterNode, textNode);
                }
                parent.removeChild(textNode);
                break;
            }
        }

        if (accId) {
            let hasDuplicates = false;
            let duplicates = [];
            let indicatorClass = '';
            let popupTitle = '';

            if (type === 'VK' && hasVkDuplicates(idValue, accId)) {
                hasDuplicates = true;
                duplicates = getVkDuplicates(idValue, accId);
                indicatorClass = 'vk-duplicate-indicator';
                popupTitle = `VK ID дублируется на ${duplicates.length} аккаунт(ах)`;
            } else if (type === 'TG' && hasTgDuplicates(idValue, accId)) {
                hasDuplicates = true;
                duplicates = getTgDuplicates(idValue, accId);
                indicatorClass = 'tg-duplicate-indicator';
                popupTitle = `TG ID дублируется на ${duplicates.length} аккаунт(ах)`;
            }

            if (hasDuplicates) {
                const dupIndicator = document.createElement('button');
                dupIndicator.type = 'button';
                dupIndicator.className = indicatorClass;
                dupIndicator.dataset.idValue = idValue;
                dupIndicator.dataset.type = type;
                dupIndicator.dataset.accId = accId;
                dupIndicator.title = popupTitle;
                dupIndicator.textContent = `⚠️ ${duplicates.length}`;
                dupIndicator.style.marginLeft = '4px';

                dupIndicator.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    showSocialDuplicatesPopup(dupIndicator, idValue, type, accId);
                });

                cell.appendChild(document.createTextNode(' '));
                cell.appendChild(dupIndicator);
            }
        }
    }

    function addEmailCopyButtons(cell, nickname, oldEmail, newEmail, accId) {
        if (cell.querySelector('.attachment-copy-emoji-btn')) return;

        const strongElements = cell.querySelectorAll('strong');
        let nicknameElement = null;

        for (const strong of strongElements) {
            if (strong.textContent.trim() === nickname) {
                nicknameElement = strong;
                break;
            }
        }

        if (nicknameElement) {
            const nickCopyBtn = createCopyButton(nickname, '👤');
            nicknameElement.parentNode.insertBefore(document.createTextNode(' '), nicknameElement.nextSibling);
            nicknameElement.parentNode.insertBefore(nickCopyBtn, nicknameElement.nextSibling.nextSibling);
        }

        const walker = document.createTreeWalker(
            cell,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        let textNode;
        const processedNodes = new Set();

        while (textNode = walker.nextNode()) {
            if (processedNodes.has(textNode)) continue;

            const text = textNode.textContent;

            if (text.includes(newEmail)) {
                const emailIndex = text.indexOf(newEmail);
                const beforeText = text.substring(0, emailIndex + newEmail.length);
                const afterText = text.substring(emailIndex + newEmail.length);

                const beforeNode = document.createTextNode(beforeText);
                const emailCopyBtn = createCopyButtonWithMenu(newEmail, 'email', '📧');
                emailCopyBtn.style.marginLeft = '4px';

                const parent = textNode.parentNode;
                parent.insertBefore(beforeNode, textNode);
                parent.insertBefore(document.createTextNode(' '), textNode);
                parent.insertBefore(emailCopyBtn, textNode);

                if (afterText.trim()) {
                    const afterNode = document.createTextNode(afterText);
                    parent.insertBefore(afterNode, textNode);
                }

                parent.removeChild(textNode);
                processedNodes.add(textNode);
                break;
            }

            if (oldEmail && oldEmail !== 'null' && oldEmail !== '' && text.includes(oldEmail)) {
                const emailIndex = text.indexOf(oldEmail);
                const beforeText = text.substring(0, emailIndex + oldEmail.length);
                const afterText = text.substring(emailIndex + oldEmail.length);

                const beforeNode = document.createTextNode(beforeText);
                const emailCopyBtn = createCopyButtonWithMenu(oldEmail, 'email', '📧');
                emailCopyBtn.style.marginLeft = '4px';

                const parent = textNode.parentNode;
                parent.insertBefore(beforeNode, textNode);
                parent.insertBefore(document.createTextNode(' '), textNode);
                parent.insertBefore(emailCopyBtn, textNode);

                if (afterText.trim()) {
                    const afterNode = document.createTextNode(afterText);
                    parent.insertBefore(afterNode, textNode);
                }

                parent.removeChild(textNode);
                processedNodes.add(textNode);
            }
        }

        if (accId && hasEmailDuplicates(newEmail, accId)) {
            const duplicates = getEmailDuplicates(newEmail, accId);
            const dupIndicator = document.createElement('button');
            dupIndicator.type = 'button';
            dupIndicator.className = 'email-duplicate-indicator';
            dupIndicator.dataset.email = newEmail;
            dupIndicator.dataset.accId = accId;
            dupIndicator.title = `Email дублируется на ${duplicates.length} аккаунт(ах)`;
            dupIndicator.textContent = `⚠️ ${duplicates.length}`;
            dupIndicator.style.marginLeft = '4px';

            dupIndicator.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                showEmailDuplicatesPopup(dupIndicator, newEmail, accId);
            });

            cell.appendChild(document.createTextNode(' '));
            cell.appendChild(dupIndicator);
        }
    }


    function showEmailDuplicatesPopup(anchorElement, email, currentAccId) {
        const existingPopup = document.querySelector('.email-duplicates-popup');
        if (existingPopup) {
            existingPopup.remove();
            return; // Toggle behavior
        }

        const duplicates = getEmailDuplicates(email, currentAccId);
        if (!duplicates.length) return;

        const popup = document.createElement('div');
        popup.className = 'email-duplicates-popup';

        const header = document.createElement('div');
        header.className = 'email-duplicates-popup-header';
        header.textContent = `Дубликаты Email: ${email}`;
        popup.appendChild(header);

        const list = document.createElement('div');
        list.className = 'email-duplicates-popup-list';

        duplicates.forEach((account) => {
            const item = document.createElement('div');
            item.className = 'email-duplicates-popup-item';

            const accountInfo = document.createElement('div');
            accountInfo.className = 'email-duplicates-popup-account';

            const nicknameDiv = document.createElement('div');
            nicknameDiv.className = 'email-duplicates-popup-label';
            nicknameDiv.innerHTML = `<strong>Никнейм:</strong> ${account.nickname} <span style="color: #ffc107;">[${account.accId}]</span>`;
            accountInfo.appendChild(nicknameDiv);

            item.appendChild(accountInfo);
            list.appendChild(item);
        });

        popup.appendChild(list);

        function updatePosition() {
            const rect = anchorElement.getBoundingClientRect();
            popup.style.top = `${rect.bottom + 5}px`;
            popup.style.left = `${rect.left}px`;
        }

        function handleScroll() {
            updatePosition();
        }

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

        window.addEventListener('scroll', handleScroll, true);

        document.body.appendChild(popup);
        popup.style.position = 'fixed';
        updatePosition();
    }

    function showSocialDuplicatesPopup(anchorElement, idValue, type, currentAccId) {
        const existingPopup = document.querySelector('.social-duplicates-popup');
        if (existingPopup) {
            existingPopup.remove();
            return; // Toggle behavior
        }

        const duplicates = type === 'VK'
            ? getVkDuplicates(idValue, currentAccId)
            : getTgDuplicates(idValue, currentAccId);
        if (!duplicates.length) return;

        const popup = document.createElement('div');
        popup.className = 'social-duplicates-popup';
        popup.style.border = type === 'VK' ? '1px solid #4a76a8' : '1px solid #0088cc';

        const header = document.createElement('div');
        header.className = 'social-duplicates-popup-header';
        header.classList.add(type === 'VK' ? 'vk-header' : 'tg-header');
        header.textContent = `Дубликаты ${type} ID: ${idValue}`;
        popup.appendChild(header);

        const list = document.createElement('div');
        list.className = 'social-duplicates-popup-list';

        duplicates.forEach((account) => {
            const item = document.createElement('div');
            item.className = 'social-duplicates-popup-item';

            const accountInfo = document.createElement('div');
            accountInfo.className = 'social-duplicates-popup-account';

            const nicknameDiv = document.createElement('div');
            nicknameDiv.className = 'social-duplicates-popup-label';
            const colorStyle = type === 'VK' ? '#4a76a8' : '#0088cc';
            nicknameDiv.innerHTML = `<strong>Никнейм:</strong> ${account.nickname} <span style="color: ${colorStyle};">[${account.accId}]</span>`;
            accountInfo.appendChild(nicknameDiv);

            if (type === 'VK' && account.displayName) {
                const displayDiv = document.createElement('div');
                displayDiv.className = 'social-duplicates-popup-label';
                displayDiv.innerHTML = `<strong>VK:</strong> ${account.displayName}`;
                accountInfo.appendChild(displayDiv);
            } else if (type === 'TG' && account.tgUsername) {
                const usernameDiv = document.createElement('div');
                usernameDiv.className = 'social-duplicates-popup-label';
                usernameDiv.innerHTML = `<strong>TG:</strong> ${account.tgUsername}`;
                accountInfo.appendChild(usernameDiv);
            }

            item.appendChild(accountInfo);
            list.appendChild(item);
        });

        popup.appendChild(list);

        function updatePosition() {
            const rect = anchorElement.getBoundingClientRect();
            popup.style.top = `${rect.bottom + 5}px`;
            popup.style.left = `${rect.left}px`;
        }

        function handleScroll() {
            updatePosition();
        }

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

        window.addEventListener('scroll', handleScroll, true);

        document.body.appendChild(popup);
        popup.style.position = 'fixed';
        updatePosition();
    }

    const attachmentStyles = document.createElement('style');
    attachmentStyles.textContent = `
        .attachment-copy-emoji-btn {
            background: rgba(58, 187, 209, 0.15);
            border: 1px solid rgba(58, 187, 209, 0.3);
            border-radius: 3px;
            cursor: pointer;
            font-size: 14px;
            padding: 2px 4px;
            transition: all 0.2s ease;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-left: 4px;
            user-select: none;
        }

        .attachment-copy-emoji-btn:hover {
            background: rgba(58, 187, 209, 0.3);
            border-color: rgba(58, 187, 209, 0.5);
            transform: scale(1.1);
        }

        .attachment-copy-emoji-btn:active {
            transform: scale(0.95);
        }

        .email-duplicate-indicator {
            padding: 2px 6px;
            background: rgba(255, 193, 7, 0.2);
            border: 1px solid rgba(255, 193, 7, 0.5);
            border-radius: 3px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-left: 4px;
            user-select: none;
        }

        .email-duplicate-indicator:hover {
            background: rgba(255, 193, 7, 0.4);
            border-color: rgba(255, 193, 7, 0.7);
            transform: scale(1.1);
        }

        .email-duplicates-popup {
            position: fixed;
            background: #1c1f23;
            border: 1px solid #ffc107;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            z-index: 10000;
            min-width: 300px;
            max-width: 500px;
            max-height: 400px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .email-duplicates-popup-header {
            padding: 12px 16px;
            background: rgba(255, 193, 7, 0.2);
            border-bottom: 1px solid #ffc107;
            color: #ffc107;
            font-weight: 600;
            font-size: 13px;
            word-break: break-all;
        }

        .email-duplicates-popup-list {
            padding: 8px;
            overflow-y: auto;
            flex: 1;
        }

        .email-duplicates-popup-item {
            padding: 10px;
            margin-bottom: 8px;
            background: #252a30;
            border-radius: 4px;
            border: 1px solid #3a3f45;
        }

        .email-duplicates-popup-item:last-child {
            margin-bottom: 0;
        }

        .email-duplicates-popup-account {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .email-duplicates-popup-label {
            font-size: 12px;
            color: rgba(236, 241, 249, 0.85);
        }

        .email-duplicates-popup-label strong {
            color: #fff;
        }

        /* VK duplicate indicator */
        .vk-duplicate-indicator {
            padding: 2px 6px;
            background: rgba(74, 118, 168, 0.2);
            border: 1px solid rgba(74, 118, 168, 0.5);
            border-radius: 3px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-left: 4px;
            user-select: none;
        }

        .vk-duplicate-indicator:hover {
            background: rgba(74, 118, 168, 0.4);
            border-color: rgba(74, 118, 168, 0.7);
            transform: scale(1.1);
        }

        /* TG duplicate indicator */
        .tg-duplicate-indicator {
            padding: 2px 6px;
            background: rgba(0, 136, 204, 0.2);
            border: 1px solid rgba(0, 136, 204, 0.5);
            border-radius: 3px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-left: 4px;
            user-select: none;
        }

        .tg-duplicate-indicator:hover {
            background: rgba(0, 136, 204, 0.4);
            border-color: rgba(0, 136, 204, 0.7);
            transform: scale(1.1);
        }

        /* Social duplicates popup */
        .social-duplicates-popup {
            position: fixed;
            background: #1c1f23;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            z-index: 10000;
            min-width: 300px;
            max-width: 500px;
            max-height: 400px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .social-duplicates-popup-header {
            padding: 12px 16px;
            font-weight: 600;
            font-size: 13px;
            word-break: break-all;
        }

        .social-duplicates-popup-header.vk-header {
            background: rgba(74, 118, 168, 0.2);
            border-bottom: 1px solid #4a76a8;
            color: #4a76a8;
        }

        .social-duplicates-popup-header.tg-header {
            background: rgba(0, 136, 204, 0.2);
            border-bottom: 1px solid #0088cc;
            color: #0088cc;
        }

        .social-duplicates-popup-list {
            padding: 8px;
            overflow-y: auto;
            flex: 1;
        }

        .social-duplicates-popup-item {
            padding: 10px;
            margin-bottom: 8px;
            background: #252a30;
            border-radius: 4px;
            border: 1px solid #3a3f45;
        }

        .social-duplicates-popup-item:last-child {
            margin-bottom: 0;
        }

        .social-duplicates-popup-account {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .social-duplicates-popup-label {
            font-size: 12px;
            color: rgba(236, 241, 249, 0.85);
        }

        .social-duplicates-popup-label strong {
            color: #fff;
        }

        /* Copy menu popup */
        .copy-menu-popup {
            background: #1c1f23;
            border: 1px solid #3a3f45;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            padding: 4px;
            min-width: 150px;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .copy-menu-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: transparent;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            color: rgba(236, 241, 249, 0.85);
            font-size: 13px;
            text-align: left;
            transition: all 0.15s ease;
            white-space: nowrap;
        }

        .copy-menu-item:hover {
            background: rgba(58, 187, 209, 0.15);
            color: #fff;
        }

        .copy-menu-item-command {
            color: #3abbd1;
        }

        .copy-menu-item-command:hover {
            background: rgba(58, 187, 209, 0.25);
            color: #3abbd1;
        }

        .copy-menu-item-ban {
            color: #e74c3c;
        }

        .copy-menu-item-ban:hover {
            background: rgba(231, 76, 60, 0.2);
            color: #e74c3c;
        }

        .copy-menu-icon {
            font-size: 14px;
            width: 18px;
            text-align: center;
        }

        .copy-menu-text {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
        }
    `;
    document.head.appendChild(attachmentStyles);

    // Запускаем обработку при загрузке страницы
    runWhenReady(processAttachments);

    // ============================================
    // ЕДИНЫЙ ОПТИМИЗИРОВАННЫЙ MUTATIONOBSERVER
    // ============================================

    // Инициализация кнопок split/csv - один раз при загрузке
    runWhenReady(() => {
        addSplitButton();
    });

    // Объединённый debounced обработчик DOM изменений
    // Наблюдает только за tbody таблицы для оптимизации
    //
    // Важно: MutationObserver может вызвать callback несколько раз подряд (например,
    // сначала при добавлении новых строк, затем при пост-обработке цен/вложений).
    // Обычный debounce возьмёт "последние" mutations и может пропустить добавление кнопок.
    // Поэтому накапливаем mutations в буфер и обрабатываем их пачкой.
    let pendingDOMMutations = [];

    const processDOMMutations = debounce(() => {
        if (pageIsHiding) return;

        const mutations = pendingDOMMutations;
        pendingDOMMutations = [];

        let shouldProcessPrices = false;
        let shouldAddInteractionButtons = false;
        let shouldProcessAttachments = false;

        if (Array.isArray(mutations) && mutations.length > 0) {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;

                    if (!shouldAddInteractionButtons) {
                        if (node.matches?.('tr') || node.querySelector?.('tr')) {
                            shouldAddInteractionButtons = true;
                            shouldProcessAttachments = true;
                        }
                    }

                    if (!shouldProcessPrices) {
                        const text = node.textContent || '';
                        if ((text.includes('ID:') || text.includes('id:')) &&
                            (text.includes('Кол-во') || text.includes('количестве') || text.includes('получил') || text.includes('потерял'))) {
                            shouldProcessPrices = true;
                        }
                    }

                    if (shouldProcessPrices && shouldAddInteractionButtons && shouldProcessAttachments) {
                        break;
                    }
                }
                if (shouldProcessPrices && shouldAddInteractionButtons && shouldProcessAttachments) {
                    break;
                }
            }
        } else {
            shouldAddInteractionButtons = true;
            shouldProcessAttachments = true;
        }

        if (shouldProcessPrices && (itemPricesMap.size > 0 || vehiclePricesMap.size > 0)) {
            processItemPrices();
        }

        if (shouldAddInteractionButtons) {
            addInteractionButtons();
        }

        if (shouldProcessAttachments) {
            processAttachments();
        }
    }, 150);

    const unifiedObserver = new MutationObserver((mutations) => {
        if (pageIsHiding) return;
        if (Array.isArray(mutations) && mutations.length > 0) {
            pendingDOMMutations.push(...mutations);
        }
        processDOMMutations();
    });

    runWhenReady(() => {
        const tableBody = document.querySelector('table.table-hover tbody');
        if (tableBody) {
            unifiedObserver.observe(tableBody, { childList: true, subtree: true });
            debugLog('MutationObserver установлен на tbody таблицы');
        } else {
            debugLog('tbody таблицы не найден, observer не установлен');
        }
    });


})();



















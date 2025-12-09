// Arizona RP Logs Period Splitter
// Автоматическое разбиение больших периодов на части
// + отображение цен предметов

(function() {
    'use strict';

    // Максимальный безопасный период (по умолчанию)
    let maxSafeMonths = 9;
    let autoSplitEnabled = true; // По умолчанию включено
    let csvButtonEnabled = true; // По умолчанию включено

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
                autoSplitPeriod();
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
            debugLog('Выявлено совпадение полей периода, запускаем дополнительный поиск поля "Период до"');

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
            // Приводим значение к строке, игнорируем null/undefined
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
    function autoSplitPeriod() {
        let form = null;

        try {
            let { periodFrom, periodTo } = findDateFields();

            const directPeriodFrom = document.querySelector('input[name="min_period"]');
            const directPeriodTo = document.querySelector('input[name="max_period"]');

            if (directPeriodFrom) periodFrom = directPeriodFrom;
            if (directPeriodTo) periodTo = directPeriodTo;

            if (!periodFrom || !periodTo) {
                alert('Браузер заблокировал часть вкладок. На странице появился список ссылок для ручного открытия.');
                safeSubmit(document.querySelector('form'), 'period-fields-not-found');
                return;
            }

            form = periodFrom.closest('form') || periodTo.closest('form') || document.querySelector('form');

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

    // Добавляем наблюдатель за изменениями DOM на случай динамической загрузки
    const observer = new MutationObserver(() => {
        if (!document.getElementById(AUTO_SPLIT_BUTTON_ID) || !document.getElementById(EXPORT_CSV_BUTTON_ID)) {
            addSplitButton();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

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

            const tryAddItem = (id, price) => {
                const normalized = normalizePriceValue(price);
                if (id && normalized) {
                    itemPricesMap.set(String(id), normalized);
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
                        if (item && (item.id || item.name) && item.price !== undefined) {
                            tryAddItem(item.id || item.name, item.price);
                        }
                    }
                } else if (typeof parsedJson === 'object') {
                    for (const [key, value] of Object.entries(parsedJson)) {
                        if (value && typeof value === 'object' && value.price !== undefined) {
                            tryAddItem(key, value.price);
                        } else {
                            tryAddItem(key, value);
                        }
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
                        if (item && (item.id || item.name) && item.price !== undefined) {
                            tryAddItem(item.id || item.name, item.price);
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

            const tryAddItem = (id, price) => {
                const normalized = normalizePriceValue(price);
                if (id && normalized) {
                    itemPricesMap.set(String(id), normalized);
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
                        if (item && (item.id || item.name) && item.price !== undefined) {
                            tryAddItem(item.id || item.name, item.price);
                        }
                    }
                } else if (typeof parsedJson === 'object') {
                    for (const [key, value] of Object.entries(parsedJson)) {
                        if (value && typeof value === 'object' && value.price !== undefined) {
                            tryAddItem(key, value.price);
                        } else {
                            tryAddItem(key, value);
                        }
                    }
                }
            }

            if (applied === 0) {
                const lines = text.split('\n').filter(line => line.trim());
                for (const line of lines) {
                    try {
                        const item = JSON.parse(line);
                        if (item && (item.id || item.name) && item.price !== undefined) {
                            tryAddItem(item.id || item.name, item.price);
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
                const normalized = normalizePriceValue(rawValue);
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

    // Поиск и добавление цен к предметам
    function processItemPrices() {
        // Регулярные выражения для поиска ID в разных форматах:
        // (ID: 1637  | или [id: 1425]
        const idPatterns = [
            /\[id:\s*(\d+)\]/i,    // [id: 1425]
            /\(ID:\s*(\d+)/i     // (ID: 1637
        ];

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

        // Получаем весь текст родительского элемента
        const fullText = parent.textContent;
        const fullTextLower = fullText ? fullText.toLowerCase() : '';

            // Проверяем, не добавлена ли уже цена
            if (parent.querySelector('.item-price-display')) {
                return;
            }

            // Пропускаем строки с пополнением склада (там уже указана фактическая сумма)
            if (fullTextLower.includes('пополняет склад')) {
                return;
            }

            let itemId = null;
            let quantity = 1; // По умолчанию количество = 1

            // Пробуем найти ID по всем паттернам
            const candidateIds = [];
            for (const pattern of idPatterns) {
                const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
                const regex = new RegExp(pattern.source, flags);
                let match;
                while ((match = regex.exec(fullText)) !== null) {
                    candidateIds.push(match[1]);
                }
            }

            if (candidateIds.length) {
                const knownId = candidateIds.find(id => itemPricesMap.has(String(id)));
                itemId = knownId || candidateIds[candidateIds.length - 1];
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
                            const parentNode = textNode.parentElement;

                            const priceSpan = document.createElement('span');
                            priceSpan.className = 'item-price-display';
                            priceSpan.innerHTML = ` <span style="color: #ffc107; font-weight: bold;">💱 ${currency.key} → $${formatPrice(rate)} | Всего - $${formatPrice(total)}</span>`;

                            if (textNode.nextSibling) {
                                parentNode.insertBefore(priceSpan, textNode.nextSibling);
                            } else {
                                parentNode.appendChild(priceSpan);
                            }

                            processedNodes.add(textNode);
                            processedCount++;
                        }
                        break;
                    }
                }
                return;
            }

            if (itemId) {
                const pricePerItem = normalizePriceValue(itemPricesMap.get(itemId));

                if (pricePerItem) {
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

                    // Вычисляем общую стоимость
                    const totalPrice = {
                        min: pricePerItem.min * quantity,
                        max: pricePerItem.max * quantity
                    };

                    // Создаем элемент с ценой
                    const priceSpan = document.createElement('span');
                    priceSpan.className = 'item-price-display';

                    // Если количество > 1, показываем обе цены
                    if (quantity > 1) {
                        priceSpan.innerHTML = ` <span style="color: #4dd0e1; font-weight: bold;">💰 Цена 1 шт ~ ${formatPriceRange(pricePerItem)} | Всего (×${quantity}) - ${formatPriceRange(totalPrice)}</span>`;
                    } else {
                        priceSpan.innerHTML = ` <span style="color: #4dd0e1; font-weight: bold;">💰 Цена 1 шт ~ ${formatPriceRange(pricePerItem)}</span>`;
                    }

                    // Если есть span с суммой денег, вставляем СРАЗУ ПОСЛЕ него
                    if (moneySpan) {
                        if (moneySpan.nextSibling) {
                            parent.insertBefore(priceSpan, moneySpan.nextSibling);
                        } else {
                            parent.appendChild(priceSpan);
                        }
                    } else {
                        // Иначе вставляем после последнего текстового узла (в конец строки)
                        if (lastTextNode.nextSibling) {
                            parent.insertBefore(priceSpan, lastTextNode.nextSibling);
                        } else {
                            parent.appendChild(priceSpan);
                        }
                    }
                    processedCount++;
                    processedNodes.add(textNode);
                }
            }

            if (!processedVehicleNodes.has(textNode) && vehiclePricesMap.size > 0) {
                const existingVehiclePrice = parent.querySelector('.vehicle-price-display');
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

    // Наблюдатель за динамическими изменениями для добавления цен
    const pricesObserver = new MutationObserver((mutations) => {
        // Проверяем, добавились ли новые элементы с предметами
        let hasNewItems = false;

        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const text = node.textContent || '';
                        // Проверяем разные форматы: (ID: или [id: или получил/потерял
                        if ((text.includes('ID:') || text.includes('id:')) &&
                            (text.includes('Кол-во') || text.includes('количестве') || text.includes('получил') || text.includes('потерял'))) {
                            hasNewItems = true;
                            break;
                        }
                    }
                }
            }
            if (hasNewItems) break;
        }

        if (hasNewItems && (itemPricesMap.size > 0 || vehiclePricesMap.size > 0)) {
            setTimeout(processItemPrices, 100);
        }
    });

    // Запуск загрузки цен при загрузке страницы
    runWhenReady(loadPriceData);

    // Запускаем наблюдатель за изменениями
    pricesObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

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
        return multiUrlState.enabled &&
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

    // Инициализация Multi-URL функционала
    function initMultiUrl() {
        loadMultiUrlConfig();

        // Создаем кнопку для управления
        runWhenReady(createMultiUrlToggleButton);

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
        scrollListenerAttached: false
    };

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
                    // ignore
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

        const applySelectEnhancement = () => setupLimitSelect(preferredLimit, handleLimitChange);
        applySelectEnhancement();

        const limitObserver = new MutationObserver(applySelectEnhancement);
        limitObserver.observe(document.body, { childList: true, subtree: true });
    }

    runWhenReady(() => {
        void initPreferredLimitControl();
    });

    // ============================================
    // ФУНКЦИОНАЛ ИСТОРИИ ВЗАИМОДЕЙСТВИЙ
    // ============================================

    function addInteractionButtons() {
        const tableBody = document.querySelector('table.table-hover tbody');
        if (!tableBody) return;

        const rows = tableBody.querySelectorAll('tr');
        rows.forEach(row => {
            // Пропускаем, если кнопка уже добавлена
            if (row.querySelector('.interaction-history-btn')) {
                return;
            }

            const cells = row.querySelectorAll('td');
            if (cells.length < 2) return;

            const actionCell = cells[1];
            const links = actionCell.querySelectorAll('a[href*="player="]');

            // Нужен хотя бы один игрок в записи
            if (links.length === 0) return;

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
        // if (secondaryQueryValue) {
        //     logsUrl.searchParams.set('target', secondaryQueryValue);
        // }
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

    // Наблюдаем за динамическими изменениями
    const interactionObserver = new MutationObserver(() => {
        addInteractionButtons();
    });

    interactionObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    maybeScrollToInteractionFocus();

})();






















(function() {
    const DEFAULT_MONTHS = 9;
    const DEFAULT_AUTO_SPLIT_ENABLED = true;
    const DEFAULT_CSV_BUTTON_ENABLED = true;
    const DEFAULT_SUSPICIOUS_BUTTON_ENABLED = false;
    const DEFAULT_MULTI_URL_BUTTON_ENABLED = false;
    const OBJECT_LIST_URL = 'https://items.shinoa.tech/items.php';
    const OBJECT_LIST_SUGGESTED_NAME = 'object_names.json';

    function showStatus(message, isError = false) {
        const status = document.getElementById('status');
        if (!status) return;
        status.textContent = message || '';
        status.style.color = isError ? '#ff6f61' : '#9be7ff';
    }

    function updateToggleButton(button, isEnabled, enabledText, disabledText) {
        if (!button) return;

        if (isEnabled) {
            button.classList.remove('toggle-btn--off');
            button.textContent = enabledText;
        } else {
            button.classList.add('toggle-btn--off');
            button.textContent = disabledText;
        }
    }

    function updatePriceStats() {
        chrome.storage.local.get('priceOverrides', (result) => {
            const priceOverrides = result.priceOverrides || {};
            const count = Object.entries(priceOverrides)
                .filter(([, value]) => normalizeOverrideEntry(value))
                .length;
            const statsDiv = document.getElementById('priceStats');
            if (statsDiv) {
                statsDiv.textContent = count > 0
                    ? `Переопределений цен: {count}`.replace('{count}', count)
                    : 'Переопределений цен нет.';
            }
        });
    }

    function downloadObjectsListForPriceParser() {
        if (!chrome?.downloads?.download) {
            showStatus('chrome.downloads is unavailable.', true);
            return;
        }

        showStatus('Выбери куда сохранить object_names.json...', false);
        chrome.downloads.download({
            url: OBJECT_LIST_URL,
            filename: OBJECT_LIST_SUGGESTED_NAME,
            saveAs: true,
            conflictAction: 'overwrite'
        }, () => {
            const error = chrome.runtime.lastError;
            if (error) {
                showStatus('Ошибка скачивания: ' + error.message, true);
                return;
            }
            showStatus('Загрузка начата. Сохрани как moonloader/priceparser_cache/object_names.json', false);
            setTimeout(() => showStatus(''), 4000);
        });
    }

    async function loadPricesJsonl() {
        const pricesUrl = chrome.runtime.getURL('prices.jsonl');
        const response = await fetch(pricesUrl);
        if (!response.ok) {
            throw new Error(`Failed to load prices: ${response.status}`);
        }
        return await response.text();
    }

    // Извлекает цену из объекта формата {sa: {price}, vc: {price}}
    function extractPriceFromItem(value) {
        if (!value || typeof value !== 'object') {
            return value;
        }

        // Новый формат с двумя валютами: {sa: {price, updated}, vc: {price, updated}}
        if (value.sa || value.vc) {
            const saPrice = value.sa?.price;
            const vcPrice = value.vc?.price;

            // Приоритет SA$, если нет — VC$
            if (saPrice !== undefined && saPrice !== null) {
                return saPrice;
            }
            if (vcPrice !== undefined && vcPrice !== null) {
                return vcPrice;
            }
            return null;
        }

        if (value.price !== undefined) {
            return value.price;
        }

        return value;
    }

    function normalizePriceValue(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') {
            const numeric = Number(value.replace(/\s+/g, ''));
            if (Number.isFinite(numeric)) return numeric;
        }
        if (typeof value === 'object') {
            // Сначала пробуем извлечь цену из нового формата
            const extracted = extractPriceFromItem(value);
            if (extracted !== value) {
                const nested = normalizePriceValue(extracted);
                if (nested !== null) return nested;
            }
            // Старая логика для {min, max}
            const min = Number(value.min ?? value[0] ?? value['1']);
            const max = Number(value.max ?? value[1] ?? value['2']);
            const normalized = {};
            if (Number.isFinite(min)) normalized.min = min;
            if (Number.isFinite(max)) normalized.max = max;
            return Object.keys(normalized).length ? normalized : null;
        }
        return null;
    }

    function normalizeOverrideEntry(rawValue) {
        if (rawValue === null || rawValue === undefined) return null;
        const priceSource =
            typeof rawValue === 'object' && rawValue !== null && rawValue.price !== undefined
                ? rawValue.price
                : rawValue;
        const normalizedPrice = normalizePriceValue(priceSource);
        if (normalizedPrice === null || typeof normalizedPrice === 'object') {
            return null;
        }

        const updatedCandidate =
            typeof rawValue === 'object' && rawValue !== null ? rawValue.updated : null;
        const updated = Number(updatedCandidate);

        return {
            price: normalizedPrice,
            updated: Number.isFinite(updated) ? updated : null
        };
    }

    function buildPriceMapFromPayload(text) {
        const map = {};

        const tryAdd = (id, info) => {
            if (!id) return;
            const extracted = extractPriceFromItem(info);
            const priceValue = normalizePriceValue(extracted);
            if (priceValue === null) return;
            const entry = { price: priceValue };
            if (info && typeof info === 'object') {
                if (info.name) entry.name = info.name;
                // Для нового формата берём updated из sa или vc
                const updated = info.updated ?? info.sa?.updated ?? info.vc?.updated;
                if (updated) entry.updated = updated;
            }
            map[String(id)] = entry;
        };

        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }

        if (parsed) {
            if (Array.isArray(parsed)) {
                parsed.forEach(item => {
                    const itemId = item?.id ?? item?.item_id ?? item?.name;
                    tryAdd(itemId, item);
                });
            } else if (typeof parsed === 'object') {
                Object.entries(parsed).forEach(([key, value]) => {
                    if (value && typeof value === 'object' && (value.id !== undefined || value.item_id !== undefined)) {
                        tryAdd(value.id ?? value.item_id, value);
                    } else {
                        tryAdd(key, value);
                    }
                });
            }
        }

        if (Object.keys(map).length === 0) {
            const lines = text.split('\n').filter(line => line.trim());
            lines.forEach(line => {
                try {
                    const item = JSON.parse(line);
                    const itemId = item?.id ?? item?.item_id ?? item?.name;
                    tryAdd(itemId, item);
                } catch {
                    // ignore broken lines
                }
            });
        }

        return map;
    }

    async function exportPricesWithOverrides() {
        try {
            showStatus('Готовлю custom_prices.json...', false);
    
            const basePricesText = await loadPricesJsonl();
            const priceMap = buildPriceMapFromPayload(basePricesText);
    
            const result = await new Promise((resolve) => {
                chrome.storage.local.get('priceOverrides', resolve);
            });
            const overrides = result.priceOverrides || {};
            const nowTs = Math.floor(Date.now() / 1000);
            const exportPayload = {};
    
            Object.entries(overrides).forEach(([id, rawValue]) => {
                const normalized = normalizeOverrideEntry(rawValue);
                if (!normalized) return;
    
            const baseInfo = priceMap[id];
            const entry = {
                price: normalized.price,
                updated: normalized.updated ?? nowTs
            };
            exportPayload[id] = entry;
        });
    
            const exportedCount = Object.keys(exportPayload).length;
            const updatedContent = JSON.stringify(exportPayload, null, 2);
    
            const blob = new Blob([updatedContent], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = 'custom_prices.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
    
            showStatus(
                exportedCount > 0
                    ? `Сохранено переопределений: ${exportedCount}`
                    : 'Нет переопределений для экспорта'
            );
            setTimeout(() => showStatus(''), 2500);
        } catch (error) {
            console.error('Export error:', error);
            showStatus('Ошибка экспорта: ' + error.message, true);
        }
    }
    
    async function resetAllPrices() {
        if (!confirm('Сбросить все пользовательские цены? Это действие нельзя отменить.')) {
            return;
        }

        try {
            showStatus('Сбрасываю пользовательские цены...', false);
            await new Promise((resolve) => {
                chrome.storage.local.set({ priceOverrides: {} }, resolve);
            });
            updatePriceStats();
            showStatus('Пользовательские цены сброшены');
            setTimeout(() => showStatus(''), 1500);
        } catch (error) {
            console.error('Reset error:', error);
            showStatus('Ошибка при сбросе: ' + error.message, true);
        }
    }

    function loadCurrentValue() {
        if (!chrome?.storage?.local?.get) {
            showStatus('chrome.storage недоступен', true);
            return;
        }

        chrome.storage.local.get({
            maxSafeMonths: DEFAULT_MONTHS,
            autoSplitEnabled: DEFAULT_AUTO_SPLIT_ENABLED,
            csvButtonEnabled: DEFAULT_CSV_BUTTON_ENABLED,
            suspiciousButtonEnabled: DEFAULT_SUSPICIOUS_BUTTON_ENABLED,
            multiUrlButtonEnabled: DEFAULT_MULTI_URL_BUTTON_ENABLED
        }, (result) => {
            const input = document.getElementById('maxMonths');
            if (input) {
                const value = Number(result.maxSafeMonths) || DEFAULT_MONTHS;
                input.value = value;
            }

            const autoSplitToggleBtn = document.getElementById('autoSplitToggleBtn');
            updateToggleButton(
                autoSplitToggleBtn,
                result.autoSplitEnabled !== false,
                'Автоделение логов ВКЛ',
                'Автоделение логов ВЫКЛ'
            );

            const csvToggleBtn = document.getElementById('csvButtonToggleBtn');
            const suspiciousButtonToggleBtn = document.getElementById('suspiciousButtonToggleBtn');
            const multiUrlToggleBtn = document.getElementById('multiUrlToggleBtn');
            updateToggleButton(
                csvToggleBtn,
                result.csvButtonEnabled !== false,
                'Кнопка Скачать CSV ВКЛ',
                'Кнопка Скачать CSV ВЫКЛ'
            );

            updateToggleButton(
                suspiciousButtonToggleBtn,
                result.suspiciousButtonEnabled === true,
                'Кнопка Поиск подозрительных сделок ВКЛ',
                'Кнопка Поиск подозрительных сделок ВЫКЛ'
            );
            updateToggleButton(
                multiUrlToggleBtn,
                result.multiUrlButtonEnabled === true,
                'Кнопка Multi-URL ВКЛ',
                'Кнопка Multi-URL ВЫКЛ'
            );

            showStatus('Настройки загружены');
            setTimeout(() => showStatus(''), 1500);
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        const form = document.getElementById('settingsForm');
        const input = document.getElementById('maxMonths');
        const autoSplitToggleBtn = document.getElementById('autoSplitToggleBtn');
        const csvToggleBtn = document.getElementById('csvButtonToggleBtn');
        const suspiciousButtonToggleBtn = document.getElementById('suspiciousButtonToggleBtn');
        const multiUrlToggleBtn = document.getElementById('multiUrlToggleBtn');

        if (!form || !input) {
            return;
        }

        loadCurrentValue();

        if (autoSplitToggleBtn) {
            autoSplitToggleBtn.addEventListener('click', () => {
                chrome.storage.local.get({ autoSplitEnabled: DEFAULT_AUTO_SPLIT_ENABLED }, (result) => {
                    const newState = !result.autoSplitEnabled;
                    chrome.storage.local.set({ autoSplitEnabled: newState }, () => {
                        updateToggleButton(
                            autoSplitToggleBtn,
                            newState,
                            'Автоделение логов ВКЛ',
                            'Автоделение логов ВЫКЛ'
                        );
                        showStatus(newState ? 'Автоделение логов включено' : 'Автоделение логов выключено');
                        setTimeout(() => showStatus(''), 1500);
                    });
                });
            });
        }

        if (csvToggleBtn) {
            csvToggleBtn.addEventListener('click', () => {
                chrome.storage.local.get({ csvButtonEnabled: DEFAULT_CSV_BUTTON_ENABLED }, (result) => {
                    const newState = !result.csvButtonEnabled;
                    chrome.storage.local.set({ csvButtonEnabled: newState }, () => {
                        updateToggleButton(
                            csvToggleBtn,
                            newState,
                            'Кнопка Скачать CSV ВКЛ',
                            'Кнопка Скачать CSV ВЫКЛ'
                        );
                        showStatus(newState ? 'Кнопка CSV включена' : 'Кнопка CSV выключена');
                        setTimeout(() => showStatus(''), 1500);
                    });
                });
            });
        }

        if (suspiciousButtonToggleBtn) {
            suspiciousButtonToggleBtn.addEventListener('click', () => {
                chrome.storage.local.get({ suspiciousButtonEnabled: DEFAULT_SUSPICIOUS_BUTTON_ENABLED }, (result) => {
                    const newState = !result.suspiciousButtonEnabled;
                    chrome.storage.local.set({ suspiciousButtonEnabled: newState }, () => {
                        updateToggleButton(
                            suspiciousButtonToggleBtn,
                            newState,
                            'Кнопка Поиск подозрительных сделок ВКЛ',
                            'Кнопка Поиск подозрительных сделок ВЫКЛ'
                        );
                        showStatus(newState ? 'Кнопка Поиск подозрительных сделок включена' : 'Кнопка Поиск подозрительных сделок выключена');
                        setTimeout(() => showStatus(''), 1500);
                    });
                });
            });
        }

        if (multiUrlToggleBtn) {
            multiUrlToggleBtn.addEventListener('click', () => {
                chrome.storage.local.get({ multiUrlButtonEnabled: DEFAULT_MULTI_URL_BUTTON_ENABLED }, (result) => {
                    const newState = !result.multiUrlButtonEnabled;
                    chrome.storage.local.set({ multiUrlButtonEnabled: newState }, () => {
                        updateToggleButton(
                            multiUrlToggleBtn,
                            newState,
                            'Кнопка Multi-URL ВКЛ',
                            'Кнопка Multi-URL ВЫКЛ'
                        );
                        showStatus(newState ? 'Кнопка Multi-URL включена' : 'Кнопка Multi-URL выключена');
                        setTimeout(() => showStatus(''), 1500);
                    });
                });
            });
        }

        const exportPricesBtn = document.getElementById('exportPricesBtn');
        if (exportPricesBtn) {
            exportPricesBtn.addEventListener('click', exportPricesWithOverrides);
        }

        const resetAllPricesBtn = document.getElementById('resetAllPricesBtn');
        if (resetAllPricesBtn) {
            resetAllPricesBtn.addEventListener('click', resetAllPrices);
        }

        const downloadObjectsBtn = document.getElementById('downloadObjectsBtn');
        if (downloadObjectsBtn) {
            downloadObjectsBtn.addEventListener('click', downloadObjectsListForPriceParser);
        }

        updatePriceStats();

        form.addEventListener('submit', (event) => {
            event.preventDefault();

            const value = Number(input.value);
            if (!Number.isFinite(value) || value < 1) {
                showStatus('Введите число больше 0', true);
                return;
            }

            const normalized = Math.max(1, Math.floor(value));

            if (!chrome?.storage?.local?.set) {
                showStatus('chrome.storage недоступен', true);
                return;
            }

            chrome.storage.local.set({
                maxSafeMonths: normalized
            }, () => {
                showStatus('Настройки сохранены');
                input.value = normalized;
                setTimeout(() => showStatus(''), 1500);
            });
        });
    });
})();

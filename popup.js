(function() {
    const DEFAULT_MONTHS = 9;
    const DEFAULT_AUTO_SPLIT_ENABLED = true;
    const DEFAULT_CSV_BUTTON_ENABLED = true;
    const DEFAULT_SUSPICIOUS_SETTINGS = {
        trunk: {
            threshold: 10_000_000,
            windowMinutes: 180
        },
        mail: {
            minPlayers: 2
        }
    };

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
            const count = Object.keys(priceOverrides).length;
            const statsDiv = document.getElementById('priceStats');
            if (statsDiv) {
                if (count > 0) {
                    statsDiv.textContent = `Отредактировано товаров: ${count}`;
                } else {
                    statsDiv.textContent = 'Нет отредактированных цен';
                }
            }
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

    function normalizePriceValue(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') {
            const numeric = Number(value.replace(/\s+/g, ''));
            if (Number.isFinite(numeric)) return numeric;
        }
        if (typeof value === 'object') {
            if (value.price !== undefined) {
                const nested = normalizePriceValue(value.price);
                if (nested !== null) return nested;
            }
            const min = Number(value.min ?? value[0] ?? value['1']);
            const max = Number(value.max ?? value[1] ?? value['2']);
            const normalized = {};
            if (Number.isFinite(min)) normalized.min = min;
            if (Number.isFinite(max)) normalized.max = max;
            return Object.keys(normalized).length ? normalized : null;
        }
        return null;
    }

    function buildPriceMapFromPayload(text) {
        const map = {};

        const tryAdd = (id, info) => {
            if (!id) return;
            const priceValue = normalizePriceValue(info?.price ?? info);
            if (priceValue === null) return;
            const entry = { price: priceValue };
            if (info && typeof info === 'object') {
                if (info.name) entry.name = info.name;
                if (info.updated) entry.updated = info.updated;
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
            showStatus('Готовим custom_prices.json...', false);

            const basePricesText = await loadPricesJsonl();
            const priceMap = buildPriceMapFromPayload(basePricesText);

            const result = await new Promise((resolve) => {
                chrome.storage.local.get('priceOverrides', resolve);
            });
            const overrides = result.priceOverrides || {};
            const nowTs = Math.floor(Date.now() / 1000);

            Object.entries(overrides).forEach(([id, value]) => {
                const normalized = normalizePriceValue(value);
                if (normalized === null) return;
                const existing = priceMap[id] || {};
                priceMap[id] = {
                    ...existing,
                    price: normalized,
                    name: existing.name,
                    updated: nowTs
                };
            });

            const updatedContent = JSON.stringify(priceMap, null, 2);

            const blob = new Blob([updatedContent], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'custom_prices.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showStatus(`Сохранено: ${Object.keys(overrides).length} кастомных цен`);
            setTimeout(() => showStatus(''), 2500);
        } catch (error) {
            console.error('Export error:', error);
            showStatus('Ошибка экспорта: ' + error.message, true);
        }
    }

    async function resetAllPrices() {
        if (!confirm('Вы уверены? Это удалит все отредактированные цены.')) {
            return;
        }

        try {
            showStatus('Сбрасываем цены...', false);
            await new Promise((resolve) => {
                chrome.storage.local.set({ priceOverrides: {} }, resolve);
            });
            updatePriceStats();
            showStatus('Все цены сброшены');
            setTimeout(() => showStatus(''), 1500);
        } catch (error) {
            console.error('Reset error:', error);
            showStatus('Ошибка сброса: ' + error.message, true);
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
            suspiciousSettings: DEFAULT_SUSPICIOUS_SETTINGS
        }, (result) => {
            const input = document.getElementById('maxMonths');
            if (input) {
                const value = Number(result.maxSafeMonths) || DEFAULT_MONTHS;
                input.value = value;
            }

            const suspiciousThreshold = document.getElementById('suspiciousThreshold');
            const suspiciousWindow = document.getElementById('suspiciousWindow');
            const mailMinPlayers = document.getElementById('mailMinPlayers');
            const trunkSettings = (result.suspiciousSettings && result.suspiciousSettings.trunk) || DEFAULT_SUSPICIOUS_SETTINGS.trunk;
            const mailSettings = (result.suspiciousSettings && result.suspiciousSettings.mail) || DEFAULT_SUSPICIOUS_SETTINGS.mail;
            if (suspiciousThreshold) {
                suspiciousThreshold.value = Number(trunkSettings.threshold) || DEFAULT_SUSPICIOUS_SETTINGS.trunk.threshold;
            }
            if (suspiciousWindow) {
                suspiciousWindow.value = Number(trunkSettings.windowMinutes) || DEFAULT_SUSPICIOUS_SETTINGS.trunk.windowMinutes;
            }
            if (mailMinPlayers) {
                mailMinPlayers.value = Number(mailSettings.minPlayers) || DEFAULT_SUSPICIOUS_SETTINGS.mail.minPlayers;
            }

            const autoSplitToggleBtn = document.getElementById('autoSplitToggleBtn');
            updateToggleButton(
                autoSplitToggleBtn,
                result.autoSplitEnabled !== false,
                '✓ Авто-разбиение включено',
                '✗ Авто-разбиение выключено'
            );

            const csvToggleBtn = document.getElementById('csvButtonToggleBtn');
            updateToggleButton(
                csvToggleBtn,
                result.csvButtonEnabled !== false,
                '✓ Кнопка «Скачать CSV» включена',
                '✗ Кнопка «Скачать CSV» выключена'
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
        const suspiciousThreshold = document.getElementById('suspiciousThreshold');
        const suspiciousWindow = document.getElementById('suspiciousWindow');
        const mailMinPlayers = document.getElementById('mailMinPlayers');

        if (!form || !input) {
            return;
        }

        loadCurrentValue();

        // Toggle для авто-разбиения
        if (autoSplitToggleBtn) {
            autoSplitToggleBtn.addEventListener('click', () => {
                chrome.storage.local.get({ autoSplitEnabled: DEFAULT_AUTO_SPLIT_ENABLED }, (result) => {
                    const newState = !result.autoSplitEnabled;
                    chrome.storage.local.set({ autoSplitEnabled: newState }, () => {
                        updateToggleButton(
                            autoSplitToggleBtn,
                            newState,
                            '✓ Авто-разбиение включено',
                            '✗ Авто-разбиение выключено'
                        );
                        showStatus(newState ? 'Авто-разбиение включено' : 'Авто-разбиение выключено');
                        setTimeout(() => showStatus(''), 1500);
                    });
                });
            });
        }

        // Toggle для кнопки CSV
        if (csvToggleBtn) {
            csvToggleBtn.addEventListener('click', () => {
                chrome.storage.local.get({ csvButtonEnabled: DEFAULT_CSV_BUTTON_ENABLED }, (result) => {
                    const newState = !result.csvButtonEnabled;
                    chrome.storage.local.set({ csvButtonEnabled: newState }, () => {
                        updateToggleButton(
                            csvToggleBtn,
                            newState,
                            '✓ Кнопка «Скачать CSV» включена',
                            '✗ Кнопка «Скачать CSV» выключена'
                        );
                        showStatus(newState ? 'Кнопка CSV включена' : 'Кнопка CSV выключена');
                        setTimeout(() => showStatus(''), 1500);
                    });
                });
            });
        }

        // Обработчик для экспорта цен
        const exportPricesBtn = document.getElementById('exportPricesBtn');
        if (exportPricesBtn) {
            exportPricesBtn.addEventListener('click', exportPricesWithOverrides);
        }

        // Обработчик для сброса всех цен
        const resetAllPricesBtn = document.getElementById('resetAllPricesBtn');
        if (resetAllPricesBtn) {
            resetAllPricesBtn.addEventListener('click', resetAllPrices);
        }

        // Обновляем статистику при открытии popup'а
        updatePriceStats();

        form.addEventListener('submit', (event) => {
            event.preventDefault();

            const value = Number(input.value);
            if (!Number.isFinite(value) || value < 1) {
                showStatus('Введите число больше 0', true);
                return;
            }

            const normalized = Math.max(1, Math.floor(value));

            const trunkThreshold = Number(suspiciousThreshold?.value);
            const trunkWindow = Number(suspiciousWindow?.value);
            const normalizedTrunkThreshold = Number.isFinite(trunkThreshold) && trunkThreshold > 0
                ? Math.floor(trunkThreshold)
                : DEFAULT_SUSPICIOUS_SETTINGS.trunk.threshold;
            const normalizedTrunkWindow = Number.isFinite(trunkWindow) && trunkWindow > 0
                ? Math.floor(trunkWindow)
                : DEFAULT_SUSPICIOUS_SETTINGS.trunk.windowMinutes;
            const mailMin = Number(mailMinPlayers?.value);
            const normalizedMailMin = Number.isFinite(mailMin) && mailMin > 1
                ? Math.floor(mailMin)
                : DEFAULT_SUSPICIOUS_SETTINGS.mail.minPlayers;

            if (!chrome?.storage?.local?.set) {
                showStatus('chrome.storage недоступен', true);
                return;
            }

            chrome.storage.local.set({
                maxSafeMonths: normalized,
                suspiciousSettings: {
                    trunk: {
                        threshold: normalizedTrunkThreshold,
                        windowMinutes: normalizedTrunkWindow
                    },
                    mail: {
                        minPlayers: normalizedMailMin
                    }
                }
            }, () => {
                showStatus('Сохранено');
                input.value = normalized;
                if (suspiciousThreshold) suspiciousThreshold.value = normalizedTrunkThreshold;
                if (suspiciousWindow) suspiciousWindow.value = normalizedTrunkWindow;
                if (mailMinPlayers) mailMinPlayers.value = normalizedMailMin;
                setTimeout(() => showStatus(''), 1500);
            });
        });
    });
})();

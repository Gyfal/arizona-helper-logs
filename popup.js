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

    async function exportPricesWithOverrides() {
        try {
            showStatus('Загрузка цен...', false);

            // Загружаем базовый prices.jsonl
            const basePricesText = await loadPricesJsonl();
            const lines = basePricesText.trim().split('\n');

            // Загружаем переопределения
            const result = await new Promise((resolve) => {
                chrome.storage.local.get('priceOverrides', resolve);
            });
            const overrides = result.priceOverrides || {};

            // Обновляем цены с переопределениями
            const updatedLines = lines.map((line) => {
                if (!line.trim()) return line;
                try {
                    const data = JSON.parse(line);
                    if (data.id && overrides[String(data.id)] !== undefined) {
                        data.price = overrides[String(data.id)];
                        data.updated = Math.floor(Date.now() / 1000);
                    }
                    return JSON.stringify(data);
                } catch (err) {
                    return line;
                }
            });

            const updatedContent = updatedLines.join('\n');

            // Скачиваем файл
            const blob = new Blob([updatedContent], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `prices_${new Date().toISOString().slice(0, 10)}.jsonl`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showStatus(`Экспортировано! Обновлено ${Object.keys(overrides).length} товаров`);
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

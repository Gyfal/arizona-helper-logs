(function() {
    'use strict';

    const DEBUG_PREFIX = '[ShinoaItemsPrices]';
    const PRICE_PLACEHOLDER = '—';
    let pricesMap = new Map(); // id -> price info
    let priceOverrides = new Map(); // id -> { price, updated } for edited prices

    debug('Items price helper starting...');
    loadPrices();

    function debug(...args) {
        console.log(DEBUG_PREFIX, ...args);
    }

    function toNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    function formatNumber(value) {
        return Number(value).toLocaleString('ru-RU');
    }

    // Извлекает цену из объекта с поддержкой нового формата {sa: {price}, vc: {price}}
    function extractPriceFromItem(value) {
        if (!value || typeof value !== 'object') {
            return { price: value, updated: null };
        }

        // Новый формат с двумя валютами: {sa: {price, updated}, vc: {price, updated}}
        if (value.sa || value.vc) {
            const saPrice = value.sa?.price;
            const vcPrice = value.vc?.price;

            // Приоритет SA$, если нет — VC$
            if (saPrice !== undefined && saPrice !== null) {
                return { price: saPrice, updated: value.sa?.updated };
            }
            if (vcPrice !== undefined && vcPrice !== null) {
                return { price: vcPrice, updated: value.vc?.updated };
            }
            return { price: null, updated: null };
        }

        // Старый формат: {price, updated}
        return { price: value.price, updated: value.updated };
    }

    function normalizePriceValue(price) {
        if (price === null || price === undefined) return null;
        if (typeof price === 'number' && Number.isFinite(price)) return price;
        if (typeof price === 'string') {
            const numeric = Number(price.replace(/\s+/g, ''));
            if (Number.isFinite(numeric)) return numeric;
        }
        if (typeof price === 'object') {
            const normalized = {};
            const min = toNumber(price.min);
            const max = toNumber(price.max);
            if (min !== null) normalized.min = min;
            if (max !== null) normalized.max = max;
            return Object.keys(normalized).length ? normalized : null;
        }
        return null;
    }

    function normalizeOverrideValue(rawValue) {
        if (rawValue === null || rawValue === undefined) return null;

        const priceSource =
            typeof rawValue === 'object' && rawValue !== null && rawValue.price !== undefined
                ? rawValue.price
                : rawValue;
        const numericPrice = Number(priceSource);
        if (!Number.isFinite(numericPrice)) return null;

        const updated = toNumber(
            typeof rawValue === 'object' && rawValue !== null ? rawValue.updated : null
        );

        return {
            price: numericPrice,
            updated: updated ?? null
        };
    }

    function addPriceEntry(id, info) {
        if (id === null || id === undefined || !info) return false;

        // Извлекаем цену с учётом нового формата
        const extracted = extractPriceFromItem(info);
        const normalizedPrice = normalizePriceValue(extracted.price);
        if (normalizedPrice === null) return false;

        pricesMap.set(String(id), {
            price: normalizedPrice,
            name: info.name,
            updated: extracted.updated ?? info.updated
        });

        return true;
    }

    function processParsedPrices(data) {
        let added = 0;

        if (!data) return added;

        if (Array.isArray(data)) {
            data.forEach((entry) => {
                const itemId = entry?.id ?? entry?.item_id;
                if (itemId !== undefined) {
                    if (addPriceEntry(itemId, entry)) added++;
                }
            });
            return added;
        }

        if (typeof data === 'object') {
            // Old style single object with id field
            if (data.id !== undefined || data.item_id !== undefined) {
                const itemId = data.id ?? data.item_id;
                if (addPriceEntry(itemId, data)) added++;
                return added;
            }

            // New style dictionary: { "123": { price, name, updated }, ... }
            for (const [itemId, info] of Object.entries(data)) {
                if (addPriceEntry(itemId, info)) added++;
            }
        }

        return added;
    }

    function pauseTableUpdates(table) {
        if (!table) return;
        table.__shinoaPauseUpdates = (table.__shinoaPauseUpdates || 0) + 1;
    }

    function resumeTableUpdates(table) {
        if (!table) return;
        table.__shinoaPauseUpdates = Math.max(0, (table.__shinoaPauseUpdates || 0) - 1);
    }

    function getTableSignature(tbody) {
        if (!tbody) return '';
        const rows = tbody.querySelectorAll('tr');
        return Array.from(rows)
            .map((row) => row.textContent.trim())
            .join('|');
    }

    async function loadCustomPriceFile() {
        try {
            const customUrl = chrome.runtime.getURL('custom_prices.json');
            const response = await fetch(customUrl);
            if (!response.ok) {
                if (response.status !== 404) {
                    debug('Custom prices file not loaded:', response.status);
                }
                return;
            }

            const text = (await response.text()).trim();
            let parsedCount = 0;

            try {
                const parsed = JSON.parse(text);
                parsedCount += processParsedPrices(parsed);
            } catch {
                const lines = text.split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        parsedCount += processParsedPrices(data);
                    } catch (err) {
                        console.warn(DEBUG_PREFIX, 'Failed to parse custom price line:', line, err);
                    }
                }
            }

            if (parsedCount > 0) {
                debug(`Custom prices applied from custom_prices.json (${parsedCount} entries)`);
            }
        } catch (error) {
            debug('Failed to load custom price file:', error);
        }
    }

    async function loadPrices() {
        try {
            const pricesUrl = chrome.runtime.getURL('prices.jsonl');
            debug('Loading prices from', pricesUrl);

            const response = await fetch(pricesUrl);
            if (!response.ok) {
                throw new Error(`Failed to load prices: ${response.status}`);
            }

            const text = (await response.text()).trim();
            let parsedCount = 0;

            // Try parsing as a whole JSON blob first (new format)
            try {
                const parsed = JSON.parse(text);
                parsedCount += processParsedPrices(parsed);
                if (parsedCount > 0) {
                    debug(`Parsed prices from bulk JSON payload (${parsedCount} entries added)`);
                }
            } catch {
                // Fallback to line-by-line parsing below
            }

            // Fallback: parse line-by-line (old JSONL format)
            if (parsedCount === 0) {
                const lines = text.split('\n');
                debug(`Loaded ${lines.length} raw lines from price file`);

                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const data = JSON.parse(line);
                        parsedCount += processParsedPrices(data);
                    } catch (err) {
                        console.warn(DEBUG_PREFIX, 'Failed to parse price line:', line, err);
                    }
                }
            }

            debug(`Prices map created with ${pricesMap.size} entries`);
            debug('First 5 price IDs:', Array.from(pricesMap.keys()).slice(0, 5));

            // Загружаем кастомный файл (общий для раздачи)
            await loadCustomPriceFile();

            // Загружаем сохраненные переопределения цен
            await loadPriceOverrides();

            // Начинаем наблюдать за таблицей
            waitForTable();
        } catch (error) {
            console.error(DEBUG_PREFIX, 'Failed to load prices:', error);
        }
    }

    async function loadPriceOverrides() {
        try {
            const result = await chrome.storage.local.get('priceOverrides');
            if (result.priceOverrides) {
                const parsedOverrides = Object.entries(result.priceOverrides)
                    .map(([key, value]) => {
                        const normalized = normalizeOverrideValue(value);
                        return normalized ? [key, normalized] : null;
                    })
                    .filter(Boolean);
                priceOverrides = new Map(parsedOverrides);
                debug(`Loaded ${priceOverrides.size} price overrides`);
            }
        } catch (error) {
            console.warn(DEBUG_PREFIX, 'Failed to load price overrides:', error);
        }
    }

    async function savePriceOverride(itemId, newPrice) {
        try {
            const itemIdStr = String(itemId);
            if (newPrice === null || newPrice === undefined) {
                priceOverrides.delete(itemIdStr);
            } else {
                const numericPrice = Number(newPrice);
                if (!Number.isFinite(numericPrice)) {
                    debug('Skipping save of invalid price override', newPrice);
                    return;
                }
                const existing = priceOverrides.get(itemIdStr);
                const existingUpdated =
                    existing && typeof existing === 'object' ? toNumber(existing.updated) : null;
                const nowTs = Math.floor(Date.now() / 1000);
                priceOverrides.set(itemIdStr, {
                    price: numericPrice,
                    updated: existingUpdated ?? nowTs
                });
            }

            const overridesObj = Object.fromEntries(
                Array.from(priceOverrides.entries())
                    .map(([id, raw]) => {
                        const normalized = normalizeOverrideValue(raw);
                        const nowTs = Math.floor(Date.now() / 1000);
                        if (!normalized) return null;
                        return [
                            id,
                            {
                                price: normalized.price,
                                updated: normalized.updated ?? nowTs
                            }
                        ];
                    })
                    .filter(Boolean)
            );
            await chrome.storage.local.set({ priceOverrides: overridesObj });
            debug(`Saved price override for item ${itemId}: ${newPrice}`);
        } catch (error) {
            console.error(DEBUG_PREFIX, 'Failed to save price override:', error);
        }
    }

    function getPriceForItem(itemId) {
        const itemIdStr = String(itemId);

        // Если есть переопределение, используем его
        if (priceOverrides.has(itemIdStr)) {
            const override = priceOverrides.get(itemIdStr);
            const overridePrice =
                typeof override === 'object' && override !== null ? override.price : override;
            const overrideUpdated =
                typeof override === 'object' && override !== null ? override.updated : null;
            return {
                price: overridePrice,
                name: pricesMap.get(itemIdStr)?.name,
                updated: overrideUpdated ?? pricesMap.get(itemIdStr)?.updated,
                isOverridden: true
            };
        }

        // Иначе возвращаем базовую цену
        const basePrice = pricesMap.get(itemIdStr);
        return basePrice ? { ...basePrice, isOverridden: false } : null;
    }

    function waitForTable() {
        // Ждем появления таблицы с данными
        const observer = new MutationObserver(() => {
            const table = document.querySelector('table');
            if (table) {
                debug('Table found, adding price column');
                observer.disconnect();
                addPriceColumn(table);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Проверяем, может таблица уже есть
        const existingTable = document.querySelector('table');
        if (existingTable) {
            debug('Table already exists, adding price column');
            observer.disconnect();
            addPriceColumn(existingTable);
        }
    }

    function addPriceColumn(table) {
        try {
            if (!table) return;

            if (!table.__shinoaPriceInitialized) {
                table.__shinoaPriceInitialized = true;
                debug('Initializing price column for table');
            }

            // Добавляем заголовок колонки "Цена" после первой колонки (ITEM)
            const thead = table.querySelector('thead tr');
            if (thead) {
                if (!thead.querySelector('.shinoa-price-header')) {
                    const priceHeader = document.createElement('th');
                    priceHeader.textContent = 'Цена';
                    priceHeader.style.textAlign = 'right';
                    priceHeader.style.paddingRight = '10px';
                    priceHeader.className = 'shinoa-price-header';

                    // Вставляем после первого th (ITEM)
                    const firstHeader = thead.querySelector('th:nth-child(2)');
                    if (firstHeader) {
                        thead.insertBefore(priceHeader, firstHeader);
                    } else {
                        thead.appendChild(priceHeader);
                    }
                    debug('Price header added');
                }
            }

            // Обновляем все строки таблицы
            updateTableRows(table);

            // Используем event delegation - добавляем один слушатель к таблице вместо слушателей к каждой ячейке
            if (!table.__shinoaDelegationAttached) {
                table.addEventListener('click', (e) => {
                    const cell = e.target.closest('.shinoa-price-cell');
                    if (cell) {
                        e.stopPropagation();
                        const itemId = cell.dataset.itemId;
                        if (itemId) {
                            startEditingPrice(cell, itemId);
                        }
                    }
                });

                table.addEventListener('dblclick', (e) => {
                    const cell = e.target.closest('.shinoa-price-cell');
                    if (cell) {
                        e.stopPropagation();
                        const itemId = cell.dataset.itemId;
                        if (itemId) {
                            resetPrice(cell, itemId);
                        }
                    }
                });

                table.__shinoaDelegationAttached = true;
                debug('Event delegation attached to table');
            }

            // Ищем поле поиска и добавляем слушатель
            const searchInput = document.querySelector('input[type="text"]');
            if (searchInput) {
                if (!searchInput.__shinoaPriceListener) {
                    debug('Found search input, attaching listener');
                    const debouncedUpdate = debounce(() => {
                        updateTableRows(table);
                    }, 80);
                    searchInput.addEventListener('input', debouncedUpdate);
                    searchInput.__shinoaPriceListener = true;
                }
            }

            const tbody = table.querySelector('tbody');
            if (tbody) {
                if (table.__shinoaPriceObserver) {
                    table.__shinoaPriceObserver.disconnect();
                }

                const debouncedUpdateRows = debounce(() => {
                    updateTableRows(table);
                }, 50);
                const observer = new MutationObserver(() => debouncedUpdateRows());

                observer.observe(tbody, {
                    childList: true,
                    characterData: true,
                    subtree: true
                });

                table.__shinoaPriceObserver = observer;
            }

            debug('Price column setup complete');
        } catch (error) {
            console.error(DEBUG_PREFIX, 'Failed to add price column:', error);
        }
    }

    function updateTableRows(table) {
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        if (table.__shinoaPriceUpdating) return;
        if (table.__shinoaPauseUpdates) return;

        const signature = getTableSignature(tbody);
        if (table.__shinoaLastSignature && table.__shinoaLastSignature === signature) {
            return;
        }

        table.__shinoaPriceUpdating = true;

        let added = 0;
        let updated = 0;

        try {
            const rows = tbody.querySelectorAll('tr');

            rows.forEach((row) => {
                const cells = row.querySelectorAll('td');
                if (cells.length === 0) return;

                // Находим ID предмета в строке
                const itemId = extractItemId(row);
                if (!itemId) return;

                // Получаем цену (с учетом переопределений)
                const priceInfo = getPriceForItem(itemId);

                // Проверяем, есть ли уже наша ячейка с ценой на второй позиции
                const existingPriceCell = cells[1] && cells[1].classList.contains('shinoa-price-cell');

                if (existingPriceCell) {
                    if (cells[1].__shinoaEditing) {
                        return;
                    }
                    // Обновляем существующую ячейку
                    applyPriceToCell(cells[1], priceInfo, itemId);
                    updated++;
                } else {
                    // Создаем новую ячейку с ценой
                    const priceCell = document.createElement('td');
                    priceCell.style.textAlign = 'right';
                    priceCell.style.paddingRight = '10px';
                    priceCell.style.fontWeight = 'bold';
                    priceCell.className = 'shinoa-price-cell';
                    priceCell.dataset.shinoaPrice = 'true';
                    priceCell.dataset.itemId = itemId;

                    applyPriceToCell(priceCell, priceInfo, itemId);

                    // Вставляем ячейку после первой колонки (ITEM)
                    const secondCell = row.querySelector('td:nth-child(2)');
                    if (secondCell) {
                        row.insertBefore(priceCell, secondCell);
                    } else {
                        row.appendChild(priceCell);
                    }
                    added++;
                }
            });
        } finally {
            table.__shinoaPriceUpdating = false;
            table.__shinoaLastSignature = signature;
        }

        if (!table.__shinoaPriceReady && (added > 0 || updated > 0)) {
            table.__shinoaPriceReady = true;
            debug(`Price column applied to ${added + updated} rows`);
        }
    }

    function extractItemId(row) {
        // Ищем ID в разных возможных местах
        // Вариант 1: data-id атрибут
        if (row.dataset.id) {
            return row.dataset.id;
        }

        // Вариант 2: ищем в ячейках
        const cells = row.querySelectorAll('td');
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            const text = cell.textContent.trim();

            // Обычно ID это число в одной из первых колонок
            if (/^\d+$/.test(text)) {
                return text;
            }
        }

        // Вариант 3: ищем в onclick или других атрибутах
        const onclick = row.getAttribute('onclick');
        if (onclick) {
            const match = onclick.match(/\d+/);
            if (match) {
                return match[0];
            }
        }

        return null;
    }

    function formatPrice(price) {
        if (price === null || price === undefined) return PRICE_PLACEHOLDER;

        if (typeof price === 'number' && Number.isFinite(price)) {
            return formatNumber(price) + ' $';
        }

        if (typeof price === 'object') {
            const min = toNumber(price.min);
            const max = toNumber(price.max);

            if (min !== null && max !== null) {
                return `${formatNumber(min)} - ${formatNumber(max)} $`;
            }
            if (min !== null) return `\u043e\u0442 ${formatNumber(min)} $`;
            if (max !== null) return `\u0434\u043e ${formatNumber(max)} $`;
        }

        return PRICE_PLACEHOLDER;
    }

    function formatDate(timestamp) {
        if (!timestamp) return 'n/a';
        try {
            if (typeof timestamp === 'string') {
                const parsedDate = new Date(timestamp);
                return parsedDate.toLocaleDateString('ru-RU');
            }
            const tsNum = Number(timestamp);
            if (!Number.isFinite(tsNum)) return 'n/a';
            const ms = tsNum > 1e12 ? tsNum : tsNum * 1000;
            const date = new Date(ms);
            return date.toLocaleDateString('ru-RU');
        } catch {
            return 'n/a';
        }
    }

    function applyPriceToCell(cell, priceInfo, itemId) {
        if (!cell) return;
        cell.dataset.itemId = itemId;
        if (priceInfo) {
            cell.textContent = formatPrice(priceInfo.price);
            if (priceInfo.isOverridden) {
                cell.style.color = '#FFD700';
                cell.style.backgroundColor = 'rgba(255, 215, 0, 0.1)';
                cell.className = 'shinoa-price-cell shinoa-price-cell--edited';
                const basePrice = pricesMap.get(String(itemId))?.price;
                const updatedLabel = priceInfo.updated ? formatDate(priceInfo.updated) : 'n/a';
                cell.title = `Manual override (${updatedLabel}). Base: ${formatPrice(basePrice)}. Double-click to reset.`;
                cell.style.cursor = 'pointer';
            } else {
                cell.style.color = '#4CAF50';
                cell.style.backgroundColor = '';
                cell.classList.remove('shinoa-price-cell--edited');
                const updatedLabel = priceInfo.updated ? formatDate(priceInfo.updated) : 'n/a';
                cell.title = `Updated: ${updatedLabel}.`;
                cell.style.cursor = 'pointer';
            }
        } else {
            cell.textContent = PRICE_PLACEHOLDER;
            cell.style.color = '#999';
            cell.style.backgroundColor = '';
            cell.classList.remove('shinoa-price-cell--edited');
            cell.title = 'No price data. Click to set a manual value.';
            cell.style.cursor = 'pointer';
        }
    }

    function startEditingPrice(cell, itemId) {
        if (cell.__shinoaEditing) return;

        cell.__shinoaEditing = true;
        const currentPrice = getPriceForItem(itemId);
        const priceValue = (() => {
            if (typeof currentPrice?.price === 'number' && Number.isFinite(currentPrice.price)) {
                return currentPrice.price;
            }
            if (currentPrice?.price && typeof currentPrice.price === 'object') {
                return toNumber(currentPrice.price.max) ?? toNumber(currentPrice.price.min) ?? '';
            }
            return '';
        })();

        const table = cell.closest('table');
        pauseTableUpdates(table);

        // ????????? ???????????? ??????????
        const originalContent = cell.textContent;
        const originalStyle = cell.style.cssText;

        // ??????? input
        const input = document.createElement('input');
        input.type = 'text';
        input.value = String(priceValue).replace(/\s+/g, '');
        input.style.width = '100%';
        input.style.padding = '4px 8px';
        input.style.border = '2px solid #4dd0e1';
        input.style.borderRadius = '4px';
        input.style.background = '#1f1f1f';
        input.style.color = '#f1f1f1';
        input.style.fontWeight = 'bold';
        input.style.textAlign = 'right';

        cell.textContent = '';
        cell.appendChild(input);
        input.focus();
        input.select();

        function finishEditing() {
            const newValue = input.value.trim();

            if (newValue === '') {
                // ?????? ???????? - ??????? ???????????????
                savePriceOverride(itemId, null);
            } else {
                const numValue = parseInt(newValue.replace(/\D/g, ''), 10);
                if (!isNaN(numValue) && numValue > 0) {
                    savePriceOverride(itemId, numValue);
                }
            }

            // ??????????????? ??? ????????? ???????????
            cell.textContent = '';
            const priceInfo = getPriceForItem(itemId);
            applyPriceToCell(cell, priceInfo, itemId);
            cell.__shinoaEditing = false;
            resumeTableUpdates(table);
            if (table) {
                updateTableRows(table);
            }
        }

        function cancelEditing() {
            cell.innerHTML = '';
            cell.style.cssText = originalStyle;
            cell.textContent = originalContent;
            cell.__shinoaEditing = false;
            resumeTableUpdates(table);
            if (table) {
                updateTableRows(table);
            }
        }

        input.addEventListener('blur', finishEditing);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finishEditing();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEditing();
            }
        });
    }

    function resetPrice(cell, itemId) {
        if (priceOverrides.has(String(itemId))) {
            savePriceOverride(itemId, null).then(() => {
                const priceInfo = getPriceForItem(itemId);
                applyPriceToCell(cell, priceInfo, itemId);
            });
        }
    }

    function debounce(fn, delay) {
        let timer = null;
        return function(...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }
})();

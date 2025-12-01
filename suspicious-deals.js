(function() {
    'use strict';

    const PREFIX = '[SuspiciousDeals]';
    const BUTTON_ID = 'suspiciousDealsBtn';
    const PANEL_ID = 'suspiciousDealsPanel';
    const DEFAULT_SUSPICIOUS_SETTINGS = {
        trunk: {
            threshold: 10_000_000, // $10kk
            windowMinutes: 180    // 3 часа
        },
        mail: {
            minPlayers: 2
        },
        house: {
            threshold: 10_000_000 // $10kk
        },
        warehouse: {
            moneyThreshold: 10_000_000 // $10kk
        }
    };
    const MINUTE_IN_MS = 60 * 1000;
    const HOUSE_SECTION_ID = 'suspiciousHouseSection';

    let itemPricesMap = new Map();
    let pricesLoaded = false;
    let pricesLoading = false;

    function log(...args) {
        console.log(PREFIX, ...args);
    }

    function normalizeWhitespace(value) {
        if (!value) return '';
        return value.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function getVisibleText(node) {
        if (!node) return '';
        const clone = node.cloneNode(true);
        clone.querySelectorAll('.item-price-display, .js_entry_format_button, .app-content-entry-format__button, .app__hidden').forEach(el => el.remove());
        clone.querySelectorAll('script, style').forEach(el => el.remove());
        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        const text = clone.textContent || '';
        return text.replace(/\u00A0/g, ' ');
    }

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

    function formatPrice(price) {
        return new Intl.NumberFormat('ru-RU').format(price);
    }

    function normalizePriceValue(value) {
        if (value === null || value === undefined) return null;
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
                if (min > max) [min, max] = [max, min];
                return { min, max };
            }
        }
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return { min: numeric, max: numeric };
        }
        return null;
    }

    async function loadItemPrices() {
        if (pricesLoaded || pricesLoading) return;
        pricesLoading = true;
        try {
            const pricesUrl = chrome.runtime.getURL('prices.jsonl');
            const response = await fetch(pricesUrl);
            if (!response.ok) {
                log('Не удалось загрузить prices.jsonl:', response.status);
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

            if (loaded === 0) {
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

            pricesLoaded = itemPricesMap.size > 0;
            log(`Загружено цен предметов для подозрительных сделок: ${itemPricesMap.size}`);
        } catch (error) {
            log('Ошибка при загрузке prices.jsonl:', error);
        } finally {
            pricesLoading = false;
        }
    }

    function findApplyButton() {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if (btn.textContent && btn.textContent.includes('Применить')) {
                return btn;
            }
        }
        return null;
    }

    function findDateFields() {
        let periodFrom = null;
        let periodTo = null;
        const labels = document.querySelectorAll('label, div, span, p');
        labels.forEach(label => {
            const text = label.textContent?.trim();
            if (text === 'Период от') {
                const input = label.parentElement?.querySelector('input') ||
                    label.nextElementSibling?.querySelector('input') ||
                    label.closest('div')?.querySelector('input');
                if (input && !periodFrom) periodFrom = input;
            }
            if (text === 'Период до') {
                const input = label.parentElement?.querySelector('input') ||
                    label.nextElementSibling?.querySelector('input') ||
                    label.closest('div')?.querySelector('input');
                if (input && !periodTo) periodTo = input;
            }
        });

        if (!periodFrom || !periodTo) {
            const allInputs = document.querySelectorAll('input');
            allInputs.forEach(input => {
                const placeholder = input.getAttribute('placeholder') || '';
                if (placeholder.includes('Период от') && !periodFrom) periodFrom = input;
                if (placeholder.includes('Период до') && !periodTo) periodTo = input;
            });
        }

        return { periodFrom, periodTo };
    }

    function insertControlButton(button, applyButton, periodTo, form) {
        if (!button) return;
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

    function createSuspiciousButton() {
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.className = 'logs-utility-button logs-utility-button--alert';
        button.textContent = '🚩 Поиск подозрительных сделок';
        button.title = 'Показывает передачи через багажник между разными игроками с крупными суммами';
        button.style.width = '100%';
        button.style.maxWidth = '300px';
        button.style.marginBottom = '10px';
        button.addEventListener('click', () => {
            runSuspiciousScan().catch(err => {
                log('Ошибка при поиске подозрительных сделок', err);
                alert('Не удалось выполнить поиск. См. консоль.');
            });
        });
        return button;
    }

    function addSuspiciousButton() {
        setTimeout(() => {
            if (document.getElementById(BUTTON_ID)) return;
            const { periodFrom, periodTo } = findDateFields();
            const applyButton = findApplyButton();
            const hasFilters = Boolean(applyButton) || (periodFrom && periodTo);
            const hasLogsTable = Boolean(document.querySelector('table.table-hover'));

            // Не добавляем кнопку на страницах авторизации/без логов и фильтров
            if (!hasFilters && !hasLogsTable) {
                return;
            }

            const form = periodFrom?.closest('form') ||
                periodTo?.closest('form') ||
                applyButton?.closest('form') ||
                document.querySelector('form');
            const btn = createSuspiciousButton();
            insertControlButton(btn, applyButton, periodTo, form);
        }, 1200);
    }

    function extractQuantityFromText(text) {
        if (!text) return 1;
        const patterns = [
            /в количестве\s+(\d+)/i,
            /кол-во\s+(\d+)/i,
            /количестве\s+(\d+)/i
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const value = parseInt(match[1], 10);
                if (Number.isFinite(value) && value > 0) return value;
            }
        }
        return 1;
    }

    function extractPrimaryPlayer(row) {
        const actionCell = row.querySelectorAll('td')[1];
        const link = actionCell?.querySelector('a[href*="player="]');
        const fromLink = normalizeWhitespace(link?.textContent || '');
        if (fromLink) return fromLink;
        const plainText = normalizeWhitespace(getVisibleText(actionCell));
        const match = plainText.match(/игрок\s+([A-Za-z0-9_]+)/i);
        return match ? match[1] : '';
    }

    function extractAccountIds(row, maxCount) {
        if (!row) return [];
        const accountIds = [];
        const infoButtons = row.querySelectorAll('.js_entry_format_button');

        for (const button of infoButtons) {
            if (Number.isFinite(maxCount) && maxCount > 0 && accountIds.length >= maxCount) break;
            const hiddenInfo = button.nextElementSibling;
            if (!hiddenInfo || !hiddenInfo.classList?.contains('app__hidden')) continue;
            const accountLi = Array.from(hiddenInfo.querySelectorAll('li'))
                .find((li) => /ID\s+аккаунта/i.test(li.textContent || ''));
            if (!accountLi) continue;
            const codeElement = accountLi.querySelector('code');
            const rawValue = (codeElement?.textContent || accountLi.textContent || '').trim();
            const match = rawValue.match(/\d+/);
            if (!match) continue;
            const normalizedId = match[0].replace(/^0+/, '') || '0';
            accountIds.push(normalizedId);
        }
        return accountIds;
    }

    function extractPlayersFromMailRow(text) {
        if (!text) return '';
        const match = text.match(/игрок\s+([A-Za-z0-9_]+)/i);
        return match ? match[1] : '';
    }

    function isSamePlayer(player1, player2) {
        if (!player1 || !player2) return false;
        if (player1.accountId && player2.accountId) {
            return player1.accountId === player2.accountId;
        }
        if (player1.player && player2.player) {
            return player1.player === player2.player;
        }
        return false;
    }

    function parseMoneyValue(raw) {
        if (!raw) return null;
        const num = Number(raw.replace(/[^\d]/g, ''));
        return Number.isFinite(num) ? num : null;
    }

    function extractItemName(actionText) {
        if (!actionText) return '';
        const match = actionText.match(/багажник[а]?\s+(.+?)\s*\[id:\s*\d+\]\s*\[id:\s*\d+\]/i);
        if (match) return normalizeWhitespace(match[1]);
        return '';
    }

    function parseCarInteractionRow(row) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return null;
        const actionText = normalizeWhitespace(getVisibleText(cells[1])) || '';
        const lower = actionText.toLowerCase();
        if (!lower.includes('багажник')) return null;

        let direction = null;
        if (lower.includes('взял из багажника') || lower.includes('забрал из багажника')) {
            direction = 'take';
        } else if (lower.includes('положил в багажник') || lower.includes('поместил в багажник')) {
            direction = 'put';
        }
        if (!direction) return null;

        const ids = Array.from(actionText.matchAll(/\[id:\s*(\d+)\]/gi));
        if (ids.length < 2) return null;

        const vehicleId = ids[0][1];
        const itemId = ids[1][1];
        const player = extractPrimaryPlayer(row) || 'Неизвестно';
        const quantity = extractQuantityFromText(actionText);
        const itemName = extractItemName(actionText) || `ID ${itemId}`;

        const timestampStr = normalizeWhitespace(getVisibleText(cells[0]));
        const timestamp = parseDate(timestampStr);

        const priceRange = normalizePriceValue(itemPricesMap.get(String(itemId)));
        const totalRange = priceRange
            ? { min: priceRange.min * quantity, max: priceRange.max * quantity }
            : null;
        const approxValue = totalRange ? (totalRange.min + totalRange.max) / 2 : null;

        return {
            vehicleId,
            itemId,
            itemName,
            quantity,
            direction,
            player,
            timestamp,
            timestampStr,
            approxValue
        };
    }

    function collectCarEventsFromTable() {
        const tableBody = document.querySelector('table.table-hover tbody');
        if (!tableBody) return [];
        return Array.from(tableBody.querySelectorAll('tr'))
            .map(parseCarInteractionRow)
            .filter(Boolean);
    }

    function parseMailChangeRow(row) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return null;
        const actionText = normalizeWhitespace(getVisibleText(cells[1])) || '';
        const lower = actionText.toLowerCase();
        if (!lower.includes('изменил почту')) return null;

        const emailRegex = /на\s+([^\s]+@[^.\s]+\.[^\s]+)/i;
        const emailMatch = actionText.match(emailRegex);
        if (!emailMatch) return null;
        const newEmail = emailMatch[1].toLowerCase();

        const player = extractPlayersFromMailRow(actionText) || 'Неизвестно';
        const accountIds = extractAccountIds(row, 1);
        const timestampStr = normalizeWhitespace(getVisibleText(cells[0]));
        const timestamp = parseDate(timestampStr);

        return { player, accountId: accountIds[0] || null, newEmail, timestampStr, timestamp };
    }

    function collectMailEventsFromTable() {
        const tableBody = document.querySelector('table.table-hover tbody');
        if (!tableBody) return [];
        return Array.from(tableBody.querySelectorAll('tr'))
            .map(parseMailChangeRow)
            .filter(Boolean);
    }

    function parseWarehouseItemRow(row) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return null;
        const actionText = normalizeWhitespace(getVisibleText(cells[1])) || '';
        const lower = actionText.toLowerCase();
        if (!lower.includes('складск') && !lower.includes('склад №')) return null;
        const warehouseMatch = actionText.match(/склад(?:ского|ское)?\s+(?:помещения|помещение)?\s*№\s*(\d+)/i);
        const warehouseId = warehouseMatch ? warehouseMatch[1] : null;
        if (!warehouseId) return null;

        let direction = null;
        if (/положил|поместил/i.test(actionText)) direction = 'put';
        if (/взял|забрал/i.test(actionText)) direction = 'take';
        if (!direction) return null;

        const ids = Array.from(actionText.matchAll(/\[id:\s*(\d+)\]/gi));
        if (ids.length === 0) return null;
        const itemId = ids[ids.length - 1][1];

        const player = extractPrimaryPlayer(row) || 'Неизвестно';
        const accountIds = extractAccountIds(row, 1);
        const quantity = extractQuantityFromText(actionText);
        const itemNameMatch = actionText.match(/склад(?:ского|ское)?\s+(?:помещения|помещение)?\s*№\s*\d+\s+(.+?)\s*\[id:/i);
        const itemName = itemNameMatch ? normalizeWhitespace(itemNameMatch[1]) : `ID ${itemId}`;

        const timestampStr = normalizeWhitespace(getVisibleText(cells[0]));
        const timestamp = parseDate(timestampStr);

        const priceRange = normalizePriceValue(itemPricesMap.get(String(itemId)));
        const totalRange = priceRange
            ? { min: priceRange.min * quantity, max: priceRange.max * quantity }
            : null;
        const approxValue = totalRange ? (totalRange.min + totalRange.max) / 2 : null;

        return {
            warehouseId,
            itemId,
            itemName,
            quantity,
            direction,
            player,
            accountId: accountIds[0] || null,
            timestamp,
            timestampStr,
            approxValue
        };
    }

    function collectWarehouseItemEvents() {
        const tableBody = document.querySelector('table.table-hover tbody');
        if (!tableBody) return [];
        return Array.from(tableBody.querySelectorAll('tr'))
            .map(parseWarehouseItemRow)
            .filter(Boolean);
    }

    function parseWarehouseMoneyRow(row) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return null;
        const actionText = normalizeWhitespace(getVisibleText(cells[1])) || '';
        const lower = actionText.toLowerCase();
        if (!/денежные средства/i.test(lower)) return null;
        const warehouseMatch = actionText.match(/склад[ауе]?\s*№\s*(\d+)/i);
        const warehouseId = warehouseMatch ? warehouseMatch[1] : null;
        if (!warehouseId) return null;

        let direction = null;
        if (/положил|поместил/i.test(actionText)) direction = 'put';
        if (/берет|взял|забрал/i.test(actionText)) direction = 'take';
        if (!direction) return null;

        const amountMatch = actionText.match(/в количестве\s*([\d\s.,]+)\$/i);
        const amount = amountMatch ? parseMoneyValue(amountMatch[1]) : null;
        if (!Number.isFinite(amount) || amount <= 0) return null;

        const commissionMatch = actionText.match(/комисси(?:я|и):\s*([\d\s.,]+)\$/i);
        const commission = commissionMatch ? parseMoneyValue(commissionMatch[1]) : null;
        const totalAfterMatch = actionText.match(/Всего на складе:\s*([\d\s.,]+)\$/i);
        const totalAfter = totalAfterMatch ? parseMoneyValue(totalAfterMatch[1]) : null;
        const remainderMatch = actionText.match(/Остаток:\s*([\d\s.,]+)\$/i);
        const remainderAfter = remainderMatch ? parseMoneyValue(remainderMatch[1]) : null;
        const netAmount = direction === 'put' && Number.isFinite(commission)
            ? Math.max(0, amount - commission)
            : amount;

        const player = extractPrimaryPlayer(row) || 'Неизвестно';
        const accountIds = extractAccountIds(row, 1);
        const tsStr = normalizeWhitespace(getVisibleText(cells[0]));
        const ts = parseDate(tsStr);

        return {
            warehouseId,
            direction,
            amount,
            netAmount,
            commission: Number.isFinite(commission) ? commission : null,
            totalAfter: Number.isFinite(totalAfter) ? totalAfter : null,
            remainderAfter: Number.isFinite(remainderAfter) ? remainderAfter : null,
            player,
            accountId: accountIds[0] || null,
            timestamp: ts,
            timestampStr: tsStr
        };
    }

    function collectWarehouseMoneyEvents() {
        const tableBody = document.querySelector('table.table-hover tbody');
        if (!tableBody) return [];
        return Array.from(tableBody.querySelectorAll('tr'))
            .map(parseWarehouseMoneyRow)
            .filter(Boolean);
    }

    function parseHouseMoneyRow(row) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return null;
        const actionCell = cells[1];
        const actionText = normalizeWhitespace(getVisibleText(actionCell)) || '';
        const lower = actionText.toLowerCase();

        let direction = null;
        if (lower.includes('пополняет шкаф дома')) direction = 'in';
        if (lower.includes('берет со шкафа дома')) direction = 'out';
        if (!direction) return null;

        const houseMatch = actionText.match(/ID[:\s]*([0-9]+)/i);
        const houseId = houseMatch ? houseMatch[1] : null;
        if (!houseId) return null;

        const amountMatch = actionText.match(/Сумма:\s*([\d\s.,]+)\s*\$/i);
        const amount = amountMatch ? parseMoneyValue(amountMatch[1]) : null;
        if (!Number.isFinite(amount) || amount <= 0) return null;

        const player = extractPrimaryPlayer(row) || 'Неизвестно';
        const accountIds = extractAccountIds(row, 1);

        const tsStr = normalizeWhitespace(getVisibleText(cells[0]));
        const ts = parseDate(tsStr);

        return {
            houseId,
            direction,
            amount,
            player,
            accountId: accountIds[0] || null,
            timestamp: ts,
            timestampStr: tsStr,
            row
        };
    }

    function collectHouseMoneyEvents() {
        const tableBody = document.querySelector('table.table-hover tbody');
        if (!tableBody) return [];
        return Array.from(tableBody.querySelectorAll('tr'))
            .map(parseHouseMoneyRow)
            .filter(Boolean);
    }

    function detectHouseTransfers(events, options) {
        const threshold = Number(options?.threshold) || DEFAULT_SUSPICIOUS_SETTINGS.house.threshold;
        const houses = new Map();
        events.forEach(ev => {
            if (!houses.has(ev.houseId)) houses.set(ev.houseId, []);
            houses.get(ev.houseId).push(ev);
        });

        const findings = [];
        houses.forEach((list, houseId) => {
            const sorted = list
                .filter(ev => ev.timestamp instanceof Date && !Number.isNaN(ev.timestamp))
                .sort((a, b) => a.timestamp - b.timestamp);

            const deposits = [];
            const pairs = [];
            const players = new Map();

            sorted.forEach(ev => {
                const key = ev.accountId ? `acc:${ev.accountId}` : `name:${ev.player}`;
                if (!players.has(key)) {
                    players.set(key, { name: ev.player, accountId: ev.accountId });
                }
                if (ev.direction === 'in') {
                    deposits.push({ ...ev, consumed: false });
                    return;
                }
                if (ev.direction !== 'out') return;

                const match = deposits.find(dep =>
                    !dep.consumed &&
                    !isSamePlayer(
                        { player: dep.player, accountId: dep.accountId },
                        { player: ev.player, accountId: ev.accountId }
                    ) &&
                    dep.amount === ev.amount
                );

                if (match) {
                    if (match.amount < threshold) {
                        match.consumed = true;
                        return;
                    }
                    match.consumed = true;
                    pairs.push({
                        deposit: match,
                        withdraw: ev
                    });
                }
            });

            // Фильтруем пары: убираем те, где получатель вернул деньги обратно
            const validPairs = pairs.filter(pair => {
                // Ищем событие, где получатель положил обратно такую же сумму
                const returnEvent = sorted.find(ev =>
                    ev.direction === 'in' &&
                    ev.timestamp > pair.withdraw.timestamp &&
                    isSamePlayer(
                        { player: ev.player, accountId: ev.accountId },
                        { player: pair.withdraw.player, accountId: pair.withdraw.accountId }
                    ) &&
                    ev.amount === pair.withdraw.amount
                );

                // Если получатель вернул деньги обратно, это не перелив
                return !returnEvent;
            });

            if (validPairs.length > 0 && players.size > 1) {
                findings.push({
                    houseId,
                    pairs: validPairs,
                    players: Array.from(players.values()),
                    chronology: sorted
                });
            }
        });

        findings.sort((a, b) => b.pairs.length - a.pairs.length);

        return {
            findings,
            stats: {
                totalEvents: events.length
            }
        };
    }

    function detectWarehouseItemTransfers(events) {
        const warehouses = new Map();
        events.forEach(ev => {
            const key = `${ev.warehouseId}:${ev.itemId}`;
            if (!warehouses.has(key)) warehouses.set(key, []);
            warehouses.get(key).push(ev);
        });

        const findings = [];
        warehouses.forEach((list, key) => {
            const sorted = list
                .filter(ev => ev.timestamp instanceof Date && !Number.isNaN(ev.timestamp))
                .sort((a, b) => a.timestamp - b.timestamp);

            const deposits = [];
            const pairs = [];
            const players = new Map();
            const [warehouseId, itemId] = key.split(':');
            let itemNameSample = '';

            sorted.forEach(ev => {
                const playerKey = ev.accountId ? `acc:${ev.accountId}` : `name:${ev.player}`;
                if (!players.has(playerKey)) {
                    players.set(playerKey, { name: ev.player, accountId: ev.accountId });
                }
                itemNameSample = ev.itemName || itemNameSample;

                if (ev.direction === 'put') {
                    deposits.push({ ...ev, consumed: false });
                    return;
                }
                if (ev.direction !== 'take') return;

                const match = deposits.find(dep =>
                    !dep.consumed &&
                    !isSamePlayer(
                        { player: dep.player, accountId: dep.accountId },
                        { player: ev.player, accountId: ev.accountId }
                    ) &&
                    dep.quantity === ev.quantity
                );

                if (match) {
                    match.consumed = true;
                    const pairValue = match.approxValue || ev.approxValue || null;
                    pairs.push({
                        deposit: match,
                        withdraw: ev,
                        value: pairValue
                    });
                }
            });

            // Фильтруем пары: убираем те, где получатель вернул предмет обратно
            const validPairs = pairs.filter(pair => {
                // Ищем событие, где получатель (withdraw) положил обратно такое же количество
                const returnEvent = sorted.find(ev =>
                    ev.direction === 'put' &&
                    ev.timestamp > pair.withdraw.timestamp &&
                    isSamePlayer(
                        { player: ev.player, accountId: ev.accountId },
                        { player: pair.withdraw.player, accountId: pair.withdraw.accountId }
                    ) &&
                    ev.quantity === pair.withdraw.quantity
                );

                // Если получатель вернул предмет обратно, это не перелив
                return !returnEvent;
            });

            if (validPairs.length > 0 && players.size > 1) {
                const totalValue = validPairs.reduce((sum, pair) => sum + (pair.value || 0), 0);
                findings.push({
                    warehouseId,
                    itemId,
                    itemName: itemNameSample,
                    pairs: validPairs,
                    players: Array.from(players.values()),
                    totalValue
                });
            }
        });

        findings.sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0));

        return findings;
    }

    function detectWarehouseMoneyTransfers(events, options) {
        const threshold = Number(options?.moneyThreshold) || DEFAULT_SUSPICIOUS_SETTINGS.warehouse.moneyThreshold;
        const warehouses = new Map();
        events.forEach(ev => {
            if (!warehouses.has(ev.warehouseId)) warehouses.set(ev.warehouseId, []);
            warehouses.get(ev.warehouseId).push(ev);
        });

        const findings = [];
        warehouses.forEach((list, warehouseId) => {
            const sorted = list
                .filter(ev => ev.timestamp instanceof Date && !Number.isNaN(ev.timestamp))
                .sort((a, b) => a.timestamp - b.timestamp);

            const deposits = [];
            const pairs = [];
            const players = new Map();
            const amountClose = (a, b) => {
                if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
                const diff = Math.abs(a - b);
                const tolerance = Math.max(10_000, Math.min(a, b) * 0.02);
                return diff <= tolerance;
            };
            const eventValue = (ev) => Number.isFinite(ev?.netAmount) ? ev.netAmount : ev?.amount;

            sorted.forEach(ev => {
                const playerKey = ev.accountId ? `acc:${ev.accountId}` : `name:${ev.player}`;
                if (!players.has(playerKey)) {
                    players.set(playerKey, { name: ev.player, accountId: ev.accountId });
                }
                if (ev.direction === 'put') {
                    deposits.push({ ...ev, consumed: false });
                    return;
                }
                if (ev.direction !== 'take') return;

                const withdrawValue = eventValue(ev);
                const match = deposits.find(dep => {
                    const depValue = eventValue(dep);
                    if (isSamePlayer(
                        { player: dep.player, accountId: dep.accountId },
                        { player: ev.player, accountId: ev.accountId }
                    )) return false;
                    if (!Number.isFinite(depValue) || !Number.isFinite(withdrawValue)) return false;

                    const byExactAmount = amountClose(depValue, withdrawValue);
                    const byBalance = Number.isFinite(ev.remainderAfter)
                        ? amountClose(depValue, withdrawValue + ev.remainderAfter)
                        : false;
                    const meetsThreshold = Math.max(depValue, withdrawValue) >= threshold;

                    return !dep.consumed && meetsThreshold && (byExactAmount || byBalance);
                });

                if (match) {
                    match.consumed = true;
                    pairs.push({
                        deposit: match,
                        withdraw: ev,
                        amount: Math.round((eventValue(match) + withdrawValue) / 2),
                        matchedByBalance: Number.isFinite(ev.remainderAfter)
                            ? amountClose(eventValue(match), withdrawValue + ev.remainderAfter)
                            : false
                    });
                }
            });

            // Фильтруем пары: убираем те, где получатель вернул деньги обратно
            const validPairs = pairs.filter(pair => {
                const withdrawValue = eventValue(pair.withdraw);
                // Ищем событие, где получатель положил обратно примерно такую же сумму
                const returnEvent = sorted.find(ev =>
                    ev.direction === 'put' &&
                    ev.timestamp > pair.withdraw.timestamp &&
                    isSamePlayer(
                        { player: ev.player, accountId: ev.accountId },
                        { player: pair.withdraw.player, accountId: pair.withdraw.accountId }
                    ) &&
                    amountClose(eventValue(ev), withdrawValue)
                );

                // Если получатель вернул деньги обратно, это не перелив
                return !returnEvent;
            });

            if (validPairs.length > 0 && players.size > 1) {
                findings.push({
                    warehouseId,
                    pairs: validPairs,
                    players: Array.from(players.values()),
                    threshold
                });
            }
        });

        findings.sort((a, b) => b.pairs.length - a.pairs.length);

        return findings;
    }

    function detectMailClusters(events, options) {
        const minPlayers = Number(options?.minPlayers) || DEFAULT_SUSPICIOUS_SETTINGS.mail.minPlayers;
        const map = new Map();

        events.forEach(ev => {
            if (!ev.newEmail) return;
            const key = ev.newEmail;
            if (!map.has(key)) {
                map.set(key, { email: key, players: new Map(), samples: [] });
            }
            const entry = map.get(key);
            const playerKey = ev.accountId ? `acc:${ev.accountId}` : `name:${ev.player}`;
            if (!entry.players.has(playerKey)) {
                entry.players.set(playerKey, {
                    accountId: ev.accountId || null,
                    name: ev.player || null
                });
                if (entry.samples.length < 5) {
                    entry.samples.push(ev);
                }
            }
        });

        const findings = [];
        map.forEach(entry => {
            const uniquePlayers = Array.from(entry.players.values());
            if (uniquePlayers.length >= minPlayers) {
                findings.push({
                    email: entry.email,
                    players: uniquePlayers,
                    samples: entry.samples
                });
            }
        });

        findings.sort((a, b) => b.players.length - a.players.length);

        return {
            findings,
            stats: {
                totalEvents: events.length
            }
        };
    }

    function detectSuspiciousDeals(events, options) {
        const threshold = Number(options?.threshold) || DEFAULT_SUSPICIOUS_SETTINGS.trunk.threshold;
        const windowMinutes = Number(options?.windowMinutes) || DEFAULT_SUSPICIOUS_SETTINGS.trunk.windowMinutes;
        const vehiclesMap = new Map();
        events.forEach(ev => {
            if (!vehiclesMap.has(ev.vehicleId)) vehiclesMap.set(ev.vehicleId, []);
            vehiclesMap.get(ev.vehicleId).push(ev);
        });

        const findings = [];
        let pricedEvents = 0;

        vehiclesMap.forEach((vehicleEvents, vehicleId) => {
            const sorted = vehicleEvents
                .filter(ev => ev.timestamp instanceof Date && !Number.isNaN(ev.timestamp))
                .sort((a, b) => a.timestamp - b.timestamp);

            const pool = [];
            sorted.forEach(ev => {
                if (!Number.isFinite(ev.approxValue) || ev.approxValue <= 0) return;
                pricedEvents += 1;

                if (ev.direction === 'put') {
                    pool.push({ ...ev, remainingValue: ev.approxValue });
                    return;
                }
                if (ev.direction !== 'take') return;

                let remaining = ev.approxValue;
                let suspiciousAmount = 0;
                const sources = [];

                while (remaining > 0 && pool.length > 0) {
                    const source = pool[0];
                    const delta = Math.min(source.remainingValue, remaining);
                    const minutesDiff = (ev.timestamp - source.timestamp) / MINUTE_IN_MS;
                    const crossPlayers = source.player && ev.player && source.player !== ev.player;

                    if (crossPlayers && minutesDiff >= 0 && minutesDiff <= windowMinutes) {
                        suspiciousAmount += delta;
                        const ratio = source.approxValue > 0 ? delta / source.approxValue : 1;
                        const quantityPortion = Math.max(1, Math.round(source.quantity * ratio));
                        sources.push({
                            from: source.player,
                            value: delta,
                            itemId: source.itemId,
                            itemName: source.itemName,
                            quantity: quantityPortion,
                            minutesDiff: Math.round(minutesDiff)
                        });
                    }

                    source.remainingValue -= delta;
                    remaining -= delta;
                    if (source.remainingValue <= 0.01) pool.shift();
                }

                if (suspiciousAmount >= threshold && sources.length > 0) {
                    findings.push({
                        vehicleId,
                        taker: ev.player,
                        takeTimeStr: ev.timestampStr,
                        totalValue: suspiciousAmount,
                        sources,
                        windowMinutes
                    });
                }
            });
        });

        return {
            findings,
            stats: {
                totalEvents: events.length,
                pricedEvents
            }
        };
    }

    function normalizeSuspiciousOptions(raw = {}) {
        const threshold = Number(raw?.trunk?.threshold ?? raw.threshold);
        const windowMinutes = Number(raw?.trunk?.windowMinutes ?? raw.windowMinutes);
        const mailMinPlayers = Number(raw?.mail?.minPlayers ?? raw.mailMinPlayers);
        const houseThreshold = Number(raw?.house?.threshold ?? raw.houseThreshold);
        const warehouseMoney = Number(raw?.warehouse?.moneyThreshold ?? raw.warehouseMoney);
        return {
            trunk: {
                threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_SUSPICIOUS_SETTINGS.trunk.threshold,
                windowMinutes: Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : DEFAULT_SUSPICIOUS_SETTINGS.trunk.windowMinutes
            },
            mail: {
                minPlayers: Number.isFinite(mailMinPlayers) && mailMinPlayers > 1 ? mailMinPlayers : DEFAULT_SUSPICIOUS_SETTINGS.mail.minPlayers
            },
            house: {
                threshold: Number.isFinite(houseThreshold) && houseThreshold > 0 ? houseThreshold : DEFAULT_SUSPICIOUS_SETTINGS.house.threshold
            },
            warehouse: {
                moneyThreshold: Number.isFinite(warehouseMoney) && warehouseMoney > 0 ? warehouseMoney : DEFAULT_SUSPICIOUS_SETTINGS.warehouse.moneyThreshold
            }
        };
    }

    function renderSuspiciousPanel(result, options) {
        let panel = document.getElementById(PANEL_ID);
        if (!panel) {
            panel = document.createElement('div');
            panel.id = PANEL_ID;
            panel.className = 'suspicious-panel';

            const header = document.createElement('div');
            header.className = 'suspicious-panel__header';
            header.innerHTML = '<span>🚩 Подозрительные сделки (багажники)</span>';

            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'suspicious-panel__close';
            closeBtn.textContent = '✖';
            closeBtn.addEventListener('click', () => panel.remove());
            header.appendChild(closeBtn);

            const controls = document.createElement('div');
            controls.className = 'suspicious-panel__controls';
            controls.innerHTML = `
                <label>Багажник: порог, $ <input type="number" id="suspiciousThresholdInput" min="100000" step="500000" value="${options.trunk.threshold}"></label>
                <label>Багажник: окно, мин <input type="number" id="suspiciousWindowInput" min="5" step="15" value="${options.trunk.windowMinutes}"></label>
                <label>Почты: мин. аккаунтов <input type="number" id="suspiciousMailMinPlayers" min="2" step="1" value="${options.mail.minPlayers}"></label>
                <label>Дом: порог, $ <input type="number" id="suspiciousHouseThreshold" min="1000000" step="500000" value="${options.house.threshold}"></label>
                <label>Склад (деньги): порог, $ <input type="number" id="suspiciousWarehouseMoney" min="1000000" step="500000" value="${options.warehouse.moneyThreshold}"></label>
                <button type="button" class="logs-utility-button logs-utility-button--ghost" id="suspiciousRecalcBtn">Пересчитать</button>
            `;

            const summary = document.createElement('div');
            summary.id = 'suspiciousSummary';
            summary.className = 'suspicious-panel__summary';

            const list = document.createElement('div');
            list.id = 'suspiciousList';
            list.className = 'suspicious-panel__list';

            panel.append(header, controls, summary, list);
            document.body.appendChild(panel);

            document.getElementById('suspiciousRecalcBtn')?.addEventListener('click', () => {
                const thresholdInput = document.getElementById('suspiciousThresholdInput');
                const windowInput = document.getElementById('suspiciousWindowInput');
                const mailInput = document.getElementById('suspiciousMailMinPlayers');
                const nextOptions = normalizeSuspiciousOptions({
                    trunk: {
                        threshold: thresholdInput?.value,
                        windowMinutes: windowInput?.value
                    },
                    mail: {
                        minPlayers: mailInput?.value
                    },
                    house: {
                        threshold: document.getElementById('suspiciousHouseThreshold')?.value
                    },
                    warehouse: {
                        moneyThreshold: document.getElementById('suspiciousWarehouseMoney')?.value
                    }
                });
                runSuspiciousScan(nextOptions);
            });
        }

        const thresholdInput = document.getElementById('suspiciousThresholdInput');
        const windowInput = document.getElementById('suspiciousWindowInput');
        const mailInput = document.getElementById('suspiciousMailMinPlayers');
        if (thresholdInput) thresholdInput.value = options.trunk.threshold;
        if (windowInput) windowInput.value = options.trunk.windowMinutes;
        if (mailInput) mailInput.value = options.mail.minPlayers;
        const houseInput = document.getElementById('suspiciousHouseThreshold');
        if (houseInput) houseInput.value = options.house.threshold;
        const warehouseMoneyInput = document.getElementById('suspiciousWarehouseMoney');
        if (warehouseMoneyInput) warehouseMoneyInput.value = options.warehouse.moneyThreshold;

        const summary = document.getElementById('suspiciousSummary');
        if (summary) {
            const warehouseItemsTotal = result.warehouseItems.findings.reduce((sum, f) => sum + (f.totalValue || 0), 0);
            const warehouseItemsStr = warehouseItemsTotal > 0
                ? ` (~${formatPrice(warehouseItemsTotal)}$)`
                : '';

            summary.textContent = [
                `Багажник: ${result.trunk.stats.totalEvents} событий (с ценами: ${result.trunk.stats.pricedEvents}), найдено ${result.trunk.findings.length}`,
                `Почты: ${result.mail.stats.totalEvents} событий, найдено ${result.mail.findings.length}`,
                `Дома (порог ${formatPrice(options.house.threshold)}$): ${result.house.stats.totalEvents} событий, найдено ${result.house.findings.length}`,
                `Склад предметы: ${result.warehouseItems.stats.totalEvents} событий, найдено ${result.warehouseItems.findings.length}${warehouseItemsStr}`,
                `Склад деньги (порог ${formatPrice(options.warehouse.moneyThreshold)}$): ${result.warehouseMoney.stats.totalEvents} событий, найдено ${result.warehouseMoney.findings.length}`
            ].join('. ');
        }

        const list = document.getElementById('suspiciousList');
        if (!list) return;
        list.innerHTML = '';

        const addSectionTitle = (text) => {
            const title = document.createElement('div');
            title.className = 'suspicious-card__title';
            title.style.margin = '6px 0';
            title.textContent = text;
            list.appendChild(title);
        };

        const renderTrunk = () => {
            addSectionTitle('🚗 Багажники');
            if (result.trunk.findings.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'suspicious-card suspicious-card--empty';
                empty.textContent = 'Подозрительных передач не найдено.';
                list.appendChild(empty);
                return;
            }
            result.trunk.findings
                .sort((a, b) => b.totalValue - a.totalValue)
                .forEach(find => {
                    const card = document.createElement('div');
                    card.className = 'suspicious-card';

                    const title = document.createElement('div');
                    title.className = 'suspicious-card__title';
                    title.textContent = `🚗 Машина ${find.vehicleId}`;

                    const value = document.createElement('div');
                    value.className = 'suspicious-card__value';
                    value.textContent = `Получатель: ${find.taker} • ~${formatPrice(find.totalValue)}$ • ${find.takeTimeStr || ''}`;

                    const sourceList = document.createElement('ul');
                    sourceList.className = 'suspicious-card__sources';
                    find.sources.forEach(src => {
                        const li = document.createElement('li');
                        const itemLabel = src.itemName || `ID ${src.itemId}`;
                        li.textContent = `${src.from} → ${find.taker}: ~${formatPrice(src.value)}$ (${itemLabel} ×${src.quantity}) • ${src.minutesDiff} мин`;
                        sourceList.appendChild(li);
                    });

                    card.append(title, value, sourceList);
                    list.appendChild(card);
                });
        };

        const renderHouses = () => {
            addSectionTitle('🏠 Шкафы дома (пересечения игроков)');
            if (result.house.findings.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'suspicious-card suspicious-card--empty';
                empty.textContent = 'Подозрительных передач через шкаф не найдено.';
                list.appendChild(empty);
                return;
            }

            result.house.findings.forEach(find => {
                const card = document.createElement('div');
                card.className = 'suspicious-card';

                const title = document.createElement('div');
                title.className = 'suspicious-card__title';
                title.textContent = `Дом ID ${find.houseId} — игроков: ${find.players.length}, пар: ${find.pairs.length}`;

                const playersList = document.createElement('div');
                playersList.className = 'suspicious-card__value';
                playersList.textContent = find.players
                    .map(p => p.accountId ? `${p.name || 'Неизвестно'} (acc ${p.accountId})` : (p.name || 'Неизвестно'))
                    .join(' • ');

                const pairsList = document.createElement('ul');
                pairsList.className = 'suspicious-card__sources';
                find.pairs.forEach(pair => {
                    const li = document.createElement('li');
                    li.textContent = `${pair.deposit.player}${pair.deposit.accountId ? ` (acc ${pair.deposit.accountId})` : ''} → ${pair.withdraw.player}${pair.withdraw.accountId ? ` (acc ${pair.withdraw.accountId})` : ''}: ${formatPrice(pair.withdraw.amount)}$ (${pair.deposit.timestampStr} → ${pair.withdraw.timestampStr})`;
                    pairsList.appendChild(li);
                });

                const chronology = document.createElement('ul');
                chronology.className = 'suspicious-card__sources';
                chronology.style.marginTop = '6px';
                chronology.style.borderTop = '1px solid rgba(255,255,255,0.08)';
                chronology.style.paddingTop = '6px';
                chronology.appendChild(document.createElement('li')).textContent = 'Хронология:';
                find.chronology.slice(-12).forEach(ev => {
                    const li = document.createElement('li');
                    li.textContent = `${ev.timestampStr} · ${ev.direction === 'in' ? 'положил' : 'взял'} ${formatPrice(ev.amount)}$ · ${ev.player}${ev.accountId ? ` (acc ${ev.accountId})` : ''}`;
                    chronology.appendChild(li);
                });

                card.append(title, playersList, pairsList, chronology);
                list.appendChild(card);
            });
        };

        const renderWarehouseItems = () => {
            addSectionTitle('🗄️ Склад: предметы');
            if (result.warehouseItems.findings.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'suspicious-card suspicious-card--empty';
                empty.textContent = 'Подозрительных передач предметов через склад не найдено.';
                list.appendChild(empty);
                return;
            }

            result.warehouseItems.findings
                .sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0))
                .forEach(find => {
                    const card = document.createElement('div');
                    card.className = 'suspicious-card';

                    const title = document.createElement('div');
                    title.className = 'suspicious-card__title';
                    const valueStr = find.totalValue ? ` • ~${formatPrice(find.totalValue)}$` : '';
                    title.textContent = `Склад №${find.warehouseId} • ${find.itemName || `ID ${find.itemId}`}${valueStr}`;

                    const playersList = document.createElement('div');
                    playersList.className = 'suspicious-card__value';
                    playersList.textContent = `Игроки: ${find.players.map(p => p.accountId ? `${p.name || 'Неизвестно'} (acc ${p.accountId})` : (p.name || 'Неизвестно')).join(' • ')} • Пар: ${find.pairs.length}`;

                    const pairsList = document.createElement('ul');
                    pairsList.className = 'suspicious-card__sources';
                    find.pairs.forEach(pair => {
                        const li = document.createElement('li');
                        const priceStr = pair.value ? ` • ~${formatPrice(pair.value)}$` : '';
                        const fromPlayer = pair.deposit.accountId ? `${pair.deposit.player} (acc ${pair.deposit.accountId})` : pair.deposit.player;
                        const toPlayer = pair.withdraw.accountId ? `${pair.withdraw.player} (acc ${pair.withdraw.accountId})` : pair.withdraw.player;
                        li.textContent = `${fromPlayer} → ${toPlayer}: ×${pair.withdraw.quantity}${priceStr} (${pair.deposit.timestampStr} → ${pair.withdraw.timestampStr})`;
                        pairsList.appendChild(li);
                    });

                    card.append(title, playersList, pairsList);
                    list.appendChild(card);
                });
        };

        const renderWarehouseMoney = () => {
            addSectionTitle('🗄️ Склад: деньги');
            if (result.warehouseMoney.findings.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'suspicious-card suspicious-card--empty';
                empty.textContent = 'Подозрительных передач денег через склад не найдено.';
                list.appendChild(empty);
                return;
            }

            result.warehouseMoney.findings.forEach(find => {
                const card = document.createElement('div');
                card.className = 'suspicious-card';

                const title = document.createElement('div');
                title.className = 'suspicious-card__title';
                title.textContent = `Склад №${find.warehouseId} • пар: ${find.pairs.length}`;

                const playersList = document.createElement('div');
                playersList.className = 'suspicious-card__value';
                playersList.textContent = `Игроки: ${find.players.map(p => p.accountId ? `${p.name || 'Неизвестно'} (acc ${p.accountId})` : (p.name || 'Неизвестно')).join(' • ')}`;

                const pairsList = document.createElement('ul');
                pairsList.className = 'suspicious-card__sources';
                find.pairs.forEach(pair => {
                    const li = document.createElement('li');
                    const amountLabel = formatPrice(pair.amount ?? pair.withdraw.amount);
                    const balanceNote = pair.matchedByBalance ? ' (учтена комиссия/остаток)' : '';
                    li.textContent = `${pair.deposit.player}${pair.deposit.accountId ? ` (acc ${pair.deposit.accountId})` : ''} → ${pair.withdraw.player}${pair.withdraw.accountId ? ` (acc ${pair.withdraw.accountId})` : ''}: ${amountLabel}$ (${pair.deposit.timestampStr} → ${pair.withdraw.timestampStr})${balanceNote}`;
                    pairsList.appendChild(li);
                });

                card.append(title, playersList, pairsList);
                list.appendChild(card);
            });
        };

        const renderMail = () => {
            addSectionTitle('📧 Почты');
            if (result.mail.findings.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'suspicious-card suspicious-card--empty';
                empty.textContent = 'Повторяющихся почт не найдено.';
                list.appendChild(empty);
                return;
            }

            result.mail.findings.forEach(find => {
                const card = document.createElement('div');
                card.className = 'suspicious-card';

                const title = document.createElement('div');
                title.className = 'suspicious-card__title';
                title.textContent = `${find.email} — ${find.players.length} аккаунтов/игроков`;

                const playersList = document.createElement('ul');
                playersList.className = 'suspicious-card__sources';
                find.players.forEach(playerObj => {
                    const li = document.createElement('li');
                    if (playerObj.accountId) {
                        li.textContent = `accID: ${playerObj.accountId}${playerObj.name ? ` (${playerObj.name})` : ''}`;
                    } else {
                        li.textContent = playerObj.name || 'Неизвестно';
                    }
                    playersList.appendChild(li);
                });

                card.append(title, playersList);
                list.appendChild(card);
            });
        };

        renderTrunk();
        renderHouses();
        renderWarehouseItems();
        renderWarehouseMoney();
        renderMail();
    }

    async function loadSuspiciousSettings() {
        return new Promise((resolve) => {
            try {
                if (!chrome?.storage?.local?.get) {
                    resolve(DEFAULT_SUSPICIOUS_SETTINGS);
                    return;
                }
                chrome.storage.local.get({ suspiciousSettings: DEFAULT_SUSPICIOUS_SETTINGS }, (result) => {
                    const settings = result?.suspiciousSettings || DEFAULT_SUSPICIOUS_SETTINGS;
                    const normalized = normalizeSuspiciousOptions(settings);
                    resolve(normalized);
                });
            } catch (error) {
                log('Не удалось загрузить suspiciousSettings, использую значения по умолчанию', error);
                resolve(DEFAULT_SUSPICIOUS_SETTINGS);
            }
        });
    }

    async function saveSuspiciousSettings(nextSettings) {
        try {
            if (!chrome?.storage?.local?.set) return;
            chrome.storage.local.set({ suspiciousSettings: nextSettings });
        } catch (error) {
            log('Не удалось сохранить suspiciousSettings', error);
        }
    }

    async function runSuspiciousScan(customOptions = null) {
        if (!pricesLoaded) {
            await loadItemPrices();
        }

        const stored = await loadSuspiciousSettings();
        const baseOptions = normalizeSuspiciousOptions(customOptions || {
            trunk: {
                threshold: document.getElementById('suspiciousThresholdInput')?.value ?? stored.trunk.threshold,
                windowMinutes: document.getElementById('suspiciousWindowInput')?.value ?? stored.trunk.windowMinutes
            },
            mail: {
                minPlayers: document.getElementById('suspiciousMailMinPlayers')?.value ?? stored.mail.minPlayers
            },
            house: {
                threshold: document.getElementById('suspiciousHouseThreshold')?.value ?? stored.house.threshold
            },
            warehouse: {
                moneyThreshold: document.getElementById('suspiciousWarehouseMoney')?.value ?? stored.warehouse.moneyThreshold
            }
        });
        await saveSuspiciousSettings(baseOptions);

        const trunkEvents = collectCarEventsFromTable();
        const mailEvents = collectMailEventsFromTable();
        const houseEvents = collectHouseMoneyEvents();
        const warehouseItemEvents = collectWarehouseItemEvents();
        const warehouseMoneyEvents = collectWarehouseMoneyEvents();

        const trunkResult = trunkEvents.length && itemPricesMap.size > 0
            ? detectSuspiciousDeals(trunkEvents, baseOptions.trunk)
            : { findings: [], stats: { totalEvents: trunkEvents.length, pricedEvents: 0 } };

        if (trunkEvents.length && itemPricesMap.size === 0) {
            log('Цены предметов недоступны, пропускаю анализ багажника');
        }

        const mailResult = mailEvents.length
            ? detectMailClusters(mailEvents, baseOptions.mail)
            : { findings: [], stats: { totalEvents: 0 } };

        const houseResult = houseEvents.length
            ? detectHouseTransfers(houseEvents, baseOptions.house)
            : { findings: [], stats: { totalEvents: 0 } };

        const warehouseItemsResult = warehouseItemEvents.length
            ? { findings: detectWarehouseItemTransfers(warehouseItemEvents), stats: { totalEvents: warehouseItemEvents.length } }
            : { findings: [], stats: { totalEvents: 0 } };

        const warehouseMoneyResult = warehouseMoneyEvents.length
            ? { findings: detectWarehouseMoneyTransfers(warehouseMoneyEvents, baseOptions.warehouse), stats: { totalEvents: warehouseMoneyEvents.length } }
            : { findings: [], stats: { totalEvents: 0 } };

        if (!trunkEvents.length && !mailEvents.length && !houseEvents.length && !warehouseItemEvents.length && !warehouseMoneyEvents.length) {
            alert('Не удалось найти данные для анализа (багажник, склад, шкаф дома или смена почты). Проверь типы логов.');
            return;
        }

        renderSuspiciousPanel({
            trunk: trunkResult,
            mail: mailResult,
            house: houseResult,
            warehouseItems: warehouseItemsResult,
            warehouseMoney: warehouseMoneyResult
        }, baseOptions);
    }

    function init() {
        addSuspiciousButton();
        const observer = new MutationObserver(() => {
            if (!document.getElementById(BUTTON_ID)) {
                addSuspiciousButton();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

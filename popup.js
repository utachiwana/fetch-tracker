
function showToast(message, duration = 2000) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
        visibility: hidden;
        min-width: 250px;
        background-color: #333;
        color: #fff;
        text-align: center;
        border-radius: 8px;
        padding: 16px;
        position: fixed;
        z-index: 1000;
        left: 50%;
        bottom: 30px;
        transform: translateX(-50%);
        font-size: 17px;
        opacity: 0;
        transition: opacity 0.5s ease-in-out;
    `;
    document.body.appendChild(toast);

    // Show the toast
    toast.style.visibility = 'visible';
    toast.style.opacity = '1';

    // Hide the toast after 'duration' milliseconds
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.addEventListener('transitionend', () => {
            toast.remove();
        }, { once: true });
    }, duration);
}

document.addEventListener('DOMContentLoaded', () => {
    const startButton = document.getElementById('startButton');
    const pauseButton = document.getElementById('pauseButton');
    const stopButton = document.getElementById('stopButton');
    const copyButton = document.getElementById('copyButton');
    const domainsList = document.getElementById('domainsList');
    const tabSelector = document.getElementById('tabSelector');
    const pauseButtonImg = pauseButton.querySelector('img');

    // --- NEW: Checkbox for filtering ---
    const filterContainer = document.createElement('div');
    filterContainer.style.cssText = 'margin: 10px 0; display: flex; align-items: center; justify-content: center;';
    
    const filterCheckbox = document.createElement('input');
    filterCheckbox.type = 'checkbox';
    filterCheckbox.id = 'filterCheckbox';
    filterCheckbox.style.marginRight = '8px';
    
    const filterLabel = document.createElement('label');
    filterLabel.htmlFor = 'filterCheckbox';
    filterLabel.textContent = 'Только домены сайта';
    filterLabel.style.cursor = 'pointer';

    filterContainer.appendChild(filterCheckbox);
    filterContainer.appendChild(filterLabel);

    domainsList.parentNode.insertBefore(filterContainer, domainsList);
    // -----------------------------------

    // --- Functions ---

    function populateTabSelector() {
        // Keep track of the currently selected value, if any
        const previouslySelected = tabSelector.value;
        chrome.tabs.query({}, (tabs) => {
            tabSelector.innerHTML = ''; // Clear current options
            
            const defaultOption = document.createElement('option');
            defaultOption.value = "";
            defaultOption.textContent = "Выберите вкладку...";
            defaultOption.disabled = true;
            tabSelector.appendChild(defaultOption);

            tabs.forEach(tab => {
                if (tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
                    const option = document.createElement('option');
                    option.value = tab.id;
                    option.textContent = tab.title.length > 50 ? tab.title.substring(0, 47) + '...' : tab.title;
                    tabSelector.appendChild(option);
                }
            });

            // Try to re-select the previously selected tab
            if (Array.from(tabSelector.options).some(o => o.value === previouslySelected)) {
                tabSelector.value = previouslySelected;
            } else {
                 tabSelector.value = ""; // Reset if the tab is no longer available
            }
        });
    }

    function updateUI(state) {
        const { isTracking, isPaused, uniqueDomains, tabId, siteKeyword } = state;

        const hasDomains = uniqueDomains && uniqueDomains.length > 0;
        const startButtonImg = startButton.querySelector('img');

        // Update button states and icons
        if (isTracking) {
            if (isPaused) {
                // --- PAUSED ---
                startButton.disabled = false;
                startButton.title = 'Возобновить';
                startButtonImg.src = 'images/start.svg';
                pauseButton.disabled = true;
                stopButton.disabled = false;
            } else {
                // --- TRACKING ---
                startButton.disabled = true;
                startButton.title = 'Старт';
                startButtonImg.src = 'images/start.svg';
                pauseButton.disabled = false;
                stopButton.disabled = false;
            }
        } else {
            // --- STOPPED or IDLE ---
            startButton.disabled = !tabSelector.value;
            startButton.title = 'Старт';
            startButtonImg.src = 'images/start.svg';
            pauseButton.disabled = true;
            stopButton.disabled = true;
        }

        copyButton.disabled = !hasDomains;
        tabSelector.disabled = isTracking;
        
        if (isTracking || tabId) {
            tabSelector.value = tabId;
        }

        // Update domains list
        domainsList.innerHTML = '';
        if (hasDomains) {
            let displayDomains = uniqueDomains;
            // Filter only for display if checkbox is checked
            if (filterCheckbox.checked && siteKeyword) {
                displayDomains = uniqueDomains.filter(d => d.includes(siteKeyword));
            }

            if (displayDomains.length === 0) {
                const msg = document.createElement('div');
                msg.style.cssText = 'padding: 10px; text-align: center; color: #888;';
                msg.textContent = 'Скрыто фильтром';
                domainsList.appendChild(msg);
            } else {
                displayDomains.forEach(domain => {
                    const item = document.createElement('div');
                    item.className = 'domain-item';
                    item.textContent = domain;
                    domainsList.appendChild(item);
                });
            }
        } else {
             domainsList.innerHTML = `<p>${isTracking ? 'Ожидание запросов...' : 'Нет данных для отображения.'}</p>`;
        }
    }

    // --- Event Listeners ---

    tabSelector.addEventListener('mousedown', () => {
        // Refresh tab list when the user clicks on the selector
        populateTabSelector();
    });

    tabSelector.addEventListener('change', () => {
        chrome.runtime.sendMessage({ command: 'getState' }, (state) => {
            if (chrome.runtime.lastError) return;
            // When the selection changes, re-run the main UI update function.
            // It will correctly enable/disable buttons based on whether a tab is selected.
            updateUI(state || { isTracking: false, isPaused: false, uniqueDomains: [] });
        });
    });

    startButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ command: 'getState' }, (state) => {
            if (chrome.runtime.lastError) return;
            if (state.isPaused) {
                // If paused, resume tracking
                chrome.runtime.sendMessage({ command: 'resume' });
            } else {
                // Otherwise, start a new tracking session
                const selectedTabId = parseInt(tabSelector.value, 10);
            if (selectedTabId && selectedTabId > 0) { // Ensure selectedTabId is a positive integer
                // Instruct background to clear existing domains for a fresh start
                chrome.runtime.sendMessage({ command: 'start', tabId: selectedTabId, shouldClear: true }, (response) => {
                    if (chrome.runtime.lastError) {
                        alert('Ошибка: ' + chrome.runtime.lastError.message);
                        return;
                    }
                    if (response && !response.success) {
                        alert(`Ошибка запуска: ${response.message}`);
                    } else if (!response) {
                        alert('Не удалось получить ответ от фонового скрипта. Возможно, он не запущен или произошла ошибка.');
                    }
                });
            } else {
                alert(`Неверно выбранная вкладка: '${tabSelector.value}'. Пожалуйста, выберите действительную вкладку из списка.`);
            }
            }
        });
    });

    pauseButton.addEventListener('click', () => {
        // The pause button now only ever pauses
        chrome.runtime.sendMessage({ command: 'pause' });
    });

    stopButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ command: 'stop' });
    });

    copyButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ command: 'getState' }, (state) => {
            if (chrome.runtime.lastError) return;
            if (state.uniqueDomains && state.uniqueDomains.length > 0) {
                const domainString = state.uniqueDomains.join('\n');
                navigator.clipboard.writeText(domainString).then(() => {
                    showToast('Домены скопированы!', 2000);
                });
            }
        });
    });

    filterCheckbox.addEventListener('change', () => {
        chrome.runtime.sendMessage({ command: 'getState' }, (state) => {
            if (chrome.runtime.lastError) return;
            updateUI(state || { isTracking: false, isPaused: false, uniqueDomains: [] });
        });
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'update') {
            updateUI(message.state);
        }
    });

    // --- Initial Load ---
    populateTabSelector();
    chrome.runtime.sendMessage({ command: 'getState' }, (state) => {
        if (chrome.runtime.lastError) return;
        if (state) {
            updateUI(state);
        } else {
            // Default UI state if background isn't ready
            updateUI({ isTracking: false, isPaused: false, uniqueDomains: [] });
        }
    });
});

let trackingState = {
    tabId: null,
    isTracking: false,
    isPaused: false,
    uniqueDomains: new Set(),
    siteKeyword: null
};

const DEBUGGER_VERSION = "1.3";

let popupWindowId = null;
let ignoreNextDetachForTabs = new Set();
let updateTimeout = null;

// --- Action Click Listener ---
chrome.action.onClicked.addListener((tab) => {
    if (popupWindowId !== null) {
        try {
            chrome.windows.update(popupWindowId, { focused: true });
        } catch (e) {
            popupWindowId = null; // Window was likely closed
            createPopupWindow();
        }
    } else {
        createPopupWindow();
    }
});

function createPopupWindow() {
    chrome.windows.create({
        url: 'popup.html',
        type: 'popup',
        width: 350,
        height: 450,
    }, (window) => {
        popupWindowId = window.id;
    });
}

// When the popup is closed, reset our window ID
chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === popupWindowId) {
        popupWindowId = null;
        // Also stop tracking if the popup is closed
        if (trackingState.isTracking) {
             stopTracking();
        }
    }
});

// --- Message Listener from Popup ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.command === "start") {
        // The start command now optionally clears domains, based on UI logic
        startTracking(request.tabId, sendResponse, request.shouldClear);
    } else if (request.command === "pause") {
        pauseTracking();
    } else if (request.command === "resume") {
        resumeTracking();
    } else if (request.command === "stop") {
        stopTracking();
    } else if (request.command === "getState") {
        sendResponse({
            ...trackingState,
            uniqueDomains: Array.from(trackingState.uniqueDomains)
        });
    }
    return true; // Indicates that the response is sent asynchronously
});

// --- Main Functions ---
function startTracking(tabId, sendResponse, shouldClear) {
    if (!tabId) {
        console.error("No tab ID provided.");
        sendResponse({ success: false, message: "No Tab ID provided." });
        return;
    }
    
    // If we are already tracking this tab, and not resuming, do nothing.
    if(trackingState.isTracking && trackingState.tabId === tabId) {
        sendResponse({ success: true });
        return;
    }

    // Get tab info to determine site keyword for filtering
    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            sendResponse({ success: false, message: "Не удалось получить информацию о вкладке." });
            return;
        }

        if (shouldClear) {
            trackingState.uniqueDomains.clear();
        }

        // Determine keyword from tab URL (e.g. 'avito' from 'avito.ru')
        try {
            const url = new URL(tab.url);
            const hostname = url.hostname.replace(/^www\./, '');
            const parts = hostname.split('.');
            // Heuristic: take the part before the TLD
            trackingState.siteKeyword = parts.length > 1 ? parts[parts.length - 2] : parts[0];
        } catch (e) {
            trackingState.siteKeyword = null;
        }

        trackingState.tabId = tabId;
        trackingState.isTracking = true;
        trackingState.isPaused = false;

        // Attach debugger
        chrome.debugger.attach({ tabId: trackingState.tabId }, DEBUGGER_VERSION, () => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError.message);
                sendResponse({ success: false, message: "Не удалось подключиться к этой вкладке. Убедитесь, что это обычная веб-страница." });
                resetState(); // Reset state if attachment fails
                updatePopup(true);
                return;
            }
            chrome.debugger.sendCommand({ tabId: trackingState.tabId }, "Network.enable", {}, () => {
                if (chrome.runtime.lastError) {
                    console.error(chrome.runtime.lastError.message);
                    sendResponse({ success: false, message: chrome.runtime.lastError.message });
                    return;
                }
                updatePopup(true);
                sendResponse({ success: true });
            });
        });
    });
}

function pauseTracking() {
    if (trackingState.isTracking) {
        trackingState.isPaused = true;
        updatePopup(true);
    }
}

function resumeTracking() {
    if (trackingState.isTracking) {
        trackingState.isPaused = false;
        updatePopup(true);
    }
}

function stopTracking() {
    if (trackingState.tabId) {
        const tabId = trackingState.tabId;
        ignoreNextDetachForTabs.add(tabId);

        trackingState.isTracking = false; // Update state immediately
        trackingState.isPaused = false;   // Update state immediately
        trackingState.tabId = null;       // Reset tabId when tracking stops
        
        updatePopup(true);                // Update UI immediately
        chrome.debugger.detach({ tabId: tabId }, () => {
            if (chrome.runtime.lastError) {
                // Ignore error if tab was closed
            }
        });
    }
}

// --- Event Handlers ---
chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== trackingState.tabId || !trackingState.isTracking || trackingState.isPaused) {
        return;
    }

    if (method === "Network.requestWillBeSent") {
        // We care about fetch/XHR, Image, and Media requests initiated by the page
            try {
                const url = new URL(params.request.url);

                // Filter out chrome extension URLs (random letter strings like cjpalhdlnbpafiamejdnhcphjbkeiagm)
                if (url.protocol === 'chrome-extension:') {
                    return;
                }

                const domain = url.hostname;

                if (!domain || domain === 'invalid') {
                    return;
                }

                if (!trackingState.uniqueDomains.has(domain)) {
                    trackingState.uniqueDomains.add(domain);
                    updatePopup();
                }
            } catch (e) {
                console.warn("Could not parse URL:", params.request.url, e);
            }
    }
});

chrome.debugger.onDetach.addListener((source, reason) => {
    if (ignoreNextDetachForTabs.has(source.tabId)) {
        ignoreNextDetachForTabs.delete(source.tabId);
        return;
    }

    if (source.tabId === trackingState.tabId) {
        resetState();
        updatePopup(true);
    }
});

// If the tracked tab is closed, stop tracking
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (tabId === trackingState.tabId) {
        // No need to call stopTracking() here, as onDetach will handle it.
    }
});

// --- Utility Functions ---
function resetState() {
    trackingState.tabId = null;
    trackingState.isTracking = false;
    trackingState.isPaused = false;
    trackingState.uniqueDomains.clear();
    trackingState.siteKeyword = null;
}

function updatePopup(immediate = false) {
    if (updateTimeout) {
        clearTimeout(updateTimeout);
        updateTimeout = null;
    }

    const send = () => {
        chrome.runtime.sendMessage({
            type: "update",
            state: {
                ...trackingState,
                uniqueDomains: Array.from(trackingState.uniqueDomains) // Convert Set to Array for JSON serialization
            }
        }, () => {
            if (chrome.runtime.lastError) {
                // Popup likely closed
            }
        });
    };

    if (immediate) {
        send();
    } else {
        updateTimeout = setTimeout(send, 50);
    }
}

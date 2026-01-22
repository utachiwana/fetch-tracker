let trackingState = {
    tabId: null,
    isTracking: false,
    isPaused: false,
    uniqueDomains: new Set()
};

const DEBUGGER_VERSION = "1.3";

let popupWindowId = null;
let userInitiatedStop = false; // Flag to check if the stop was from the UI

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

    if (shouldClear) {
        trackingState.uniqueDomains.clear();
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
            updatePopup();
            return;
        }
        chrome.debugger.sendCommand({ tabId: trackingState.tabId }, "Network.enable", {}, () => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError.message);
                sendResponse({ success: false, message: chrome.runtime.lastError.message });
                return;
            }
            updatePopup();
            sendResponse({ success: true });
        });
    });
}

function pauseTracking() {
    if (trackingState.isTracking) {
        trackingState.isPaused = true;
        updatePopup();
    }
}

function resumeTracking() {
    if (trackingState.isTracking) {
        trackingState.isPaused = false;
        updatePopup();
    }
}

function stopTracking() {
    if (trackingState.tabId) {
        userInitiatedStop = true;
        trackingState.isTracking = false; // Update state immediately
        trackingState.isPaused = false;   // Update state immediately
        trackingState.tabId = null;       // Reset tabId when tracking stops
        console.log("stopTracking: state after stop", { ...trackingState, uniqueDomains: Array.from(trackingState.uniqueDomains) });
        updatePopup();                    // Update UI immediately
        chrome.debugger.detach({ tabId: trackingState.tabId });
    }
}

// --- Event Handlers ---
chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== trackingState.tabId || !trackingState.isTracking || trackingState.isPaused) {
        return;
    }

    if (method === "Network.requestWillBeSent") {
        // We only care about fetch/XHR requests initiated by the page
        if (params.type === "Fetch" || params.type === "XHR") {
            try {
                const url = new URL(params.request.url);
                const domain = url.hostname;
                if (!trackingState.uniqueDomains.has(domain)) {
                    trackingState.uniqueDomains.add(domain);
                    updatePopup();
                }
            } catch (e) {
                console.warn("Could not parse URL:", params.request.url, e);
            }
        }
    }
});

chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === trackingState.tabId) {
        if (userInitiatedStop) {
            // If stop was initiated by the user, the state is already updated.
            // Just reset the flag and update popup to ensure consistency.
            userInitiatedStop = false;
        } else {
            // Otherwise, it was an unexpected detach (e.g., tab closed), so reset everything.
            resetState();
        }
        updatePopup();
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
    console.log("resetState called. New state:", { ...trackingState, uniqueDomains: Array.from(trackingState.uniqueDomains) });
}

function updatePopup() {
    console.log("updatePopup called with state:", { ...trackingState, uniqueDomains: Array.from(trackingState.uniqueDomains) });
    chrome.runtime.sendMessage({
        type: "update",
        state: {
            ...trackingState,
            uniqueDomains: Array.from(trackingState.uniqueDomains) // Convert Set to Array for JSON serialization
        }
    });
}

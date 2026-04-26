'use strict';

// Open the side panel when the toolbar icon is clicked.
// All AI tab-opening and injection is handled directly in sidepanel.js,
// so the background service worker only needs this one listener.

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

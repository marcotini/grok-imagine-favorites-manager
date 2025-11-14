/**
 * Grok Imagine Favorites Manager - Popup Script
 * Handles UI interactions and message passing
 */

// Constants
const UPDATE_INTERVAL = 1000; // Update progress every second
const PROGRESS_CLEAR_DELAY = 5000; // Clear progress after 5 seconds

/**
 * Initialize event listeners when DOM is ready
 */
document.addEventListener('DOMContentLoaded', () => {
  // Download actions
  document.getElementById('saveImages').addEventListener('click', () => sendAction('saveImages'));
  document.getElementById('saveVideos').addEventListener('click', () => sendAction('saveVideos'));
  document.getElementById('saveBoth').addEventListener('click', () => sendAction('saveBoth'));
  
  // Manage actions
  document.getElementById('unsaveBoth').addEventListener('click', () => sendAction('unsaveBoth'));
  
  // Utility actions
  document.getElementById('viewDownloads').addEventListener('click', openDownloadsPage);
  
  // Start progress tracking
  setInterval(updateProgress, UPDATE_INTERVAL);
  updateProgress();
});

/**
 * Sends action message to content script
 * @param {string} action - Action to perform
 */
function sendAction(action) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      console.error('No active tab found');
      return;
    }
    
    chrome.tabs.sendMessage(tabs[0].id, { action }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Message error:', chrome.runtime.lastError);
      }
    });
  });
}

/**
 * Opens Chrome downloads page in new tab
 */
function openDownloadsPage() {
  chrome.tabs.create({ url: 'chrome://downloads/' });
}

/**
 * Updates download progress display
 */
function updateProgress() {
  chrome.storage.local.get(['totalDownloads', 'downloadProgress'], (result) => {
    const total = result.totalDownloads || 0;
    const progress = result.downloadProgress || {};
    const completed = Object.values(progress).filter(s => s === 'complete').length;
    
    const progressElement = document.getElementById('progress');
    const progressText = document.getElementById('progressText');
    
    if (total > 0) {
      progressElement.style.display = 'block';
      progressText.textContent = `${completed} of ${total} downloads complete`;
      
      // Clear progress after all complete
      if (completed === total) {
        setTimeout(() => {
          chrome.storage.local.remove(['totalDownloads', 'downloadProgress']);
          progressElement.style.display = 'none';
        }, PROGRESS_CLEAR_DELAY);
      }
    } else {
      progressElement.style.display = 'none';
    }
  });
}

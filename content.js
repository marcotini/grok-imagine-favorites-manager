/**
 * Grok Imagine Favorites Manager - Content Script
 * Handles media extraction and unfavorite operations on grok.com
 */

// Constants
const SELECTORS = {
  CARD: '[role="listitem"] .relative.group\\/media-post-masonry-card',
  IMAGE: 'img[alt*="Generated"]',
  VIDEO: 'video[src]',
  UNSAVE_BUTTON: 'button[aria-label="Unsave"]',
  LIST_ITEM: '[role="listitem"]'
};

const URL_PATTERNS = {
  IMAGE: ['imagine-public.x.ai', 'grok.com']
};

const TIMING = {
  UNFAVORITE_DELAY: 300 // ms between unfavorite clicks
};



/**
 * Message listener for actions from popup
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action } = request;
  
  try {
    if (action.startsWith('save')) {
      handleSave(action);
    } else if (action.startsWith('unsave')) {
      handleUnsave(action);
    }
  } catch (error) {
    console.error('Error handling action:', error);
    alert(`Error: ${error.message}`);
  }
});

/**
 * Determine a sensible filename for a URL. If the final path segment has an extension, use it.
 * If the final segment is a generic endpoint (e.g. "content"), look for a UUID segment earlier
 * in the path and use that as the base name. If nothing found, fall back to a timestamped name.
 * @param {string} url
 * @param {string|null} fallbackBase - optional base name to use if no UUID found
 * @param {boolean} isVideo
 * @returns {string} filename with extension
 */
function determineFilename(url, fallbackBase = null, isVideo = false) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments.length ? segments[segments.length - 1] : '';

    // Prefer a UUID-like segment anywhere in the path (common in these assets).
    // If found, use it as the base name and adopt the last segment's extension if present,
    // otherwise fall back to a sensible extension (.mp4/.png).
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (uuidRe.test(seg)) {
        // determine extension: prefer last segment's extension if any
        const lastExtMatch = (segments[segments.length - 1] || '').match(/(\.[a-zA-Z0-9]{1,5})$/);
        const ext = lastExtMatch ? lastExtMatch[1] : (isVideo ? '.mp4' : '.png');
        return `${seg}${ext}`;
      }
    }

    // If no UUID found, but last segment contains an extension, return it directly
    if (/\.[a-zA-Z0-9]{1,5}$/.test(last)) {
      return last;
    }

    // Use fallbackBase if provided
    if (fallbackBase) {
      const ext = isVideo ? '.mp4' : '.png';
      return `${fallbackBase}${ext}`;
    }

    // If last is not just 'content', use it (append extension)
    if (last && last.toLowerCase() !== 'content') {
      const ext = isVideo ? '.mp4' : '.png';
      return `${last}${ext}`;
    }

    // Last resort: timestamped filename
    const ext = isVideo ? '.mp4' : '.png';
    return `${isVideo ? 'video' : 'image'}_${Date.now()}${ext}`;
  } catch (e) {
    const ext = isVideo ? '.mp4' : '.png';
    return `${isVideo ? 'video' : 'image'}_${Date.now()}${ext}`;
  }
}

/**
 * Extracts the base filename without extension from a URL
 * @param {string} url - The image URL
 * @returns {string} Base filename without extension
 */
function extractBaseName(url) {
  const filename = url.substring(url.lastIndexOf('/') + 1);
  return filename.replace(/\.(png|jpg|jpeg)$/i, '');
}

/**
 * Checks if URL matches any of the valid patterns
 * @param {string} url - URL to validate
 * @param {string[]} patterns - Array of URL patterns to match
 * @returns {boolean}
 */
function isValidUrl(url, patterns) {
  return patterns.some(pattern => url.includes(pattern));
}

/**
 * Handles media download requests
 * @param {string} type - Type of download (saveImages, saveVideos, saveBoth)
 */
function handleSave(type) {
  const media = [];
  const seen = new Set();
  
  const cards = document.querySelectorAll(SELECTORS.CARD);
  
  if (cards.length === 0) {
    throw new Error('No media cards found. Make sure you are on the favorites page.');
  }
  
  cards.forEach((card) => {
    let imageName = null;
    
    // Extract image
    const img = card.querySelector(SELECTORS.IMAGE);
    if (img && img.src) {
      const url = img.src.split('?')[0];
      // derive a better filename for endpoints that return generic names like 'content'
      const filename = determineFilename(url, null, false);
      imageName = extractBaseName(url);

      if ((type === 'saveImages' || type === 'saveBoth') && 
          !seen.has(url) && 
          isValidUrl(url, URL_PATTERNS.IMAGE)) {
        seen.add(url);
        media.push({ url: img.src, filename });
      }
    }
    
  // Extract video
    if (type === 'saveVideos' || type === 'saveBoth') {
      const video = card.querySelector(SELECTORS.VIDEO);
      if (video && video.src) {
        const url = video.src.split('?')[0];
        if (!seen.has(url)) {
          seen.add(url);
          
          // Use matching image name if available and looks like a UUID, otherwise derive from video URL
          const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const filename = (imageName && uuidRe.test(imageName)) ? `${imageName}.mp4` : determineFilename(url, imageName || null, true);

          media.push({ url: video.src, filename });
        }
      }
    }
  });
  
  if (media.length === 0) {
    throw new Error('No media found matching the selected criteria.');
  }
  
  // Send to background script for download
  chrome.runtime.sendMessage({ 
    action: 'startDownloads', 
    media 
  }, (response) => {
    if (chrome.runtime.lastError) {
      throw new Error(chrome.runtime.lastError.message);
    }
    
    if (response && response.success) {
      alert(`Started downloading ${media.length} items. Open the extension to view progress.`);
    } else {
      throw new Error('Failed to start downloads');
    }
  });
}

/**
 * Handles unfavorite operations
 * @param {string} type - Type of unfavorite operation
 */
function handleUnsave(type) {
  if (type !== 'unsaveBoth') {
    return;
  }
  
  const items = document.querySelectorAll(SELECTORS.LIST_ITEM);
  console.log(`Checking ${items.length} items for both video and image`);
  
  const buttonsToClick = [];
  
  items.forEach((item) => {
    const hasVideo = item.querySelector(SELECTORS.VIDEO);
    const hasImage = item.querySelector(SELECTORS.IMAGE);
    
    if (hasVideo && hasImage) {
      const btn = item.querySelector(SELECTORS.UNSAVE_BUTTON);
      if (btn) {
        buttonsToClick.push(btn);
      }
    }
  });
  
  console.log(`Found ${buttonsToClick.length} items with both video and image`);
  
  if (buttonsToClick.length === 0) {
    alert('No items found with both video and image.');
    return;
  }
  
  const estimatedTime = Math.ceil(buttonsToClick.length * TIMING.UNFAVORITE_DELAY / 1000);
  alert(`Starting to unfavorite ${buttonsToClick.length} items. This will take approximately ${estimatedTime} seconds. Keep this tab open.`);
  
  buttonsToClick.forEach((btn, index) => {
    setTimeout(() => {
      try {
        btn.click();
        console.log(`Unfavorited item ${index + 1} of ${buttonsToClick.length}`);
      } catch (error) {
        console.error(`Failed to unfavorite item ${index + 1}:`, error);
      }
    }, index * TIMING.UNFAVORITE_DELAY);
  });
}

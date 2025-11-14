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
  NAVIGATION_DELAY: 500
};

/**
 * Message listener for actions from popup
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action } = request;
  
  (async () => {
    try {
      if (action.startsWith('save')) {
        await handleSave(action);
      } else if (action.startsWith('unsave')) {
        handleUnsave(action);
      }
    } catch (error) {
      console.error('Error handling action:', error);
      alert(`Error: ${error.message}`);
    }
  })();
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
 * Extracts post ID from image URL in masonry view
 * @param {string} imgSrc
 * @returns {string|null}
 */
function extractPostId(imgSrc) {
  try {
    const match = imgSrc.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return match ? match[1] : null;
  } catch (e) {
    return null;
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
 * Checks if a video URL exists by creating a video element and testing load
 * @param {string} url - The video URL to check
 * @returns {Promise<boolean>}
 */
function checkVideoExists(url) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    
    const timeout = setTimeout(() => {
      video.src = '';
      resolve(false);
    }, 3000); // 3 second timeout
    
    video.onloadedmetadata = () => {
      clearTimeout(timeout);
      video.src = '';
      resolve(true);
    };
    
    video.onerror = () => {
      clearTimeout(timeout);
      video.src = '';
      resolve(false);
    };
    
    video.src = url;
  });
}

/**
 * Scrolls down the page to load all lazy-loaded content and collects media
 * @param {string} type - Type of download (saveImages, saveVideos, saveBoth)
 * @returns {Promise<Array>} Array of media items
 */
async function scrollAndCollectMedia(type) {
  console.log('Starting scroll to load and collect all content...');
  
  // Find the scrollable container
  let scrollContainer = document.documentElement;
  const possibleContainers = [
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.querySelector('.overflow-y-auto'),
    document.querySelector('.overflow-auto'),
    ...Array.from(document.querySelectorAll('div')).filter(el => {
      const style = window.getComputedStyle(el);
      return style.overflowY === 'auto' || style.overflowY === 'scroll';
    })
  ].filter(el => el !== null);
  
  if (possibleContainers.length > 0) {
    scrollContainer = possibleContainers.reduce((tallest, current) => {
      return current.scrollHeight > tallest.scrollHeight ? current : tallest;
    });
    console.log('Found custom scroll container:', scrollContainer);
  }
  
  const media = [];
  const seen = new Set();
  let lastCardCount = 0;
  let unchangedCount = 0;
  const maxUnchangedAttempts = 5;
  
  // Get viewport height for relative scrolling
  const viewportHeight = window.innerHeight;
  console.log(`Viewport height: ${viewportHeight}px`);
  
  while (unchangedCount < maxUnchangedAttempts) {
    // Collect media from currently visible cards
    await collectMediaFromVisibleCards(type, media, seen);
    
    const currentCardCount = document.querySelectorAll(SELECTORS.CARD).length;
    console.log(`Current cards: ${currentCardCount}, Collected media: ${media.length}, Last: ${lastCardCount}`);
    
    if (currentCardCount === lastCardCount) {
      unchangedCount++;
      console.log(`No new cards loaded (${unchangedCount}/${maxUnchangedAttempts})`);
    } else {
      unchangedCount = 0;
      lastCardCount = currentCardCount;
      console.log(`New cards found! Total now: ${currentCardCount}`);
    }
    
    // Scroll down by viewport height
    const currentScroll = scrollContainer.scrollTop;
    const newScroll = currentScroll + viewportHeight;
    scrollContainer.scrollTop = newScroll;
    console.log(`Scrolled from ${currentScroll} to ${scrollContainer.scrollTop}`);
    
    // Wait for content to load
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  
  // One final collection pass
  await collectMediaFromVisibleCards(type, media, seen);
  
  // Scroll back to top
  console.log('Scrolling back to top');
  scrollContainer.scrollTop = 0;
  await new Promise(resolve => setTimeout(resolve, 500));
  
  console.log(`Finished! Total media collected: ${media.length}`);
  return media;
}

/**
 * Collects media from currently loaded cards
 * @param {string} type - Type of download
 * @param {Array} media - Array to add media to
 * @param {Set} seen - Set of already seen URLs
 */
async function collectMediaFromVisibleCards(type, media, seen) {
  const cards = document.querySelectorAll(SELECTORS.CARD);
  
  for (const card of cards) {
    let imageName = null;
    
    // Extract image
    const img = card.querySelector(SELECTORS.IMAGE);
    if (img && img.src) {
      const url = img.src.split('?')[0];
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
          
          const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const filename = (imageName && uuidRe.test(imageName)) ? `${imageName}.mp4` : determineFilename(url, imageName || null, true);

          media.push({ url: video.src, filename });
          
          // Check for HD version
          if (url.includes('generated_video.mp4')) {
            const hdUrl = video.src.replace('generated_video.mp4', 'generated_video_hd.mp4');
            const hdFilename = filename.replace(/(\.[^.]+)$/, '-HD$1');
            
            if (!seen.has(hdUrl)) {
              const hdExists = await checkVideoExists(hdUrl);
              if (hdExists) {
                seen.add(hdUrl);
                media.push({ url: hdUrl, filename: hdFilename });
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Handles media download requests
 * @param {string} type - Type of download (saveImages, saveVideos, saveBoth)
 */
async function handleSave(type) {
  console.log(`Starting handleSave with type: ${type}`);
  
  // Check if we're on the favorites page
  const cards = document.querySelectorAll(SELECTORS.CARD);
  if (cards.length === 0) {
    throw new Error('No media cards found. Make sure you are on the favorites page.');
  }
  
  // Scroll and collect all media
  alert('Scrolling to load all favorites... Please wait.');
  const media = await scrollAndCollectMedia(type);
  
  if (media.length === 0) {
    throw new Error('No media found matching the selected criteria.');
  }
  
  alert(`Collected ${media.length} items. Starting downloads...`);
  
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

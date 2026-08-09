/**
 * HistorySuggestionService
 * Manages local storage persistence for text fields to enable reusable 
 * previous entry/autocomplete suggestions.
 */

const HISTORY_PREFIX = 'plsms_history_';

export const HistorySuggestionService = {
  /**
   * Retrieves suggestions for a specific key.
   */
  getSuggestions(key: string): string[] {
    try {
      const storageKey = `${HISTORY_PREFIX}${key}`;
      const json = localStorage.getItem(storageKey);
      if (!json) return [];
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
      }
    } catch (e) {
      console.warn(`Error reading autocomplete history for key [${key}]:`, e);
    }
    return [];
  },

  /**
   * Saves a value into the history for a specific key.
   * Ensures newest items are on top, duplicates are removed, and max length is enforced.
   */
  saveValue(key: string, value: string, maxItems = 15): void {
    if (!value || typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed === '') return;

    try {
      const storageKey = `${HISTORY_PREFIX}${key}`;
      const current = this.getSuggestions(key);
      
      // Filter out duplicate if it already exists (so it can be moved to the top)
      const filtered = current.filter(item => item.toLowerCase() !== trimmed.toLowerCase());
      
      // Prepend the new value at the top
      const updated = [trimmed, ...filtered].slice(0, maxItems);
      
      localStorage.setItem(storageKey, JSON.stringify(updated));
      
      // Trigger a custom event so components can listen for history changes if needed
      safeDispatchHistoryEvent({ key, value: trimmed });
    } catch (e) {
      console.warn(`Error writing autocomplete history for key [${key}]:`, e);
    }
  },

  /**
   * Deletes a single item from the history.
   */
  deleteValue(key: string, value: string): void {
    if (!value) return;
    try {
      const storageKey = `${HISTORY_PREFIX}${key}`;
      const current = this.getSuggestions(key);
      const updated = current.filter(item => item !== value && item.toLowerCase() !== value.toLowerCase());
      localStorage.setItem(storageKey, JSON.stringify(updated));
      safeDispatchHistoryEvent({ key });
    } catch (e) {
      console.warn(`Error deleting history item for key [${key}]:`, e);
    }
  },

  /**
   * Clears history for a specific key.
   */
  clearHistory(key: string): void {
    try {
      const storageKey = `${HISTORY_PREFIX}${key}`;
      localStorage.removeItem(storageKey);
      safeDispatchHistoryEvent({ key });
    } catch (e) {
      console.warn(`Error clearing history for key [${key}]:`, e);
    }
  },

  /**
   * Clears all fields history keys.
   */
  clearAllHistory(): void {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(HISTORY_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
      safeDispatchHistoryEvent({ all: true });
    } catch (e) {
      console.warn('Error clearing all autocomplete histories:', e);
    }
  }
};

function safeDispatchHistoryEvent(detail?: any): void {
  if (typeof window === 'undefined' || !window.dispatchEvent) return;
  try {
    if (typeof document !== 'undefined' && document.createEvent) {
      const evt = document.createEvent('CustomEvent');
      evt.initCustomEvent('plsms_history_update', true, true, detail);
      window.dispatchEvent(evt);
      return;
    }
  } catch (e) {
    // Ignore error
  }
}

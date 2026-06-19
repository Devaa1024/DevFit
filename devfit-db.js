/**
 * DevFit Cloud Sync — Supabase backend
 * Keeps progress, nutrition and workout data synced across all devices.
 * localStorage stays as the offline cache — sync is additive, never destructive.
 *
 * Table: devfit_data  (email TEXT, data_type TEXT, data JSONB, updated_at TIMESTAMPTZ)
 * PK: (email, data_type)
 */
(function (global) {
  'use strict';

  const SUPABASE_URL = 'https://zngberygrzpkhiqrrzwj.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_oJSFEcVvsvbhPA_8mhUrGQ_JCrBddtn';

  let _client = null;

  function client() {
    if (_client) return _client;
    if (!global.supabase) return null;
    try { _client = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); }
    catch (e) { return null; }
    return _client;
  }

  function getEmail() {
    try { return JSON.parse(localStorage.getItem('devfit_user') || '{}').email || null; }
    catch (e) { return null; }
  }

  // ── Sync indicator dot (injected into header automatically) ──────────────
  function injectDot() {
    if (document.getElementById('devfit-cloud-dot')) return;
    const header = document.querySelector('.header') || document.querySelector('header');
    if (!header) return;
    const dot = document.createElement('span');
    dot.id = 'devfit-cloud-dot';
    dot.title = 'Cloud sync';
    dot.style.cssText = [
      'display:inline-block',
      'width:7px',
      'height:7px',
      'border-radius:50%',
      'background:#6b7280',
      'position:absolute',
      'top:10px',
      'right:14px',
      'transition:background .4s',
      'z-index:999',
      'cursor:default'
    ].join(';');
    header.style.position = 'relative';
    header.appendChild(dot);
  }

  function setIndicator(state) {
    const el = document.getElementById('devfit-cloud-dot');
    if (!el) return;
    const colours = { syncing: '#f59e0b', ok: '#22c55e', err: '#6b7280', offline: '#6b7280' };
    el.style.background = colours[state] || colours.offline;
    const labels = { syncing: 'Syncing…', ok: 'Synced ✓', err: 'Sync error', offline: 'Offline' };
    el.title = labels[state] || 'Cloud sync';
  }

  // Auto-inject dot once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectDot);
  } else {
    injectDot();
  }

  // ── Core save ─────────────────────────────────────────────────────────────
  /**
   * Save data to Supabase. Fire-and-forget — never blocks UI.
   * @param {'progress'|'nutrition'|'workouts'} dataType
   * @param {object} data
   */
  async function cloudSave(dataType, data) {
    // Record the local-modified time synchronously, BEFORE any async work and
    // regardless of whether the cloud round-trip succeeds. This is the source
    // of truth for "local has unsynced edits newer than the cloud copy" and
    // protects edits if the user navigates away before the upload completes.
    try { localStorage.setItem('devfit_local_ts_' + dataType, String(Date.now())); } catch (_) {}
    const db = client();
    const email = getEmail();
    if (!db || !email) return;
    setIndicator('syncing');
    try {
      const { error } = await db.from('devfit_data').upsert(
        { email, data_type: dataType, data, updated_at: new Date().toISOString() },
        { onConflict: 'email,data_type' }
      );
      if (error) throw error;
      localStorage.setItem('devfit_cloud_ts_' + dataType, String(Date.now()));
      setIndicator('ok');
    } catch (e) {
      console.warn('[DevFit Cloud] save failed (' + dataType + '):', e.message || e);
      setIndicator('err');
    }
  }

  // Effective local timestamp for a data type = the most recent of "last
  // successful cloud sync" and "last local edit". Using the local-edit time
  // means an edit that hasn't reached the cloud yet still counts as newer than
  // the (older) cloud copy, so sync never clobbers it.
  function localTsFor(dataType) {
    const synced = parseInt(localStorage.getItem('devfit_cloud_ts_' + dataType) || '0', 10);
    const edited = parseInt(localStorage.getItem('devfit_local_ts_' + dataType) || '0', 10);
    return Math.max(synced || 0, edited || 0);
  }

  // ── Startup sync ──────────────────────────────────────────────────────────
  /**
   * On page load: compare local vs cloud timestamps.
   * If cloud is newer → pull and call onNewData(parsedData).
   * If local is newer → push local up to cloud.
   * @param {'progress'|'nutrition'|'workouts'} dataType
   * @param {string} localKey  - localStorage key
   * @param {Function|null} onNewData - called when cloud data replaces local
   */
  async function cloudSync(dataType, localKey, onNewData) {
    const db = client();
    const email = getEmail();
    if (!db || !email) return;
    setIndicator('syncing');
    const localTs = localTsFor(dataType);
    try {
      const { data: row, error } = await db
        .from('devfit_data')
        .select('data, updated_at')
        .eq('email', email)
        .eq('data_type', dataType)
        .maybeSingle();

      if (error) throw error;

      if (!row) {
        // Nothing in cloud yet — push local data up
        const raw = localStorage.getItem(localKey);
        if (raw) {
          try { await cloudSave(dataType, JSON.parse(raw)); } catch (_) {}
        }
        setIndicator('ok');
        return;
      }

      const cloudTs = new Date(row.updated_at).getTime();

      if (cloudTs > localTs + 3000) {
        // Cloud is meaningfully newer — overwrite local cache and notify page
        localStorage.setItem(localKey, JSON.stringify(row.data));
        localStorage.setItem('devfit_cloud_ts_' + dataType, String(cloudTs));
        setIndicator('ok');
        if (typeof onNewData === 'function') onNewData(row.data);
      } else {
        // Local is same or newer — push up
        const raw = localStorage.getItem(localKey);
        if (raw) {
          try { await cloudSave(dataType, JSON.parse(raw)); } catch (_) {}
        }
        setIndicator('ok');
      }
    } catch (e) {
      console.warn('[DevFit Cloud] sync failed (' + dataType + '):', e.message || e);
      setIndicator('err');
    }
  }

  // ── Restore-on-load sync (Settings auto-restore) ─────────────────────────
  /**
   * Reconcile every data type with the cloud, RESPECTING timestamps so it is
   * non-destructive: a cloud copy only overwrites local when it is genuinely
   * newer than the local edit/sync time. If local is newer (a recent edit that
   * hasn't been uploaded yet), local is pushed up instead of being clobbered.
   * This is what prevents the "edit in one page, change a setting elsewhere,
   * come back and the edit is gone" data-loss bug.
   * Returns { ok: boolean, updated: number, reason?: string }
   *   updated = number of local keys actually replaced by a newer cloud copy.
   */
  async function forceSyncAll() {
    const db = client();
    const email = getEmail();
    if (!db || !email) return { ok: false, reason: 'Not connected — check your internet' };
    setIndicator('syncing');
    try {
      const { data: rows, error } = await db
        .from('devfit_data')
        .select('data_type, data, updated_at')
        .eq('email', email);
      if (error) throw error;

      const keyMap = {
        progress:  'progressLog2',
        nutrition: 'devfitNutritionV2',
        workouts:  'devfitTrainingV1'
      };
      let updated = 0;
      (rows || []).forEach(row => {
        const lk = keyMap[row.data_type];
        if (!lk || !row.data) return;
        const cloudTs = new Date(row.updated_at).getTime();
        const localTs = localTsFor(row.data_type);
        if (cloudTs > localTs + 3000) {
          // Cloud is meaningfully newer — safe to adopt it.
          localStorage.setItem(lk, JSON.stringify(row.data));
          localStorage.setItem('devfit_cloud_ts_' + row.data_type, String(cloudTs));
          updated++;
        } else if (localTs > cloudTs) {
          // Local has newer unsynced edits — push them up, don't overwrite.
          const raw = localStorage.getItem(lk);
          if (raw) { try { cloudSave(row.data_type, JSON.parse(raw)); } catch (_) {} }
        }
      });
      setIndicator('ok');
      return { ok: true, updated };
    } catch (e) {
      setIndicator('err');
      return { ok: false, reason: e.message || String(e) };
    }
  }

  // ── Push all local data to cloud (first-time setup) ──────────────────────
  async function pushAllLocal() {
    const types = [
      { type: 'progress',  key: 'progressLog2' },
      { type: 'nutrition', key: 'devfitNutritionV2' },
      { type: 'workouts',  key: 'devfitTrainingV1' }
    ];
    for (const { type, key } of types) {
      const raw = localStorage.getItem(key);
      if (raw) {
        try { await cloudSave(type, JSON.parse(raw)); } catch (_) {}
      }
    }
  }

  // ── Expose public API ─────────────────────────────────────────────────────
  global.DevFitDB = {
    cloudSave,
    cloudSync,
    forceSyncAll,
    pushAllLocal,
    setIndicator
  };

})(window);

/**
 * AudioPlayer - Maneja toda la lógica del reproductor de audio
 * Centralizado para todos los templates
 *
 * Estrategia para interrupciones (llamadas) en iOS/Android:
 * Se mantiene UN ÚNICO elemento <audio> durante toda la sesión (nunca se
 * recrea). iOS/WebKit reanuda el mismo elemento tras la llamada; recrearlo
 * o llamar play() desde eventos que no son un gesto del usuario provoca
 * NotAllowedError y deja el audio muerto. Por eso:
 *   - No se reemplaza nunca el elemento.
 *   - Sólo se llama play() al reanudar si el elemento está pausado.
 *   - Si el navegador rechaza play(), el primer toque/gesto del usuario (o el
 *     botón Play de la pantalla de bloqueo) lo reanuda.
 */
class AudioPlayer {
  constructor(options = {}) {
    this.audioElement = null;
    this.isPlaying = false;
    this.currentVolume = options.defaultVolume || 50;
    this.streamUrl = null;
    this.onPlayCallback = options.onPlay || (() => {});
    this.onPauseCallback = options.onPause || (() => {});
    this.onErrorCallback = options.onError || (() => {});
    this.onVolumeChangeCallback = options.onVolumeChange || (() => {});

    this.audioElementId = options.audioElementId || 'radio-audio';
    this.playButtonId = options.playButtonId || 'play-btn';
    this.volumeSliderId = options.volumeSliderId || 'volume-slider';

    // Estado interno para distinguir pausa del usuario vs. interrupción del sistema
    this.shouldBePlaying = false;
    this.isInterrupted = false;
    this.userPaused = false;
    this.resumeWatchdog = null;
    this.boundResumeIfInterrupted = null;
    this.boundGestureResume = null;
    this.lastResumeAttemptAt = 0;
    this.resumeFailures = 0;
    this.mediaSessionHandlersSet = false;
    // Tras N fallos seguidos el watchdog deja de reintentar solo (evita loops
    // y batería); el primer gesto del usuario vuelve a intentarlo.
    this.maxResumeFailures = options.maxResumeFailures || 6;

    // Detección de iOS (incluye iPads modernos que se reportan como MacIntel)
    const ua = navigator.userAgent || '';
    this.isIOS = /iP(hone|ad|od)/.test(navigator.platform || '') ||
      /iP(hone|ad|od)/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    // Persistimos la intención de reproducir para sobrevivir a una
    // suspensión/recarga de la PWA en iOS (que borra el estado en memoria)
    this.storageKey = options.storageKey || 'radio-player:shouldPlay';
  }

  // Inicializar el reproductor
  init() {
    this.audioElement = document.getElementById(this.audioElementId);
    this.setupEventListeners();
    return this;
  }

  // Configurar event listeners
  setupEventListeners() {
    // Play button
    const playBtn = document.getElementById(this.playButtonId);
    this.playButtonEl = playBtn || null;
    if (playBtn) {
      playBtn.addEventListener('click', () => this.toggle());
    }

    // Volume slider
    const volumeSlider = document.getElementById(this.volumeSliderId);
    this.volumeSliderEl = volumeSlider || null;
    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        this.setVolume(e.target.value);
      });
      volumeSlider.value = this.currentVolume;
    }

    // Audio element events
    if (this.audioElement) {
      this.bindAudioElement(this.audioElement);
    }

    // Al terminar la llamada la app vuelve a primer plano: reanudar.
    this.boundResumeIfInterrupted = () => {
      if (document.hidden) return;
      this.debugLog('visibility/focus visible');
      this.resumeIfInterrupted();
    };
    document.addEventListener('visibilitychange', this.boundResumeIfInterrupted);
    window.addEventListener('focus', this.boundResumeIfInterrupted);
    window.addEventListener('pageshow', this.boundResumeIfInterrupted);
    window.addEventListener('online', this.boundResumeIfInterrupted);
    if ('onresume' in document) {
      document.addEventListener('resume', this.boundResumeIfInterrupted);
    }

    // Reintento en el primer toque (iOS exige gesto). Se EXCLUYEN los controles
    // para no chocar con el manejo play/pause del propio botón.
    this.boundGestureResume = (e) => {
      const t = e ? e.target : null;
      if (t && this.playButtonEl && this.playButtonEl.contains(t)) return;
      if (t && this.volumeSliderEl && this.volumeSliderEl.contains(t)) return;
      this.debugLog('gesture resume');
      this.resumeIfInterrupted();
    };
    document.addEventListener('touchend', this.boundGestureResume, { passive: true });
    document.addEventListener('click', this.boundGestureResume);

    this.setupDebug();
    this.startResumeWatchdog();
    this.setupMediaSession();
  }

  // Vincular los eventos del elemento <audio>
  bindAudioElement(el) {
    el.addEventListener('loadstart', () => {
      this.debugLog('event loadstart');
    });

    el.addEventListener('error', (e) => {
      const code = e && e.target && e.target.error ? e.target.error.code : '?';
      this.debugLog('event error code=' + code);
      console.error('AudioPlayer: Audio error:', e);
      this.handleError(e);
    });

    el.addEventListener('play', () => {
      this.debugLog('event play');
      this.shouldBePlaying = true;
      this.isInterrupted = false;
      this.userPaused = false;
      this.isPlaying = true;
      this.resumeFailures = 0;
      this.savePlayIntent(true);
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
      this.onPlayCallback();
    });

    el.addEventListener('playing', () => {
      this.isPlaying = true;
      this.isInterrupted = false;
      this.resumeFailures = 0;
      this.debugLog('event playing');
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
    });

    // Un pause solo cuenta como acción del usuario si vino de pause().
    // Cualquier otro pause (llamada, Siri, segundo plano, alarma) es una
    // interrupción del sistema que recordamos para reanudar luego.
    el.addEventListener('pause', () => {
      this.debugLog('event pause userPaused=' + this.userPaused);
      this.isPlaying = false;
      if (this.userPaused) {
        this.shouldBePlaying = false;
        this.isInterrupted = false;
        this.savePlayIntent(false);
      } else if (this.shouldBePlaying) {
        this.isInterrupted = true;
        this.savePlayIntent(true);
      }
      this.onPauseCallback();
    });

    el.addEventListener('stalled', () => {
      this.debugLog('event stalled');
    });

    el.addEventListener('ended', () => {
      this.debugLog('event ended');
      if (this.shouldBePlaying) {
        this.isInterrupted = true;
        this.savePlayIntent(true);
      }
    });
  }

  // Reanudar si el sistema interrumpió la reproducción.
  // Sólo reproduce si el elemento está pausado; si ya está sonando, no hace
  // nada (así no interferimos con la reanudación que hace el propio iOS).
  resumeIfInterrupted() {
    const el = this.audioElement;
    if (!el || !this.shouldBePlaying) return;
    if (!el.paused && !el.ended) return;

    this.debugLog('resume paused=' + el.paused + ' ended=' + el.ended +
      ' rs=' + el.readyState);
    this.isInterrupted = false;
    this.lastResumeAttemptAt = Date.now();

    // Stream en vivo terminado/errado: recargar la fuente (sin recrear nodo)
    if (el.ended || el.error || el.networkState === 3) {
      el.src = this.streamUrl;
      try { el.load(); } catch (e) {}
    }

    const promise = el.play();
    if (promise && promise.catch) {
      promise.catch(err => {
        this.debugLog('resume play ERR ' + (err && err.name));
        this.isInterrupted = true;
        this.resumeFailures = (this.resumeFailures || 0) + 1;
      });
    }
  }

  // Vigilante: solo actúa cuando el audio está PAUSADO (interrupción real).
  // No toca streams que están cargando/buffering (el.paused === false).
  startResumeWatchdog() {
    this.stopResumeWatchdog();
    this.resumeWatchdog = setInterval(() => {
      const el = this.audioElement;
      if (!el || document.hidden || !this.shouldBePlaying) return;
      if (!el.paused) return;

      this.isInterrupted = true;
      if ((this.resumeFailures || 0) >= this.maxResumeFailures) return;
      const cooldown = Math.min(60000, 5000 * ((this.resumeFailures || 0) + 1));
      if (Date.now() - this.lastResumeAttemptAt >= cooldown) {
        this.resumeIfInterrupted();
      }
    }, 5000);
  }

  stopResumeWatchdog() {
    if (this.resumeWatchdog) {
      clearInterval(this.resumeWatchdog);
      this.resumeWatchdog = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Diagnóstico en pantalla (solo desarrollo). Se activa/apaga tocando 5 veces
  // el marcador de versión del footer, o con ?debug en la URL. No afecta al audio.
  // ---------------------------------------------------------------------------
  setupDebug() {
    this.debugEnabled = false;
    this.debugLines = [];
    this._debugEl = null;
    try {
      this.debugEnabled = /[?&#]debug/.test(location.href) ||
        localStorage.getItem('audio:debug') === '1';
    } catch (e) {}
    if (this.debugEnabled) this.enableDebugPanel();

    const marker = document.querySelector('.app-version');
    if (marker) {
      let taps = 0, lastTap = 0;
      marker.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastTap > 1500) taps = 0;
        lastTap = now;
        taps++;
        if (taps >= 5) {
          taps = 0;
          const on = !this.debugEnabled;
          this.debugEnabled = on;
          try { localStorage.setItem('audio:debug', on ? '1' : '0'); } catch (e) {}
          if (on) {
            this.enableDebugPanel();
            this.debugLog('debug ON');
          } else {
            this.disableDebugPanel();
          }
        }
      });
    }

    this.debugLog('load #' + this.bumpLoadCount() + ' ios=' + this.isIOS +
      ' visible=' + !document.hidden);
  }

  bumpLoadCount() {
    try {
      const n = parseInt(localStorage.getItem('audio:loads') || '0', 10) + 1;
      localStorage.setItem('audio:loads', String(n));
      return n;
    } catch (e) {
      return -1;
    }
  }

  enableDebugPanel() {
    if (this._debugEl || !document.body) return;
    const pre = document.createElement('pre');
    pre.id = 'audio-debug';
    pre.style.cssText = 'position:fixed;left:0;bottom:0;right:0;max-height:45vh;' +
      'overflow:auto;margin:0;padding:6px 8px;background:rgba(0,0,0,.82);color:#0f0;' +
      'font:10px/1.35 ui-monospace,Menlo,monospace;z-index:2147483647;' +
      'pointer-events:none;white-space:pre-wrap;';
    document.body.appendChild(pre);
    this._debugEl = pre;
    this.renderDebug();
  }

  renderDebug() {
    if (this._debugEl) this._debugEl.textContent = this.debugLines.join('\n');
  }

  disableDebugPanel() {
    if (this._debugEl && this._debugEl.parentNode) {
      this._debugEl.parentNode.removeChild(this._debugEl);
    }
    this._debugEl = null;
    this.debugLines = [];
  }

  debugLog(msg) {
    if (!this.debugEnabled) return;
    try {
      const t = new Date().toLocaleTimeString();
      this.debugLines.push(t + ' ' + msg);
      if (this.debugLines.length > 24) this.debugLines.shift();
      this.renderDebug();
    } catch (e) {}
    console.log('[AudioDebug]', msg);
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Radio en vivo',
          artist: 'Streaming en directo',
          album: ''
        });
      } catch (e) {}

      navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused';

      // Los handlers se registran una sola vez (evita duplicados)
      if (this.mediaSessionHandlersSet) return;
      this.mediaSessionHandlersSet = true;

      const setHandler = (action, handler) => {
        try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) {}
      };

      setHandler('play', () => {
        this.shouldBePlaying = true;
        this.savePlayIntent(true);
        this.resumeIfInterrupted();
      });
      setHandler('pause', () => this.pause());
      setHandler('stop', () => this.pause());
    } catch (e) {
      console.warn('AudioPlayer: MediaSession setup failed:', e);
    }
  }

  // Establecer URL del stream
  setStreamUrl(url) {
    this.streamUrl = url;
    this.setupMediaSession();
    this.debugLog('setStreamUrl ' + url);
    console.log('AudioPlayer: Stream URL set to:', url);

    // Si antes de la suspensión/recarga el usuario estaba escuchando,
    // intentar reanudar apenas haya URL.
    if (this.readPlayIntent()) {
      this.shouldBePlaying = true;
      this.debugLog('intent=playing -> resume en 400ms');
      setTimeout(() => this.resumeIfInterrupted(), 400);
    }
  }

  readPlayIntent() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !data.playing) return false;
      const maxAge = 10 * 60 * 1000;
      return (Date.now() - (data.ts || 0)) <= maxAge;
    } catch (e) {
      return false;
    }
  }

  savePlayIntent(playing) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ playing: !!playing, ts: Date.now() }));
    } catch (e) {}
  }

  // Reproducir
  play() {
    if (!this.audioElement || !this.streamUrl) {
      console.error('AudioPlayer: Cannot play - missing audio element or stream URL');
      return Promise.reject(new Error('Missing audio element or stream URL'));
    }

    this.shouldBePlaying = true;
    this.isInterrupted = false;
    this.userPaused = false;
    this.resumeFailures = 0;
    this.savePlayIntent(true);

    if (!this.audioElement.paused) {
      return Promise.resolve();
    }

    if (this.audioElement.src !== this.streamUrl) {
      this.audioElement.src = this.streamUrl;
    }
    this.audioElement.volume = this.currentVolume / 100;

    return this.audioElement.play()
      .then(() => {
        this.debugLog('play() OK');
        console.log('AudioPlayer: Playing successfully');
        this.isPlaying = true;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        this.onPlayCallback();
      })
      .catch(error => {
        this.debugLog('play() ERR ' + (error && error.name));
        console.error('AudioPlayer: Error playing:', error);
        this.handleError(error);
        throw error;
      });
  }

  // Pausar
  pause() {
    if (!this.audioElement) return;

    this.userPaused = true;
    this.shouldBePlaying = false;
    this.isInterrupted = false;
    this.savePlayIntent(false);
    this.audioElement.pause();
    this.isPlaying = false;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    this.onPauseCallback();
  }

  // Toggle play/pause
  toggle() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  // Ajustar volumen
  setVolume(value) {
    this.currentVolume = value;
    if (this.audioElement) {
      this.audioElement.volume = value / 100;
    }
    this.onVolumeChangeCallback(value);
  }

  // Obtener volumen actual
  getVolume() {
    return this.currentVolume;
  }

  // Verificar si está reproduciendo
  isPlayingNow() {
    return this.isPlaying;
  }

  // Manejar errores
  handleError(error) {
    this.isPlaying = false;
    this.onErrorCallback(error);
  }

  // Destruir el reproductor: solo limpia listeners/timers. NO pausa ni borra
  // el src para no matar el audio en segundo plano (pagehide/background).
  destroy() {
    this.stopResumeWatchdog();

    if (this.boundResumeIfInterrupted) {
      document.removeEventListener('visibilitychange', this.boundResumeIfInterrupted);
      window.removeEventListener('focus', this.boundResumeIfInterrupted);
      window.removeEventListener('pageshow', this.boundResumeIfInterrupted);
      window.removeEventListener('online', this.boundResumeIfInterrupted);
      if ('onresume' in document) {
        document.removeEventListener('resume', this.boundResumeIfInterrupted);
      }
      this.boundResumeIfInterrupted = null;
    }

    if (this.boundGestureResume) {
      document.removeEventListener('touchend', this.boundGestureResume);
      document.removeEventListener('click', this.boundGestureResume);
      this.boundGestureResume = null;
    }
  }
}

export default AudioPlayer;

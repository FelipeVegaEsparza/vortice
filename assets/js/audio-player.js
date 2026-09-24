/**
 * AudioPlayer - Maneja toda la lógica del reproductor de audio
 * Centralizado para todos los templates
 *
 * Nota importante sobre iOS:
 * Cuando entra/sale una llamada, iOS pausa el <audio> y la sesión de audio
 * queda inactiva. En muchos casos play() se resuelve pero el audio queda en
 * SILENCIO. La forma fiable de recuperarlo es reemplazar el elemento <audio>
 * por uno nuevo (sesión de audio nueva). Lo hacemos automáticamente cuando la
 * llamada termina y la app vuelve a primer plano (visibilitychange/focus/
 * pageshow) y también desde el watchdog si el sistema no dispara esos eventos.
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
    this.lastRecreateAt = 0;
    this.resumeFailures = 0;
    this.lastResumeAttemptAt = 0;
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
      // Set initial volume
      volumeSlider.value = this.currentVolume;
    }

    // Audio element events
    if (this.audioElement) {
      this.bindAudioElement(this.audioElement);
    }

    // Al terminar la llamada la app vuelve a primer plano: reconectar.
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

  // (Re)vincular los eventos del elemento <audio>. Necesario porque podemos
  // reemplazar el elemento por uno nuevo cuando iOS deja la sesión inactiva.
  bindAudioElement(el) {
    const isCurrent = () => el === this.audioElement;

    el.addEventListener('loadstart', () => {
      if (!isCurrent()) return;
      console.log('AudioPlayer: Loading started');
    });

    el.addEventListener('canplay', () => {
      if (!isCurrent()) return;
      console.log('AudioPlayer: Can play');
    });

    el.addEventListener('error', (e) => {
      if (!isCurrent()) return;
      const code = e && e.target && e.target.error ? e.target.error.code : '?';
      this.debugLog('event error code=' + code);
      console.error('AudioPlayer: Audio error:', e);
      this.handleError(e);
    });

    el.addEventListener('play', () => {
      if (!isCurrent()) return;
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

    // Confirma que la reproducción realmente comenzó (verificación tras un
    // play() que puede resolverse sin sonar en iOS)
    el.addEventListener('playing', () => {
      if (!isCurrent()) return;
      this.isPlaying = true;
      this.isInterrupted = false;
      this.resumeFailures = 0;
      this.debugLog('event playing');
      console.log('AudioPlayer: reproducción en curso');
    });

    // Un pause solo cuenta como acción del usuario si vino de pause().
    // Cualquier otro pause (llamada, Siri, segundo plano, alarma) es una
    // interrupción del sistema que debemos reconectar luego.
    el.addEventListener('pause', () => {
      if (!isCurrent()) return;
      this.debugLog('event pause userPaused=' + this.userPaused);
      this.isPlaying = false;
      if (this.userPaused) {
        this.shouldBePlaying = false;
        this.isInterrupted = false;
        this.savePlayIntent(false);
      } else if (this.shouldBePlaying) {
        this.isInterrupted = true;
        this.savePlayIntent(true);
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
        }
      }
      this.onPauseCallback();
    });

    el.addEventListener('stalled', () => {
      if (!isCurrent()) return;
      console.warn('AudioPlayer: Stream stalled, will retry on resume');
    });

    el.addEventListener('ended', () => {
      if (!isCurrent()) return;
      // Un stream en vivo no debería terminar; si pasa, marcamos para que el
      // watchdog/visibility reconecten con backoff y tope (sin loops).
      if (this.shouldBePlaying) {
        this.isInterrupted = true;
        this.savePlayIntent(true);
        console.log('AudioPlayer: stream finalizó, se reconectará');
      }
    });
  }

  // Reconectar automáticamente si el sistema interrumpió la reproducción.
  resumeIfInterrupted() {
    const el = this.audioElement;
    if (!el || !this.shouldBePlaying) return;
    if (!el.paused && !el.ended && !this.isInterrupted) return;

    this.debugLog('resume paused=' + el.paused + ' ended=' + el.ended +
      ' interrupted=' + this.isInterrupted + ' rs=' + el.readyState);
    this.isInterrupted = false;
    this.lastResumeAttemptAt = Date.now();
    console.log('AudioPlayer: Reanudando tras interrupción');

    // Reemplazamos el elemento (sesión de audio nueva) y reconectamos.
    // Es la forma fiable de recuperar el sonido tras una llamada en iOS.
    this.recreateAudioElement();
  }

  // Reemplaza el elemento <audio> por uno nuevo y reproduce el stream en vivo.
  recreateAudioElement() {
    // Salvaguarda: nunca crear/reproducir si no corresponde seguir sonando.
    if (!this.shouldBePlaying) return;

    const now = Date.now();
    if (now - this.lastRecreateAt < 1000) return; // evita recreaciones dobles
    this.lastRecreateAt = now;

    const old = this.audioElement;
    if (!old) return;

    this.debugLog('recreate element');
    // Copiamos TODOS los atributos del elemento anterior (id, preload,
    // playsinline, crossorigin, etc.) para no alterar su configuración.
    const el = document.createElement('audio');
    Array.from(old.attributes).forEach(attr => {
      if (attr.name === 'src') return;
      el.setAttribute(attr.name, attr.value);
    });
    el.volume = this.currentVolume / 100;

    // Asignamos el nuevo como actual ANTES de tocar el viejo, para que los
    // eventos del elemento viejo (pause/error) se ignoren vía isCurrent().
    this.audioElement = el;

    // Cerrar conexión y eventos del elemento anterior (evita un segundo
    // stream duplicado).
    try {
      old.pause();
      old.removeAttribute('src');
      old.load();
    } catch (e) {}

    if (old.parentNode) {
      old.parentNode.replaceChild(el, old);
    } else if (document.body) {
      document.body.appendChild(el);
    }

    this.bindAudioElement(el);
    console.log('AudioPlayer: elemento <audio> recreado');
    this.playFresh(el);
  }

  // Cargar y reproducir el stream con la MISMA URL (el elemento nuevo ya
  // fuerza una conexión nueva; no alteramos la URL original).
  playFresh(el) {
    if (!this.streamUrl) return;
    this.debugLog('playFresh should=' + this.shouldBePlaying);
    el.src = this.streamUrl;
    try { el.load(); } catch (e) {}

    if (!this.shouldBePlaying) return;
    const promise = el.play();
    if (promise && promise.catch) {
      promise.catch(err => {
        this.debugLog('playFresh ERR ' + (err && err.name));
        console.warn('AudioPlayer: play() tras recrear falló, se reintentará:', err);
        this.isInterrupted = true;
        this.resumeFailures = (this.resumeFailures || 0) + 1;
      });
    }
  }

  // Alias de compatibilidad
  reconnectStream() {
    this.recreateAudioElement();
  }

  // Vigilante: solo actúa cuando el audio está PAUSADO (interrupción real).
  // No toca streams que están cargando/buffering (el.paused === false), así no
  // genera reconexiones innecesarias en condiciones normales.
  startResumeWatchdog() {
    this.stopResumeWatchdog();
    this.resumeWatchdog = setInterval(() => {
      const el = this.audioElement;
      if (!el || document.hidden || !this.shouldBePlaying) return;
      if (!el.paused) return;

      this.isInterrupted = true;
      // Tope de reintentos + backoff: evita loops y consumo innecesario.
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
  // Diagnóstico en pantalla (solo desarrollo). Se activa tocando 5 veces el
  // marcador de versión del footer, o con ?debug en la URL. No afecta al audio.
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

    // Trigger oculto: 5 toques rápidos en el marcador .app-version
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
          try { localStorage.setItem('audio:debug', '1'); } catch (e) {}
          this.debugEnabled = true;
          this.enableDebugPanel();
          this.debugLog('debug ON');
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
      // Mantener metadata + estado vivos permite que la pantalla de bloqueo
      // siga mostrando los controles durante la llamada. Al pulsar play ahí
      // (cuando la app está en segundo plano) reconectamos el audio.
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
        if (this.isInterrupted || (this.audioElement && this.audioElement.paused)) {
          this.recreateAudioElement();
        } else {
          this.play();
        }
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
    // reanudar apenas haya URL.
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
      // Solo reanudar si la escucha fue reciente (cubre el caso de una
      // llamada o suspensión, sin auto-reproducir días después).
      const maxAge = 10 * 60 * 1000;
      return (Date.now() - (data.ts || 0)) <= maxAge;
    } catch (e) {
      return false;
    }
  }

  savePlayIntent(playing) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ playing: !!playing, ts: Date.now() }));
    } catch (e) {
      // localStorage puede fallar en modo privado
    }
  }

  // Reproducir
  play() {
    if (!this.audioElement || !this.streamUrl) {
      console.error('AudioPlayer: Cannot play - missing audio element or stream URL');
      return Promise.reject(new Error('Missing audio element or stream URL'));
    }

    // Si venimos de una interrupción, recreamos el elemento para asegurar
    // una sesión de audio nueva (evita el estado silencioso en iOS).
    const needsReengage = this.isInterrupted;

    this.shouldBePlaying = true;
    this.isInterrupted = false;
    this.userPaused = false;
    this.resumeFailures = 0;
    this.savePlayIntent(true);

    if (needsReengage) {
      this.recreateAudioElement();
      return Promise.resolve();
    }

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
    // Tras una interrupción del sistema, el primer toque en Play debe
    // REENGGANCHAR (recrear el elemento) en lugar de alternar a pausa.
    if (this.isInterrupted) {
      this.shouldBePlaying = true;
      this.savePlayIntent(true);
      this.debugLog('toggle -> reengage');
      this.recreateAudioElement();
      return;
    }
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

  // Destruir el reproductor
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

    // Pausar sin borrar la intención de reproducir: si iOS recarga la PWA
    // tras la interrupción, queremos poder reanudar.
    if (this.audioElement) {
      try { this.audioElement.pause(); } catch (e) {}
      this.audioElement.src = '';
    }
  }
}

export default AudioPlayer;

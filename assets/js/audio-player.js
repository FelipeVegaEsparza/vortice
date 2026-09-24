/**
 * AudioPlayer - Maneja toda la lógica del reproductor de audio
 * Centralizado para todos los templates
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
    this.resumeOverlay = null;

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
    if (playBtn) {
      playBtn.addEventListener('click', () => this.toggle());
    }

    // Volume slider
    const volumeSlider = document.getElementById(this.volumeSliderId);
    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        this.setVolume(e.target.value);
      });
      // Set initial volume
      volumeSlider.value = this.currentVolume;
    }

    // Audio element events
    if (this.audioElement) {
      this.audioElement.addEventListener('loadstart', () => {
        console.log('AudioPlayer: Loading started');
      });

      this.audioElement.addEventListener('canplay', () => {
        console.log('AudioPlayer: Can play');
      });

      this.audioElement.addEventListener('error', (e) => {
        console.error('AudioPlayer: Audio error:', e);
        this.handleError(e);
      });

      this.audioElement.addEventListener('play', () => {
        this.shouldBePlaying = true;
        this.isInterrupted = false;
        this.userPaused = false;
        this.isPlaying = true;
        this.savePlayIntent(true);
        this.hideResumeOverlay();
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        this.onPlayCallback();
      });

      // Un pause solo cuenta como acción del usuario si vino de pause().
      // Cualquier otro pause (llamada, Siri, segundo plano, alarma) es una
      // interrupción del sistema que debemos recordar para reanudar luego.
      this.audioElement.addEventListener('pause', () => {
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

      this.audioElement.addEventListener('stalled', () => {
        console.warn('AudioPlayer: Stream stalled, will retry on resume');
      });

      this.audioElement.addEventListener('ended', () => {
        if (this.shouldBePlaying) {
          this.isInterrupted = true;
          this.resumeIfInterrupted();
        }
      });
    }

    this.boundResumeIfInterrupted = () => this.resumeIfInterrupted();
    document.addEventListener('visibilitychange', this.boundResumeIfInterrupted);
    window.addEventListener('focus', this.boundResumeIfInterrupted);
    window.addEventListener('pageshow', this.boundResumeIfInterrupted);
    window.addEventListener('online', this.boundResumeIfInterrupted);
    if ('onresume' in document) {
      document.addEventListener('resume', this.boundResumeIfInterrupted);
    }

    // iOS puede bloquear play() programático al volver de una llamada.
    // Reintentamos en el primer toque/clic del usuario.
    this.boundGestureResume = () => this.resumeIfInterrupted();
    document.addEventListener('touchend', this.boundGestureResume, { passive: true });
    document.addEventListener('click', this.boundGestureResume);

    this.startResumeWatchdog();
    this.setupMediaSession();
  }

  // Reanudar si el sistema interrumpió la reproducción
  resumeIfInterrupted() {
    const el = this.audioElement;
    if (!el || !this.shouldBePlaying) return;
    if (!el.paused && !el.ended && !this.isInterrupted) return;

    const wasInterrupted = this.isInterrupted;
    this.isInterrupted = false;
    console.log('AudioPlayer: Reanudando tras interrupción');

    // Sin fuente cargada (p.ej. tras recargar la PWA en iOS) hay que reconectar.
    if (this.streamUrl && el.src !== this.streamUrl) {
      this.reconnectStream();
      return;
    }

    // Una radio en vivo no tiene posición que conservar: ante una interrupción
    // real (llamada, Siri, suspensión) reconectamos el stream desde cero.
    // Es la forma fiable de no quedar con un stream "vivo" pero en silencio.
    if (wasInterrupted || el.ended || el.error || el.networkState === 3) {
      this.reconnectStream();
      return;
    }

    const promise = el.play();
    if (promise && promise.catch) {
      promise.catch(err => {
        console.warn('AudioPlayer: No se pudo reanudar, se mostrará botón:', err);
        this.isInterrupted = true;
        this.showResumeOverlay();
      });
    }
  }

  // Reconectar el stream en vivo (iOS puede dejarlo mudo tras una llamada)
  reconnectStream() {
    const el = this.audioElement;
    if (!el || !this.streamUrl) return;
    try {
      this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
      // A partir del segundo intento forzamos una URL distinta para saltar
      // conexiones/caché que iOS conserva tras la interrupción.
      let url = this.streamUrl;
      if (this.reconnectAttempts > 1) {
        url += (url.includes('?') ? '&' : '?') + '_=' + Date.now();
      }
      el.src = url;
      el.load();
      if (this.shouldBePlaying) {
        const promise = el.play();
        if (promise && promise.catch) {
          promise.catch(err => {
            console.warn('AudioPlayer: Reintento de reconexión falló:', err);
            this.isInterrupted = true;
            this.showResumeOverlay();
          });
        }
      }
    } catch (e) {
      console.warn('AudioPlayer: Reconexión falló:', e);
      this.showResumeOverlay();
    }
  }

  // Botón visible de respaldo: iOS puede bloquear play() sin gesto tras una
  // llamada. Un toque del usuario siempre lo desbloquea.
  showResumeOverlay() {
    if (this.resumeOverlay || !document.body) return;
    try {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'audio-resume-overlay';
      btn.textContent = '▶ Toca para reanudar la radio';
      btn.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);' +
        'z-index:2147483647;padding:12px 20px;border:0;border-radius:999px;' +
        'background:#e11d48;color:#fff;font-size:15px;font-weight:600;cursor:pointer;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.35);';
      btn.addEventListener('click', () => {
        this.hideResumeOverlay();
        this.reconnectAttempts = 0;
        this.shouldBePlaying = true;
        this.savePlayIntent(true);
        this.reconnectStream();
      });
      document.body.appendChild(btn);
      this.resumeOverlay = btn;
    } catch (e) {
      console.warn('AudioPlayer: No se pudo crear overlay:', e);
    }
  }

  hideResumeOverlay() {
    if (this.resumeOverlay && this.resumeOverlay.parentNode) {
      this.resumeOverlay.parentNode.removeChild(this.resumeOverlay);
    }
    this.resumeOverlay = null;
  }

  // Vigilante: si la página está visible y debería sonar pero el audio está
  // pausado o congelado (iOS no siempre dispara visibilitychange/focus),
  // reanudar/reconectar.
  startResumeWatchdog() {
    this.stopResumeWatchdog();
    let lastTime = -1;
    let stalledChecks = 0;
    this.resumeWatchdog = setInterval(() => {
      const el = this.audioElement;
      if (!el || document.hidden || !this.shouldBePlaying) {
        lastTime = -1;
        stalledChecks = 0;
        return;
      }
      if (el.paused) {
        stalledChecks = 0;
        this.isInterrupted = true;
        this.resumeIfInterrupted();
        return;
      }
      // Reproducción "fantasma": el elemento dice estar sonando pero el
      // tiempo no avanza (stream muerto). Reintentar la conexión.
      if (el.currentTime === lastTime) {
        stalledChecks++;
        if (stalledChecks >= 2) {
          stalledChecks = 0;
          console.warn('AudioPlayer: reproducción congelada, reconectando');
          this.reconnectStream();
        }
      } else {
        stalledChecks = 0;
      }
      lastTime = el.currentTime;
    }, 5000);
  }

  stopResumeWatchdog() {
    if (this.resumeWatchdog) {
      clearInterval(this.resumeWatchdog);
      this.resumeWatchdog = null;
    }
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Radio en vivo',
        artist: 'Streaming en directo',
        album: ''
      });
      navigator.mediaSession.setActionHandler('play',  () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
    } catch (e) {
      console.warn('AudioPlayer: MediaSession setup failed:', e);
    }
  }

  // Establecer URL del stream
  setStreamUrl(url) {
    this.streamUrl = url;
    this.setupMediaSession();
    console.log('AudioPlayer: Stream URL set to:', url);

    // Si antes de la suspensión/recarga el usuario estaba escuchando,
    // intentar reanudar apenas haya URL (si iOS lo bloquea, se mostrará
    // el botón "Toca para reanudar").
    if (this.readPlayIntent()) {
      this.shouldBePlaying = true;
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

    if (this.shouldBePlaying && !this.audioElement.paused) {
      return Promise.resolve();
    }

    if (this.audioElement.src !== this.streamUrl) {
      this.audioElement.src = this.streamUrl;
    }
    this.audioElement.volume = this.currentVolume / 100;
    this.shouldBePlaying = true;
    this.isInterrupted = false;
    this.userPaused = false;
    this.reconnectAttempts = 0;
    this.savePlayIntent(true);

    return this.audioElement.play()
      .then(() => {
        console.log('AudioPlayer: Playing successfully');
        this.isPlaying = true;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        this.onPlayCallback();
      })
      .catch(error => {
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
    this.hideResumeOverlay();
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

  // Destruir el reproductor
  destroy() {
    this.stopResumeWatchdog();
    this.hideResumeOverlay();

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
